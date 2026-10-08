// Live proof of the fixed defects (review findings 1 and 3), against the real
// local solana-test-validator (guarded: skipped if it isn't reachable). Real
// signing, real broadcast, real on-chain balances -- not a mock.
//
// Finding 1: a batch's signature must be persisted BEFORE it is broadcast, so
// a crash between "signed" and "confirmed" resumes by checking that exact
// signature's chain status instead of blindly resending.
// Finding 3: an off-curve (PDA) recipient must not crash the whole batch.
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { config } from "../src/config";
import { getConnection, isSignatureLanded } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { sendSolanaZecPayouts } from "../src/epoch/solanaPayout";
import * as db from "../src/db";

async function checkReachable(): Promise<boolean> {
  try {
    const res = await fetch(config.solana.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const HAS_VALIDATOR = config.isLocal && (await checkReachable());

async function fundKeeper(amountZats: bigint): Promise<void> {
  const conn = getConnection();
  const keeper = loadKeeperKeypair();
  const quoteMint = config.solana.dbc.quoteMint;
  const ata = getAssociatedTokenAddressSync(quoteMint, keeper.publicKey, false, TOKEN_PROGRAM_ID);
  await mintTo(conn, keeper, quoteMint, ata, keeper, amountZats);
}

async function quoteBalance(owner: PublicKey): Promise<bigint> {
  const conn = getConnection();
  const quoteMint = config.solana.dbc.quoteMint;
  const ata = getAssociatedTokenAddressSync(quoteMint, owner, true, TOKEN_PROGRAM_ID);
  try {
    return (await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

describe.if(HAS_VALIDATOR)("sendSolanaZecPayouts against the real local validator (finding 1)", () => {
  test("crash simulated right after signing (before broadcast): the signature is already durably pending, chain confirms it never landed, and resume clears it for a fresh attempt that actually pays", async () => {
    await fundKeeper(10_000n);
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    for (const r of recipients) db.planPayout({ epochId, wallet: r.toBase58(), kind: "solana", amountZats: "1000" });

    let capturedSig = "";
    const shares = recipients.map((r) => ({ wallet: r.toBase58(), amount: 1000n }));

    await expect(
      sendSolanaZecPayouts(shares, {
        onPending: (wallets, sig) => {
          capturedSig = sig;
          for (const w of wallets) db.markPayoutPending(epochId, w, "solana", sig);
          throw new Error("simulated crash: process dies right after signing, before the batch is ever sent");
        },
        onSent: () => {
          throw new Error("must never be reached: onPending already threw");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    // The signature is durably recorded even though broadcast never happened.
    const pending = db.getPendingPayouts(epochId, "solana");
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.sig === capturedSig)).toBe(true);

    // Real chain check: it genuinely never landed (this is what the OLD code
    // could never tell you, because it never recorded a signature at all
    // until every batch in the whole epoch had already been confirmed).
    expect(await isSignatureLanded(capturedSig)).toBe(false);

    // Resume: not landed -> clear it, replan as fresh, retry for real.
    for (const r of recipients) db.clearPendingPayoutSig(epochId, r.toBase58(), "solana");
    expect(db.getFreshUnsentPayouts(epochId, "solana")).toHaveLength(2);

    const before = await Promise.all(recipients.map(quoteBalance));
    let realSig = "";
    const result = await sendSolanaZecPayouts(shares, {
      onPending: (wallets, sig) => {
        realSig = sig;
        for (const w of wallets) db.markPayoutPending(epochId, w, "solana", sig);
      },
      onSent: (wallets, sig) => {
        for (const w of wallets) db.markPayoutSent(epochId, w, "solana", sig);
      },
    });

    expect(result.skipped).toEqual([]);
    // realSig may coincidentally equal capturedSig (ed25519 signing is
    // deterministic: if the validator's "latest blockhash" hasn't advanced
    // between attempts, resigning the identical instructions reproduces the
    // identical signature) -- that's fine and safe, never a double-spend,
    // since Solana dedups by signature and the first attempt never broadcast
    // at all. What matters is that it now actually lands.
    expect(await isSignatureLanded(realSig)).toBe(true);
    expect(db.getUnsentPayouts(epochId, "solana")).toHaveLength(0);

    const after = await Promise.all(recipients.map(quoteBalance));
    for (let i = 0; i < recipients.length; i++) expect(after[i]! - before[i]!).toBe(1000n); // real money actually moved, exactly once
  }, 30_000);

  test("an off-curve (PDA) recipient mixed into a batch is paid for real, and never halts the rest of the batch (finding 3)", async () => {
    await fundKeeper(10_000n);
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    const normalRecipient = Keypair.generate().publicKey;
    const [pdaRecipient] = PublicKey.findProgramAddressSync([Buffer.from("payout-live-test")], new PublicKey("11111111111111111111111111111111"));
    expect(PublicKey.isOnCurve(pdaRecipient.toBytes())).toBe(false);

    const shares = [
      { wallet: normalRecipient.toBase58(), amount: 500n },
      { wallet: pdaRecipient.toBase58(), amount: 700n },
    ];
    const before = await Promise.all([normalRecipient, pdaRecipient].map(quoteBalance));

    const result = await sendSolanaZecPayouts(shares, {
      onPending: (wallets, sig) => {
        for (const w of wallets) db.markPayoutPending(epochId, w, "solana", sig);
      },
      onSent: (wallets, sig) => {
        for (const w of wallets) db.markPayoutSent(epochId, w, "solana", sig);
      },
    });

    expect(result.skipped).toEqual([]); // the PDA never gets diverted to carry just for being off-curve
    const after = await Promise.all([normalRecipient, pdaRecipient].map(quoteBalance));
    expect(after[0]! - before[0]!).toBe(500n);
    expect(after[1]! - before[1]!).toBe(700n); // the PDA really received its share
  }, 30_000);
});
