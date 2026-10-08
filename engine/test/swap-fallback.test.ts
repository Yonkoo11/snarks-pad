// The shielded leg after a swap that will not deliver, through the real runEpoch and the real local validator (audit S6, product
// decision 2): a swap refused before any deposit ("failed_before_funds_moved") or refunded after one ("returned_to_keeper") carries
// the holder's share to the next shielded round and pays NOTHING on the public rail; a pending swap pays nothing either; a resume
// never pays or carries twice. Before this decision the holder was paid Solana ZEC here, which ZIP 315 calls spending transparently
// without consent.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { config } from "../src/config";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import type { SwapAdapter, SwapSettlement } from "../src/swap/types";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const MINT = config.solana.dbc.quoteMint;
const SHARE = 1_000_000n;
const noClaims = async () => {};

async function zecOf(owner: Keypair): Promise<bigint> {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(MINT, owner.publicKey, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

/** One epoch with one opted-in holder owed SHARE through the shielded leg; every other unsent payout in the shared test DB is set aside first. */
async function epochWithOneShieldedHolder(): Promise<{ id: string; holder: Keypair }> {
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  const k = loadKeeperKeypair();
  await mintTo(getConnection(), k, MINT, getAssociatedTokenAddressSync(MINT, k.publicKey, false, TOKEN_PROGRAM_ID), k, SHARE);
  const holder = Keypair.generate();
  const id = `epoch-fallback-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: SHARE.toString(), feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
  db.planPayout({ epochId: id, wallet: holder.publicKey.toBase58(), kind: "shielded", amountZats: SHARE.toString(), zcashAddress: "uregtest1holder" });
  return { id, holder };
}

function swapReporting(submit: () => Promise<{ ref: string }>, status: SwapSettlement): SwapAdapter & { submits: number } {
  const swap = {
    provider: "near-1click" as const,
    submits: 0,
    quote: async () => ({ outZats: SHARE }),
    submit: async () => {
      swap.submits++;
      return submit();
    },
    status: async () => status,
  };
  return swap;
}

describe.if(await validatorUp())("the Solana fallback (real runEpoch, real chain)", () => {
  test("a swap that is still pending pays nothing on Solana, run after run", async () => {
    const { id, holder } = await epochWithOneShieldedHolder();
    const swap = swapReporting(async () => ({ ref: id }), { status: "pending", note: "waiting" });
    await runEpoch(swap, noClaims);
    await runEpoch(swap, noClaims);
    expect(db.getEpoch(id)).toMatchObject({ swapState: "submitted", status: "partial" });
    expect(await zecOf(holder)).toBe(0n);
    expect(swap.submits).toBe(1);
  });

  test("a swap that came back 'returned' (refund seen on chain) carries the holder's share once; nothing is paid on Solana", async () => {
    const { id, holder } = await epochWithOneShieldedHolder();
    const wallet = holder.publicKey.toBase58();
    const swap = swapReporting(async () => ({ ref: id }), { status: "returned" });
    await runEpoch(swap, noClaims);
    expect(db.getEpoch(id)).toMatchObject({ swapState: "returned_to_keeper", status: "ok" });
    expect(await zecOf(holder)).toBe(0n);
    expect(db.getCarry(wallet, "shielded")).toBe(SHARE);
    expect(db.getPayouts(id).map((p) => p.sig)).toEqual(["carried:swap_returned"]);
    await runEpoch(swap, noClaims);
    await runEpoch(swap, noClaims);
    expect(await zecOf(holder)).toBe(0n); // a resume never pays it
    expect(db.getCarry(wallet, "shielded")).toBe(SHARE); // nor carries it twice
    expect(swap.submits).toBe(1);
    expect(db.listOpenAlerts().some((a) => a.kind === "swap_refused" && a.epochId === id)).toBe(true);
  });

  test("a submit() rejected before any deposit was signed carries the share once; nothing is paid on Solana", async () => {
    const { id, holder } = await epochWithOneShieldedHolder();
    const wallet = holder.publicKey.toBase58();
    const swap = swapReporting(() => Promise.reject(new Error("keeper balance too low")), { status: "pending" });
    await runEpoch(swap, noClaims);
    expect(db.getEpoch(id)).toMatchObject({ swapState: "failed_before_funds_moved", status: "ok" });
    expect(await zecOf(holder)).toBe(0n);
    expect(db.getCarry(wallet, "shielded")).toBe(SHARE);
    await runEpoch(swap, noClaims);
    expect(await zecOf(holder)).toBe(0n);
    expect(db.getCarry(wallet, "shielded")).toBe(SHARE);
    expect(swap.submits).toBe(1);
  });
});
