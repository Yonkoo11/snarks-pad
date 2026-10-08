// Fixes verified defects (review finding 2: the swap leg was not idempotent
// and its bare catch could fall back to Solana ZEC even after funds had
// already moved; finding 7: shielded holders were paid from the harvested-
// input estimate, not the swap's real settled output). progressSwap
// (src/epoch/engine.ts) is tested directly against fake SwapAdapters -- no
// chain needed, since it only ever touches `db` and the injected adapter.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { progressSwap } from "../src/epoch/engine";
import type { SwapAdapter, SwapSettlement, SwapSubmission } from "../src/swap/types";

function draftEpoch(): db.EpochRow {
  const epoch: db.EpochRow = {
    id: `epoch-test-${crypto.randomUUID()}`,
    at: new Date().toISOString(),
    coinMints: "[]",
    harvestedZats: "0",
    feeZats: "0",
    status: "ok",
    swapProvider: null,
    swapRef: null,
    swapState: "none",
    swapAmountOutZats: null,
    zcashTxids: "[]",
  };
  db.upsertEpoch(epoch);
  return epoch;
}

function planShielded(epochId: string, shares: [string, string][]): db.PayoutRow[] {
  for (const [wallet, amountZats] of shares) db.planPayout({ epochId, wallet, kind: "shielded", amountZats, zcashAddress: `uregtest1${wallet}` });
  return db.getUnsentPayouts(epochId, "shielded");
}

/** A fake adapter whose every call is counted, so a test can assert it was never called twice for the same effect. */
function fakeAdapter(behavior: {
  submit: (amountZats: bigint) => Promise<SwapSubmission>;
  status: (ref: string) => Promise<SwapSettlement>;
}): SwapAdapter & { submitCalls: number; statusCalls: number } {
  const fake = {
    provider: "simulated" as const,
    submitCalls: 0,
    statusCalls: 0,
    async quote(amountZats: bigint) {
      return { outZats: amountZats };
    },
    async submit(amountZats: bigint) {
      fake.submitCalls++;
      return behavior.submit(amountZats);
    },
    async status(ref: string) {
      fake.statusCalls++;
      return behavior.status(ref);
    },
  };
  return fake;
}

describe("swap leg state machine (finding 2)", () => {
  test("submit() rejecting before any funds move -> failed_before_funds_moved, and is never retried", async () => {
    const epoch = draftEpoch();
    const unsent = planShielded(epoch.id, [["w1", "10000"]]);
    const swap = fakeAdapter({
      submit: async () => {
        throw new Error("insufficient keeper balance");
      },
      status: async () => ({ status: "pending" }),
    });

    const outcome1 = await progressSwap(epoch.id, unsent, swap);
    expect(outcome1).toBe("failed_before_funds_moved");
    expect(db.getEpoch(epoch.id)!.swapState).toBe("failed_before_funds_moved");
    expect(swap.submitCalls).toBe(1);

    // A later resume (or a second call in the same run) must never attempt
    // submit() again once the epoch is marked failed_before_funds_moved.
    const outcome2 = await progressSwap(epoch.id, unsent, swap);
    expect(outcome2).toBe("failed_before_funds_moved");
    expect(swap.submitCalls).toBe(1);
  });

  test("submit() resolving -> submitted is persisted with its ref immediately; a still-pending status never re-submits and never falls back", async () => {
    const epoch = draftEpoch();
    const unsent = planShielded(epoch.id, [["w1", "10000"]]);
    const swap = fakeAdapter({
      submit: async () => ({ ref: "burn-sig-1" }),
      status: async () => ({ status: "pending" }), // bridge hasn't settled yet
    });

    const outcome1 = await progressSwap(epoch.id, unsent, swap);
    expect(outcome1).toBe("pending");
    expect(db.getEpoch(epoch.id)!.swapState).toBe("submitted");
    expect(db.getEpoch(epoch.id)!.swapRef).toBe("burn-sig-1");
    expect(swap.submitCalls).toBe(1);

    // Resuming polls status() again -- it must NEVER call submit() a second
    // time now that funds have already moved (this is exactly the bug: a
    // bare catch used to fall back to Solana ZEC here, double-paying).
    const outcome2 = await progressSwap(epoch.id, unsent, swap);
    expect(outcome2).toBe("pending");
    expect(swap.submitCalls).toBe(1);
    expect(swap.statusCalls).toBe(2);
  });

  test("status() eventually settling reprices every covered payout pro-rata from the real output minus the network fee (finding 7), exactly once", async () => {
    const epoch = draftEpoch();
    // Pre-swap plan, from the harvested-input ESTIMATE: 10000/20000/30000 = 60000 total.
    const unsent = planShielded(epoch.id, [
      ["w1", "10000"],
      ["w2", "20000"],
      ["w3", "30000"],
    ]);
    const swap = fakeAdapter({
      submit: async () => ({ ref: "burn-sig-2" }),
      status: async () => ({ status: "settled", amountOutZats: 50000n }), // bridge's real output, after its own spread/fee
    });

    const outcome = await progressSwap(epoch.id, unsent, swap);
    expect(outcome).toBe("settled");

    const epochAfter = db.getEpoch(epoch.id)!;
    expect(epochAfter.swapAmountOutZats).toBe("50000");

    // Zcash network fee model (engine/README.md): 5000 * (N + 1) zats.
    // payable = 50000 - 5000*4 = 30000. Split 1:2:3 of 30000 -> exactly 5000/10000/15000.
    const repriced = new Map(db.getFreshUnsentPayouts(epoch.id, "shielded").map((p) => [p.wallet, p.amountZats]));
    expect(repriced.get("w1")).toBe("5000");
    expect(repriced.get("w2")).toBe("10000");
    expect(repriced.get("w3")).toBe("15000");
    // The repriced amounts still sum to exactly the payable pool -- no dust lost.
    const sum = [...repriced.values()].reduce((acc, v) => acc + BigInt(v), 0n);
    expect(sum).toBe(30000n);

    // A second call (a later resume, or a caller polling twice) must not
    // touch the amounts again -- otherwise a partially-sent epoch would
    // re-split the same settled total against a smaller remaining set.
    db.markPayoutSent(epoch.id, "w1", "shielded", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const outcome2 = await progressSwap(epoch.id, unsent, swap);
    expect(outcome2).toBe("settled");
    expect(swap.statusCalls).toBe(1); // never polled again once settled
    const stillFresh = new Map(db.getFreshUnsentPayouts(epoch.id, "shielded").map((p) => [p.wallet, p.amountZats]));
    expect(stillFresh.get("w2")).toBe("10000"); // untouched by the second call
    expect(stillFresh.get("w3")).toBe("15000");
  });

  test("submit() never called a second time once already submitted, even across a fresh progressSwap invocation (simulating a restarted process)", async () => {
    const epoch = draftEpoch();
    db.upsertEpoch({ ...epoch, swapState: "submitted", swapRef: "burn-sig-resumed", swapProvider: "simulated" });
    const unsent = planShielded(epoch.id, [["w1", "10000"]]);
    const swap = fakeAdapter({
      submit: async () => {
        throw new Error("must never be called: swapState is already 'submitted'");
      },
      status: async () => ({ status: "settled", amountOutZats: 9000n }),
    });

    const outcome = await progressSwap(epoch.id, unsent, swap);
    expect(outcome).toBe("settled");
    expect(swap.submitCalls).toBe(0);
  });
});
