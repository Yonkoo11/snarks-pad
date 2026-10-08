// Audit S6, product decision 2: an opted-in holder's money never goes to the public rail because of a price, a cap or a provider.
//   Before: a swap refused before any deposit (the quote lost too much, the amount was over the cap, the provider said no) or
//   refunded after one paid every shielded share as Solana ZEC, which ZIP 315 calls spending transparently without consent.
//   Now: the rows carry to the next shielded round (the carry is Solana ZEC the keeper holds, shown as pending on the opt-in
//   page), the operator is told on every refusal and after three carried rounds in a row, the loss cap is the withdraw fee
//   plus 300 bps, and a leg over the per-swap cap sends up to the cap pro rata and carries the rest. progressSwap is driven
//   against fake adapters, as swap-state-machine.test.ts does: no chain.
import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import * as db from "../src/db";
import { SHIELDED_CARRIED_ROUNDS_ALERT_AT, progressSwap, shieldedSwapCap } from "../src/epoch/engine";
import { applyShieldedPolicy } from "../src/epoch/math";
import { deliveryReserve } from "../src/epoch/split";
import type { SwapAdapter, SwapSettlement } from "../src/swap/types";

const w = () => `w-${crypto.randomUUID()}`;

function draftEpoch(extra: Partial<db.EpochRow> = {}): db.EpochRow {
  const epoch: db.EpochRow = {
    id: `epoch-carry-${crypto.randomUUID()}`, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok",
    swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]", ...extra,
  };
  db.upsertEpoch(epoch);
  return epoch;
}

function planShielded(epochId: string, shares: [string, bigint][]): db.PayoutRow[] {
  for (const [wallet, amount] of shares) db.planPayout({ epochId, wallet, kind: "shielded", amountZats: amount.toString(), zcashAddress: `u1${wallet}` });
  return db.getUnsentPayouts(epochId, "shielded");
}

const refusing = (reason: string): SwapAdapter => ({
  provider: "near-1click",
  quote: async () => ({ outZats: 0n }),
  submit: async () => { throw new Error(reason); },
  status: async () => { throw new Error("never polled: nothing was submitted"); },
});

const settlingAfter = (status: SwapSettlement): SwapAdapter => ({
  provider: "near-1click",
  quote: async (zats) => ({ outZats: zats }),
  submit: async () => ({ ref: `dep-${crypto.randomUUID()}` }),
  status: async () => status,
});

const openAlerts = (kind: string) => db.listOpenAlerts().filter((a) => a.kind === kind);
const resetRounds = () => {
  db.setMeta("shielded_carried_rounds", "0");
  db.resolveAlerts("shielded_carried_rounds", "");
};

describe("a refused swap carries every shielded share; nothing is paid on the public rail", () => {
  beforeEach(resetRounds);

  test("submit() refusing (the quote lost too much): the rows close as carried, the carry holds the full amount, the state is recorded, the operator is told", async () => {
    const epoch = draftEpoch();
    db.setEpochTeamSplit(epoch.id, 50_000n, 40_000n);
    const [a, b] = [w(), w()];
    const unsent = planShielded(epoch.id, [[a, 300_000n], [b, 700_000n]]);
    const outcome = await progressSwap(epoch.id, unsent, refusing("refusing the 1Click quote, nothing was signed: quote.minAmountOut 900000 loses more than 300 bps"));
    expect(outcome).toBe("failed_before_funds_moved");
    expect(db.getEpoch(epoch.id)).toMatchObject({ swapState: "failed_before_funds_moved", teamSolanaZats: "50000", deliveryCostZats: "0" });
    expect(db.getUnsentPayouts(epoch.id, "shielded")).toEqual([]);
    expect(db.getPayouts(epoch.id).map((p) => [p.wallet, p.sig, p.amountZats]).sort()).toEqual([[a, "carried:swap_refused", "300000"], [b, "carried:swap_refused", "700000"]].sort());
    expect(db.getCarry(a, "shielded")).toBe(300_000n);
    expect(db.getCarry(b, "shielded")).toBe(700_000n);
    const alert = openAlerts("swap_refused").find((x) => x.epochId === epoch.id);
    expect(alert?.message).toContain("swap_refused: refusing the 1Click quote");
    expect(db.getMeta("shielded_carried_rounds")).toBe("1");
  });

  test("a refund (the provider returned the deposit short): the shares are repriced for the shortfall the team cannot cover, then carried", async () => {
    // Team gross 1,000, reserve 1,000; refund short by 3,000: the team bears 1,000, the holders the other 2,000 pro rata (1:3).
    const epoch = draftEpoch({ swapState: "submitted", swapRef: "dep-1", swapProvider: "near-1click" });
    db.setEpochTeamSplit(epoch.id, 1_000n, 1_000n);
    const [a, b] = [w(), w()];
    const unsent = planShielded(epoch.id, [[a, 100_000n], [b, 300_000n]]);
    const outcome = await progressSwap(epoch.id, unsent, settlingAfter({ status: "returned", amountReturnedZats: 400_000n + 1_000n - 3_000n }));
    expect(outcome).toBe("returned_to_keeper");
    expect(db.getEpoch(epoch.id)).toMatchObject({ swapState: "returned_to_keeper", holderShortfallZats: "2000" });
    expect(db.getUnsentPayouts(epoch.id, "shielded")).toEqual([]);
    expect(db.getCarry(a, "shielded")).toBe(99_500n);
    expect(db.getCarry(b, "shielded")).toBe(298_500n);
    expect(db.getPayouts(epoch.id).every((p) => p.sig === "carried:swap_returned")).toBe(true);
    expect(openAlerts("swap_refused").find((x) => x.epochId === epoch.id)?.message).toContain("returned the deposit short by 3000 zats");
  });

  test("three carried rounds in a row raise the standing alert; a settled swap clears it", async () => {
    for (let i = 0; i < SHIELDED_CARRIED_ROUNDS_ALERT_AT; i++) {
      const epoch = draftEpoch();
      const unsent = planShielded(epoch.id, [[w(), 2_000_000n]]);
      await progressSwap(epoch.id, unsent, refusing("1Click quote failed: HTTP 422 amount too small"));
      expect(openAlerts("shielded_carried_rounds")).toHaveLength(i + 1 === SHIELDED_CARRIED_ROUNDS_ALERT_AT ? 1 : 0);
    }
    expect(openAlerts("shielded_carried_rounds")[0]!.message).toContain(`${SHIELDED_CARRIED_ROUNDS_ALERT_AT} shielded rounds in a row`);
    const epoch = draftEpoch();
    const unsent = planShielded(epoch.id, [[w(), 2_000_000n]]);
    expect(await progressSwap(epoch.id, unsent, settlingAfter({ status: "settled", amountOutZats: 1_900_000n }))).toBe("settled");
    expect(db.getMeta("shielded_carried_rounds")).toBe("0");
    expect(openAlerts("shielded_carried_rounds")).toHaveLength(0);
    expect(openAlerts("swap_refused")).toHaveLength(0); // the refused rounds' shares are in this swap: their alerts are over (nemesis NM-3)
  });

  test("the alert never carries a Zcash address: a refused quote names the treasury's address, the alert shows it shortened", async () => {
    const epoch = draftEpoch();
    const unsent = planShielded(epoch.id, [[w(), 2_000_000n]]);
    await progressSwap(epoch.id, unsent, refusing("refusing the 1Click quote: quoteRequest.recipient is \"u1qwertyuiopasdfghjklzxcvbnm1234567890abcdefghijk\", expected \"u1zxcvbnmasdfghjklqwertyuiop0987654321abcdefghijk\""));
    const alert = openAlerts("swap_refused").find((x) => x.epochId === epoch.id)!;
    expect(alert.message).not.toContain("u1qwertyuiop");
    expect(alert.message).toContain("u1qw…hijk");
  });

  test("an epoch in a refused or refunded state from before the carry rule (nemesis NM-2): a row the old public fallback was to pay carries by the same rule", async () => {
    const a = w();
    const epoch = draftEpoch({ swapState: "failed_before_funds_moved" });
    planShielded(epoch.id, [[a, 250_000n]]);
    const { runEpoch } = await import("../src/epoch/engine");
    db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL AND epochId != $e").run({ $e: epoch.id });
    db.getDb().query("UPDATE epochs SET status = 'ok' WHERE status IN ('harvesting','partial') AND id != $e").run({ $e: epoch.id });
    const out = await runEpoch(refusing("never submitted: the state is final"), async () => {}, { isolation: { keeperZecBalance: async () => 0n, treasurySpendableZats: async () => 0n } });
    expect(out.epoch?.id).toBe(epoch.id);
    expect(db.getEpoch(epoch.id)).toMatchObject({ status: "ok", swapState: "failed_before_funds_moved" });
    expect(db.getPayouts(epoch.id).map((p) => [p.wallet, p.sig])).toEqual([[a, "carried:swap_refused"]]);
    expect(db.getCarry(a, "shielded")).toBe(250_000n);
  });
});

describe("the per-swap cap scales the shares down and carries the rest (never the public rail)", () => {
  const policy = { perHolderMinZats: 100_000n, swapMinZats: 1_000_000n, swapMaxZats: 10_000_000n };

  test("under the cap nothing changes; over it each share sends its pro-rata part and carries the remainder; the sum never passes the cap", () => {
    const under = applyShieldedPolicy([{ wallet: "a", amount: 4_000_000n }, { wallet: "b", amount: 6_000_000n }], new Map(), policy);
    expect(under.toSend.map((s) => s.amount)).toEqual([4_000_000n, 6_000_000n]);
    expect(under.toCarry).toEqual([]);

    const over = applyShieldedPolicy([{ wallet: "a", amount: 5_000_000n }, { wallet: "b", amount: 15_000_000n }], new Map([["b", 5_000_000n]]), policy);
    // a 5M and b 20M (15M + 5M carried) = 25M: the cap is 10M, so a sends 2M and b 8M; a carries 3M and b 12M.
    expect(over.toSend).toEqual([{ wallet: "a", amount: 2_000_000n }, { wallet: "b", amount: 8_000_000n }]);
    expect(over.toCarry).toEqual([{ wallet: "a", amount: 3_000_000n }, { wallet: "b", amount: 12_000_000n }]);
    expect(over.toSend.reduce((acc, s) => acc + s.amount, 0n) <= policy.swapMaxZats).toBe(true);
  });

  test("a part that would fall under the per-holder minimum carries whole; rounding never pushes the sum over the cap", () => {
    const shares = [{ wallet: "tiny", amount: 150_000n }, { wallet: "a", amount: 33_333_333n }, { wallet: "b", amount: 33_333_334n }, { wallet: "c", amount: 33_333_333n }];
    const r = applyShieldedPolicy(shares, new Map(), policy);
    expect(r.toSend.map((s) => s.wallet)).toEqual(["a", "b", "c"]); // tiny's 15,000 part is under the 100,000 minimum
    expect(r.toCarry.find((s) => s.wallet === "tiny")?.amount).toBe(150_000n);
    const sent = r.toSend.reduce((acc, s) => acc + s.amount, 0n);
    // 100,150,000 in all: each of a, b, c sends 10,000,000 x 33,333,333 / 100,150,000 = 3,328,340; tiny's 14,977 part is carried whole.
    expect(sent).toBe(3n * 3_328_340n);
    expect(sent <= policy.swapMaxZats).toBe(true);
    for (const s of r.toSend) expect(s.amount + (r.toCarry.find((c) => c.wallet === s.wallet)?.amount ?? 0n)).toBe(shares.find((x) => x.wallet === s.wallet)!.amount);
  });

  test("the planner's cap leaves room for the team's delivery reserve: holders' part plus the reserve stays inside PAD_SWAP_MAX_ZATS", () => {
    for (const count of [1, 2, 50, 350, 700]) {
      const cap = shieldedSwapCap(count);
      expect(cap > 0n).toBe(true);
      const reserve = deliveryReserve({
        teamGross: 10n ** 12n, shieldedTotal: cap, shieldedCount: count,
        withdrawFeeZats: config.epoch.team.withdrawFeeZats, reserveBps: config.epoch.team.reserveBps, maxPerTx: config.epoch.maxShieldedRecipientsPerTx,
      });
      expect(cap + reserve <= config.near1click.maxSwapZats).toBe(true);
      expect(cap + reserve > config.near1click.maxSwapZats - 10_000n).toBe(true); // and not far under it
    }
  });
});
