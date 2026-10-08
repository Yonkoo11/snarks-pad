// Fixes verified defects (review findings 1 and 4): a payout batch is now
// marked sent only once its signature/txid is confirmed on chain, never after
// the fact for the whole epoch -- but a signature/txid IS persisted the
// moment it's known, BEFORE broadcast, so a crash resumes by checking that
// signature's status instead of blindly resending. And a shielded payout's
// destination Zcash address is snapshotted at planning time, immune to a
// later opt-out.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";

function epochId(): string {
  return `epoch-test-${crypto.randomUUID()}`;
}

describe("payout pending/sent resume (finding 1)", () => {
  test("a freshly planned payout has no signature and is both 'fresh' and 'unsent'", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "1000" });

    expect(db.getUnsentPayouts(id, "solana").length).toBe(1);
    expect(db.getFreshUnsentPayouts(id, "solana").length).toBe(1);
    expect(db.getPendingPayouts(id, "solana").length).toBe(0);
  });

  test("markPayoutPending records a signature BEFORE broadcast, without marking sent", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "1000" });

    db.markPayoutPending(id, "w1", "solana", "sig-not-yet-confirmed");

    // Still unsent (this is the bug the review found: the OLD code only
    // wrote anything to the DB after every batch in the whole epoch had
    // already been confirmed -- a crash here used to lose the fact that a
    // signature had even been attempted).
    const row = db.getPayouts(id)[0]!;
    expect(row.sig).toBe("sig-not-yet-confirmed");
    expect(row.sentAt).toBeNull();
    // No longer "fresh" (a signed attempt exists) but also not yet "sent".
    expect(db.getFreshUnsentPayouts(id, "solana").length).toBe(0);
    expect(db.getPendingPayouts(id, "solana").length).toBe(1);
    expect(db.getUnsentPayouts(id, "solana").length).toBe(1);
  });

  test("resume path A: the pending signature turns out to have landed -- markPayoutSent resolves it, no resend needed", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "1000" });
    db.markPayoutPending(id, "w1", "solana", "sig-landed");

    // Simulates the resume check finding the signature confirmed on chain.
    db.markPayoutSent(id, "w1", "solana", "sig-landed");

    expect(db.getPendingPayouts(id, "solana").length).toBe(0);
    expect(db.getUnsentPayouts(id, "solana").length).toBe(0);
    expect(db.getPayouts(id)[0]!.sig).toBe("sig-landed");
  });

  test("resume path B: the pending signature never landed -- clearPendingPayoutSig frees it for a fresh attempt, never resends the dead signature", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "1000" });
    db.markPayoutPending(id, "w1", "solana", "sig-dead-blockhash-expired");

    db.clearPendingPayoutSig(id, "w1", "solana");

    const row = db.getPayouts(id)[0]!;
    expect(row.sig).toBeNull();
    expect(row.sentAt).toBeNull();
    expect(db.getFreshUnsentPayouts(id, "solana").length).toBe(1); // eligible for a brand new batch/signature
  });

  test("clearPendingPayoutSig never touches an already-sent row (safety against a stale resume clearing real money)", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "1000" });
    db.markPayoutSent(id, "w1", "solana", "sig-real");

    db.clearPendingPayoutSig(id, "w1", "solana"); // should be a no-op: sentAt is already set

    const row = db.getPayouts(id)[0]!;
    expect(row.sig).toBe("sig-real");
    expect(row.sentAt).not.toBeNull();
  });

  test("multiple wallets sharing one batch signature all resolve together", () => {
    const id = epochId();
    for (const w of ["a", "b", "c"]) db.planPayout({ epochId: id, wallet: w, kind: "solana", amountZats: "10" });
    for (const w of ["a", "b", "c"]) db.markPayoutPending(id, w, "solana", "batch-sig-1");

    expect(db.getPendingPayouts(id, "solana").map((p) => p.wallet).sort()).toEqual(["a", "b", "c"]);

    for (const w of ["a", "b", "c"]) db.markPayoutSent(id, w, "solana", "batch-sig-1");
    expect(db.getUnsentPayouts(id, "solana").length).toBe(0);
  });
});

describe("shielded destination snapshot (finding 4)", () => {
  test("planPayout records the Zcash address at planning time, on the payout row itself", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "shielded", amountZats: "5000", zcashAddress: "uregtest1abc" });

    const row = db.getPayouts(id)[0]!;
    expect(row.zcashAddress).toBe("uregtest1abc");
  });

  test("an opt-out after planning does not change an already-planned payout's destination", () => {
    const wallet = `wallet-${crypto.randomUUID()}`;
    db.upsertOptin(wallet, "uregtest1original");
    const id = epochId();
    // Mirrors src/epoch/engine.ts planPayouts: the address is read from the
    // opt-in registry ONCE, at planning time, and stored on the row.
    const optedInAddress = db.getOptin(wallet)!.zcashAddress;
    db.planPayout({ epochId: id, wallet, kind: "shielded", amountZats: "5000", zcashAddress: optedInAddress });

    // The holder opts out before the shielded leg actually sends.
    db.deactivateOptin(wallet);

    // The registry no longer considers them opted in...
    expect(db.getOptin(wallet)!.active).toBe(0);
    // ...but the payout already planned still has the original destination:
    // this is what src/epoch/engine.ts's sendShieldedLeg reads, never a live
    // re-query of the (now opted-out) registry.
    const row = db.getPayouts(id)[0]!;
    expect(row.zcashAddress).toBe("uregtest1original");
  });

  test("a solana-kind payout has no zcashAddress", () => {
    const id = epochId();
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "1000" });
    expect(db.getPayouts(id)[0]!.zcashAddress).toBeNull();
  });
});
