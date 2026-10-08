// A claim whose ZEC may already be on its way (signed but unconfirmed, or
// waiting for a Squads approval) must stop the epoch from being finalized or
// discarded: otherwise the ZEC lands in the keeper account and belongs to no
// epoch (PORT-ASSUMPTIONS E2, P1). The draft the cut-off agent left finalized
// or deleted such an epoch.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import type { SwapAdapter } from "../src/swap/types";

const neverSwap: SwapAdapter = {
  provider: "simulated",
  async quote() {
    throw new Error("a gated epoch must never reach the swap");
  },
  async submit() {
    throw new Error("a gated epoch must never reach the swap");
  },
  async status() {
    throw new Error("a gated epoch must never reach the swap");
  },
};

const noClaims = async () => {};

function draftEpoch(): string {
  const id = `epoch-gate-${crypto.randomUUID()}`;
  db.upsertEpoch({
    id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting",
    swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]",
  });
  return id;
}

const signedClaim = (epochId: string, mint: string, phase: "single" | "propose" = "single") =>
  db.recordClaimSigned({ epochId, mint, kind: "trading", sig: "sig-" + crypto.randomUUID(), rawTx: "AA==", lastValidBlockHeight: 10, phase });

describe("an epoch with an unconfirmed claim waits", () => {
  test("a signed, unconfirmed claim: the epoch is neither finalized nor discarded, and nothing is paid", async () => {
    const epochId = draftEpoch();
    const mint = Keypair.generate().publicKey.toBase58();
    signedClaim(epochId, mint);
    const out = await runEpoch(neverSwap, noClaims);
    expect(out.epoch).toBeNull();
    expect(out.awaitingClaims?.[0]).toContain(mint);
    expect(db.getEpoch(epochId)?.status).toBe("harvesting"); // the draft, and with it the claim's attribution, survives
    expect(db.getPayouts(epochId)).toEqual([]);
    expect(db.getClaimProgress(epochId, mint, "trading")?.status).toBe("signed");
    db.deleteDraftEpoch(epochId);
  });

  test("a Squads claim waiting for approval is gated the same way", async () => {
    const epochId = draftEpoch();
    const mint = Keypair.generate().publicKey.toBase58();
    signedClaim(epochId, mint, "propose");
    db.setClaimPhase(epochId, mint, "trading", "await");
    const out = await runEpoch(neverSwap, noClaims);
    expect(out.awaitingClaims?.[0]).toContain("(await)");
    expect(db.getEpoch(epochId)?.status).toBe("harvesting");
    db.deleteDraftEpoch(epochId);
  });

  test("once every claim is confirmed with nothing claimed, the empty draft is discarded as before", async () => {
    const epochId = draftEpoch();
    const mint = Keypair.generate().publicKey.toBase58();
    signedClaim(epochId, mint);
    db.recordClaimConfirmed(epochId, mint, "trading", 0n);
    const out = await runEpoch(neverSwap, noClaims);
    expect(out.awaitingClaims).toBeUndefined();
    expect(out.epoch).toBeNull();
    expect(db.getEpoch(epochId)).toBeNull(); // nothing claimed: no epoch is recorded
  });

  test("a confirmed claim is never replaced by a later signed one for the same (epoch, coin, kind)", () => {
    const epochId = draftEpoch();
    const mint = Keypair.generate().publicKey.toBase58();
    signedClaim(epochId, mint);
    db.recordClaimConfirmed(epochId, mint, "trading", 123n);
    signedClaim(epochId, mint);
    db.replaceClaimTx({ epochId, mint, kind: "trading", sig: "other", rawTx: "AA==", lastValidBlockHeight: 1, phase: "execute" });
    db.clearUnlandedClaim(epochId, mint, "trading");
    expect(db.getClaimProgress(epochId, mint, "trading")).toMatchObject({ status: "confirmed", amountZats: "123" });
    db.deleteDraftEpoch(epochId);
  });
});
