import { describe, expect, test } from "bun:test";
import * as db from "../src/db";

// Exercises the resumability contract the epoch engine relies on (src/epoch/engine.ts):
// payouts are planned (persisted, unsent) before anything is sent, and a crash
// between planning and sending must resume from exactly where it left off,
// never re-planning (which would change amounts) and never re-sending an
// already-sent recipient.
describe("payout idempotency / resume", () => {
  test("planning the same payout twice never creates a duplicate or reopens a sent one", () => {
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    db.planPayout({ epochId, wallet: "walletA", kind: "solana", amountZats: "1000" });
    db.planPayout({ epochId, wallet: "walletA", kind: "solana", amountZats: "1000" }); // simulates a re-run before sending

    const rows = db.getPayouts(epochId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.amountZats).toBe("1000");

    db.markPayoutSent(epochId, "walletA", "solana", "sig-real-1");
    // A later resume attempt tries to plan the same recipient again (e.g. a
    // process restart re-running the planning step). It must not reopen the
    // already-sent row or touch its signature.
    db.planPayout({ epochId, wallet: "walletA", kind: "solana", amountZats: "1000" });
    const after = db.getPayouts(epochId);
    expect(after.length).toBe(1);
    expect(after[0]!.sig).toBe("sig-real-1");
    expect(after[0]!.sentAt).not.toBeNull();
  });

  test("a crash after planning but before sending resumes by sending only the unsent recipients", () => {
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    for (const w of ["a", "b", "c"]) {
      db.planPayout({ epochId, wallet: w, kind: "shielded", amountZats: "5000" });
    }
    // "the process" sends recipient a, then crashes before b and c.
    db.markPayoutSent(epochId, "a", "shielded", "txid-a");

    const unsentAfterCrash = db.getUnsentPayouts(epochId, "shielded");
    expect(unsentAfterCrash.map((p) => p.wallet).sort()).toEqual(["b", "c"]);

    // resume: send exactly the unsent set, nothing more
    for (const p of unsentAfterCrash) db.markPayoutSent(epochId, p.wallet, "shielded", `txid-${p.wallet}`);

    expect(db.getUnsentPayouts(epochId, "shielded")).toEqual([]);
    const all = db.getPayouts(epochId);
    expect(all.find((p) => p.wallet === "a")!.sig).toBe("txid-a"); // untouched by the resume
    expect(all.every((p) => p.sentAt !== null)).toBe(true);
  });

  test("an epoch with unsent payouts is distinguishable from a fully-sent one", () => {
    const incomplete = `epoch-test-${crypto.randomUUID()}`;
    const complete = `epoch-test-${crypto.randomUUID()}`;
    db.planPayout({ epochId: incomplete, wallet: "w1", kind: "solana", amountZats: "10" });
    db.planPayout({ epochId: complete, wallet: "w2", kind: "solana", amountZats: "10" });
    db.markPayoutSent(complete, "w2", "solana", "sig-w2");

    expect(db.getUnsentPayouts(incomplete, "solana").length).toBe(1);
    expect(db.getUnsentPayouts(complete, "solana").length).toBe(0);
  });

  test("carry persists exactly across a get/set round trip", () => {
    const wallet = `wallet-${crypto.randomUUID()}`;
    expect(db.getCarry(wallet, "shielded")).toBe(0n);
    db.setCarry(wallet, "shielded", 4321n);
    expect(db.getCarry(wallet, "shielded")).toBe(4321n);
    db.setCarry(wallet, "shielded", 0n); // cleared once a later epoch's total clears the floor
    expect(db.getCarry(wallet, "shielded")).toBe(0n);
  });
});
