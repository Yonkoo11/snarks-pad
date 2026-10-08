// Fixes verified defects:
// - NIT 10 (second half): a "shielded"-kind payout that fell back to Solana
//   ZEC used to be counted as shielded money in GET /api/epochs and a coin's
//   rewards -- it actually moved over the Solana rail. src/api.ts's
//   payoutRail() reclassifies by what actually happened, not by `kind`.
// - Finding 9: a wallet's pending shielded balance must not be readable by a
//   stranger who only knows its public key. Since v2.9 that is true of everything
//   about its shielded delivery: POST /api/optin/status answers only a fresh
//   signature (the unsigned GET route is gone).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { handleRequest, computeCoinRewards } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { shieldedViewMessage } from "../src/optin/message";

const HAS_DEVTOOL = existsSync(config.paths.zcashDevtoolBin);
const B = "http://pad.test/api";

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(B + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

function mint(): string {
  return Keypair.generate().publicKey.toBase58();
}

function seedLaunchedCoin(m: string): void {
  db.upsertCoin({
    mint: m, name: "Rail", symbol: "RAIL", imageUrl: "", description: "", creator: m,
    createdAt: new Date().toISOString(), feeBps: 300, poolId: Keypair.generate().publicKey.toBase58(), mintDecimals: 6, status: "launched",
  });
}

describe("payout rail reclassification (finding 10)", () => {
  test("a shielded-kind payout that fell back to Solana is counted under solanaPayouts, not shielded, in GET /api/epochs", async () => {
    const m = mint();
    seedLaunchedCoin(m);
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    db.upsertEpoch({
      id: epochId, at: new Date().toISOString(), coinMints: JSON.stringify([m]), harvestedZats: "1500", feeZats: "0",
      status: "fallback_solana", swapProvider: null, swapRef: null, swapState: "failed_before_funds_moved", swapAmountOutZats: null, zcashTxids: "[]",
    });
    db.planPayout({ epochId, wallet: "solanaHolder", kind: "solana", amountZats: "500" });
    db.markPayoutSent(epochId, "solanaHolder", "solana", "sig-solana-1");
    db.planPayout({ epochId, wallet: "shieldedHolder", kind: "shielded", amountZats: "1000", zcashAddress: "uregtest1x" });
    db.markPayoutSent(epochId, "shieldedHolder", "shielded", "fallback_solana:sig-fallback-1");

    const r = await call("GET", "/epochs");
    expect(r.status).toBe(200);
    const epoch = (r.body.epochs as Record<string, unknown>[]).find((e) => e.id === epochId)!;
    const solanaPayouts = epoch.solanaPayouts as { count: number; totalZats: string; sigs: string[] };
    const shielded = epoch.shielded as { count: number; totalZats: string; zcashTxids: string[] };

    // Both the direct solana holder AND the fallen-back shielded holder moved
    // real money over the Solana rail: both belong here.
    expect(solanaPayouts.count).toBe(2);
    expect(solanaPayouts.totalZats).toBe("1500");
    expect(solanaPayouts.sigs.sort()).toEqual(["sig-fallback-1", "sig-solana-1"]); // prefix stripped
    // Nothing actually moved over the Zcash rail this epoch.
    expect(shielded.count).toBe(0);
    expect(shielded.totalZats).toBe("0");
    expect(shielded.zcashTxids).toEqual([]);
  });

  test("a real Zcash-rail shielded payout is still counted as shielded", async () => {
    const m = mint();
    seedLaunchedCoin(m);
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    db.upsertEpoch({
      id: epochId, at: new Date().toISOString(), coinMints: JSON.stringify([m]), harvestedZats: "1000", feeZats: "20000",
      status: "ok", swapProvider: "simulated", swapRef: "burn-x", swapState: "settled", swapAmountOutZats: "1000", zcashTxids: "[]",
    });
    const txid = "b".repeat(64);
    db.planPayout({ epochId, wallet: "shieldedHolder2", kind: "shielded", amountZats: "1000", zcashAddress: "uregtest1y" });
    db.markPayoutSent(epochId, "shieldedHolder2", "shielded", txid);

    const r = await call("GET", "/epochs");
    const epoch = (r.body.epochs as Record<string, unknown>[]).find((e) => e.id === epochId)!;
    const shielded = epoch.shielded as { count: number; totalZats: string; zcashTxids: string[] };
    expect(shielded.count).toBe(1);
    expect(shielded.totalZats).toBe("1000");
    expect(shielded.zcashTxids).toEqual([txid]);
  });

  test("a row with no real signature (carried:, zero_after_fee) counts on neither rail", async () => {
    const m = mint();
    seedLaunchedCoin(m);
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    db.upsertEpoch({
      id: epochId, at: new Date().toISOString(), coinMints: JSON.stringify([m]), harvestedZats: "300", feeZats: "0",
      status: "ok", swapProvider: null, swapRef: null, swapState: "settled", swapAmountOutZats: "0", zcashTxids: "[]",
    });
    db.planPayout({ epochId, wallet: "carriedHolder", kind: "solana", amountZats: "300" });
    db.markPayoutSent(epochId, "carriedHolder", "solana", "carried:cannot_derive_destination_ata");

    const r = await call("GET", "/epochs");
    const epoch = (r.body.epochs as Record<string, unknown>[]).find((e) => e.id === epochId)!;
    const solanaPayouts = epoch.solanaPayouts as { count: number; totalZats: string };
    expect(solanaPayouts.count).toBe(0);
    expect(solanaPayouts.totalZats).toBe("0");
  });

  test("a coin's rewards attribute a fallen-back shielded payout to paidSolanaZec, not paidShieldedZec", () => {
    // computeCoinRewards directly (not via GET /coins/:mint, which also needs
    // a real on-chain pool account -- irrelevant to what this is checking).
    const m = mint();
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    db.upsertEpoch({
      id: epochId, at: new Date().toISOString(), coinMints: JSON.stringify([m]), harvestedZats: "700", feeZats: "0",
      status: "fallback_solana", swapProvider: null, swapRef: null, swapState: "failed_before_funds_moved", swapAmountOutZats: null, zcashTxids: "[]",
    });
    db.planPayout({ epochId, wallet: "w1", kind: "shielded", amountZats: "700", zcashAddress: "uregtest1z" });
    db.markPayoutSent(epochId, "w1", "shielded", "fallback_solana:sig-fb");

    const rewards = computeCoinRewards(m);
    expect(rewards.paidSolanaZec).toBe("700");
    expect(rewards.paidShieldedZec).toBe("0");
  });
});

function deriveRegtestUA(): string {
  const proc = Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "derive-address", "--mnemonic", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "--network", "regtest"]);
  return /Unified Address:\s*(\S+)/.exec(new TextDecoder().decode(proc.stdout))![1]!;
}
function signAs(kp: Keypair, message: string): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
}

describe("POST /api/optin/status pendingZats gating (finding 9, v2.9)", () => {
  /** A fresh nonce for the wallet and the signed read of it. */
  async function signedRead(kp: Keypair, signer: Keypair = kp) {
    const wallet = kp.publicKey.toBase58();
    const nonce = (await call("GET", `/optin/nonce?wallet=${wallet}`)).body.nonce as string;
    const body = { wallet, nonce, signature: signAs(signer, shieldedViewMessage(wallet, nonce)) };
    return { body, read: () => call("POST", "/optin/status", body) };
  }

  test.if(HAS_DEVTOOL)("without a signature nothing about an opted-in wallet with a nonzero pending balance is shown: no route answers an unsigned read", async () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = deriveRegtestUA();
    const nonceRes = await call("GET", `/optin/nonce?wallet=${wallet}`);
    const optinSig = signAs(kp, `SNARKS pad: deliver my rewards shielded\nwallet: ${wallet}\nzcash: ${ua}\nnonce: ${nonceRes.body.nonce}`);
    const optinRes = await call("POST", "/optin", { wallet, zcashAddress: ua, nonce: nonceRes.body.nonce, signature: optinSig });
    expect(optinRes.status).toBe(200);
    db.setCarry(wallet, "shielded", 42_000n); // a real pending balance exists

    const status = await call("GET", `/optin/${wallet}`);
    expect(status.status).toBe(404);
    expect(status.body).toEqual({ error: "not_found" }); // a stranger who only knows the pubkey learns nothing: not the balance, not even whether the wallet opted in
  });

  test("a valid signed read shows the real pendingZats", async () => {
    const kp = Keypair.generate();
    db.setCarry(kp.publicKey.toBase58(), "shielded", 77_000n);

    const status = await (await signedRead(kp)).read();
    expect(status.status).toBe(200);
    expect(status.body.pendingZats).toBe("77000");
  });

  test("a wrong signature never shows pendingZats (400 invalid_signature, and no balance in the answer)", async () => {
    const kp = Keypair.generate();
    const attacker = Keypair.generate();
    db.setCarry(kp.publicKey.toBase58(), "shielded", 5_000n);

    const status = await (await signedRead(kp, attacker)).read(); // signed by the WRONG key
    expect(status.status).toBe(400);
    expect(status.body).toEqual({ error: "invalid_signature" });
    expect(status.text).not.toContain("5000");
  });

  test("a read's nonce cannot be replayed to view pendingZats a second time", async () => {
    const kp = Keypair.generate();
    db.setCarry(kp.publicKey.toBase58(), "shielded", 9_000n);

    const { read } = await signedRead(kp);
    expect((await read()).body.pendingZats).toBe("9000");
    const replay = await read();
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: "stale_nonce" });
  });
});
