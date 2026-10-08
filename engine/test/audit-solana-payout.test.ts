// Audit S2 PoCs on the Solana payout leg, through the real runEpoch and the real
// local validator (skipped without one). Each test reproduces an attack or a
// fault from audit/S2-FINDINGS.md and asserts the money outcome on chain.
//   S2-01  resume re-signs a batch that is still in flight -> paid twice
//   S2-02  a second run takes over a "stale" lock while the first still sends -> paid twice
//   S2-03  one holder reassigns its ZEC account's owner -> every payout halts for good
//   S2-04  a holder closes the account the keeper paid rent for -> keeper pays rent again
import { afterEach, describe, expect, test } from "bun:test";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  AuthorityType, TOKEN_PROGRAM_ID, closeAccount, createAssociatedTokenAccount, getAccount, getAssociatedTokenAddressSync, mintTo, setAuthority, transfer,
} from "@solana/spl-token";
import { config } from "../src/config";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import type { SwapAdapter } from "../src/swap/types";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const MINT = config.solana.dbc.quoteMint;
const SHARE = 50_000n; // over newAccountMinZats (30,000): a new account is created for it
const noClaims = async () => {};
const noSwap: SwapAdapter = {
  provider: "simulated",
  quote: async () => ({ outZats: 0n }),
  submit: async () => {
    throw new Error("no shielded leg in these tests");
  },
  status: async () => ({ status: "pending" }),
};

const conn = getConnection();
const realSend = conn.sendRawTransaction.bind(conn);
const realStale = config.epoch.lockStaleMs;
afterEach(() => {
  conn.sendRawTransaction = realSend;
  (config.epoch as { lockStaleMs: number }).lockStaleMs = realStale;
});

const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM_ID);

async function zecOf(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(conn, ataOf(owner), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function fundKeeper(zats: bigint): Promise<void> {
  const k = loadKeeperKeypair();
  await mintTo(conn, k, MINT, ataOf(k.publicKey), k, zats);
}

async function airdrop(to: PublicKey): Promise<void> {
  await conn.confirmTransaction(await conn.requestAirdrop(to, LAMPORTS_PER_SOL), "confirmed");
}

/** A fresh "ok" epoch owing SHARE to each wallet on the Solana rail; every other unfinished epoch in the shared test DB is set aside. */
function epochPaying(wallets: PublicKey[]): string {
  db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("DELETE FROM carry").run();
  const id = `epoch-audit-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
  for (const w of wallets) db.planPayout({ epochId: id, wallet: w.toBase58(), kind: "solana", amountZats: SHARE.toString() });
  return id;
}

describe.if(await validatorUp())("audit S2: Solana payout leg (real runEpoch, real chain)", () => {
  test("S2-01: a batch whose broadcast outcome is unknown is never re-signed while it can still land", async () => {
    await fundKeeper(4n * SHARE);
    const holder = Keypair.generate().publicKey;
    epochPaying([holder]);

    // The RPC takes the batch but the answer is lost (timeout, dropped socket):
    // the transaction is in flight, the keeper only sees an error.
    let inFlight: Uint8Array | null = null;
    conn.sendRawTransaction = (async (raw: Uint8Array) => {
      inFlight = Uint8Array.from(raw);
      throw new Error("socket hang up");
    }) as typeof conn.sendRawTransaction;
    await expect(runEpoch(noSwap, noClaims)).rejects.toThrow();
    conn.sendRawTransaction = realSend;
    expect(inFlight).not.toBeNull();

    await Bun.sleep(1_200); // a newer blockhash: a re-signed batch gets a different signature
    await runEpoch(noSwap, noClaims); // the operator re-runs after the error

    // ...and the first transaction, still valid, reaches the leader.
    await realSend(inFlight!, { skipPreflight: true }).catch(() => {});
    await Bun.sleep(2_000);
    expect(await zecOf(holder)).toBe(SHARE);
  }, 60_000);

  test("S2-02: a run that lost the lock to a stale takeover stops before it sends anything more", async () => {
    await fundKeeper(20n * SHARE);
    const holders = Array.from({ length: 9 }, () => Keypair.generate().publicKey); // two batches: 8 + 1
    epochPaying(holders);
    (config.epoch as { lockStaleMs: number }).lockStaleMs = 1_000;

    // Run A's first broadcast stalls (slow RPC) past the stale-lock age.
    let first = true;
    conn.sendRawTransaction = (async (raw: Uint8Array, opts?: object) => {
      if (first) {
        first = false;
        await Bun.sleep(2_500);
      }
      return realSend(raw, opts);
    }) as typeof conn.sendRawTransaction;

    const runA = runEpoch(noSwap, noClaims).catch((e: Error) => e);
    await Bun.sleep(1_300);
    await runEpoch(noSwap, noClaims); // run B (cron) takes the stale lock over
    await runA;
    await Bun.sleep(2_000);
    const paid = await Promise.all(holders.map(zecOf));
    expect(paid).toEqual(holders.map(() => SHARE));
  }, 90_000);

  test("S2-03: a holder that reassigns its ZEC account's owner is carried; everyone else in its batch is paid, and the epoch completes", async () => {
    await fundKeeper(4n * SHARE);
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey);
    await createAssociatedTokenAccount(conn, attacker, MINT, attacker.publicKey, undefined, TOKEN_PROGRAM_ID);
    await setAuthority(conn, attacker, ataOf(attacker.publicKey), attacker, AuthorityType.AccountOwner, Keypair.generate().publicKey, [], undefined, TOKEN_PROGRAM_ID);
    const honest = Keypair.generate().publicKey;
    const id = epochPaying([attacker.publicKey, honest]);

    await runEpoch(noSwap, noClaims);
    expect(await zecOf(honest)).toBe(SHARE);
    expect(db.getUnsentPayouts(id, "solana")).toHaveLength(0);
    const row = db.getPayouts(id).find((p) => p.wallet === attacker.publicKey.toBase58())!;
    expect(row.sig).toStartWith("carried:");
    expect(db.getCarry(attacker.publicKey.toBase58(), "solana")).toBe(SHARE);
  }, 60_000);

  test("S2-04: a holder that closes the account the keeper paid rent for is not given a second one", async () => {
    await fundKeeper(4n * SHARE);
    const holder = Keypair.generate();
    await airdrop(holder.publicKey);
    epochPaying([holder.publicKey]);
    await runEpoch(noSwap, noClaims);
    expect(await zecOf(holder.publicKey)).toBe(SHARE);

    // Move the ZEC out, close the account, keep the keeper's rent.
    const elsewhere = Keypair.generate().publicKey;
    const sink = await createAssociatedTokenAccount(conn, holder, MINT, elsewhere, undefined, TOKEN_PROGRAM_ID);
    await transfer(conn, holder, ataOf(holder.publicKey), sink, holder, SHARE, [], undefined, TOKEN_PROGRAM_ID);
    await closeAccount(conn, holder, ataOf(holder.publicKey), holder.publicKey, holder, [], undefined, TOKEN_PROGRAM_ID);

    const id = epochPaying([holder.publicKey]);
    await runEpoch(noSwap, noClaims);
    expect(await conn.getAccountInfo(ataOf(holder.publicKey), "confirmed")).toBeNull(); // the keeper did not pay rent again
    expect(db.getPayouts(id)[0]!.sig).toStartWith("carried:");
    expect(db.getCarry(holder.publicKey.toBase58(), "solana")).toBe(SHARE); // still owed, not lost
  }, 60_000);
});
