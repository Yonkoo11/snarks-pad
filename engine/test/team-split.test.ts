// Owner policy 2026-10-12: of each claimed fee holders get 12.5% (0.10% of volume), the team 87.5%
// (0.70% of volume). The team share first pays shielded-delivery costs. These are the pure rules; the money path
// through runEpoch is in team-ledger.test.ts.
import { describe, expect, test } from "bun:test";
import { deliveryReserve, MAX_TEAM_SHARE_BPS, settleDelivery, settleWithoutSwap, splitClaim, zcashFeeEstimate } from "../src/epoch/split";
import { proRataSplit } from "../src/epoch/math";

// A small deterministic generator, so a failure reproduces.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("splitClaim: holders + team == claimed, exactly", () => {
  test("the published policy: 1% fee on 100 ZEC of volume -> Meteora 0.20, holders 0.10, team 0.70", () => {
    const volume = 100n * 100_000_000n;
    const fee = volume / 100n; // 1%
    const claimed = (fee * 80n) / 100n; // Meteora keeps 20%
    const { holders, team } = splitClaim(claimed, 8750);
    expect(holders).toBe((volume * 10n) / 10_000n); // 0.10% of volume
    expect(team).toBe((volume * 70n) / 10_000n); // 0.70% of volume
    expect(fee - claimed).toBe((volume * 20n) / 10_000n); // Meteora's 0.20%
  });

  test("exact sum for 20,000 random claims and shares, including u64 extremes and amounts too small to split", () => {
    const rnd = lcg(42);
    const U64 = 2n ** 64n - 1n;
    const claims = [0n, 1n, 2n, 3n, 4n, 5n, 7n, 99n, 100n, 101n, 9_999n, 10_000n, 10_001n, U64, U64 - 1n];
    for (let i = 0; i < 20_000; i++) claims.push(BigInt(Math.floor(rnd() * 1e15)) * BigInt(1 + Math.floor(rnd() * 1e3)));
    for (const claimed of claims) {
      const bps = Math.floor(rnd() * (MAX_TEAM_SHARE_BPS + 1));
      const { holders, team } = splitClaim(claimed, bps);
      expect(holders + team).toBe(claimed);
      expect(holders >= 0n && team >= 0n).toBe(true);
      expect(team <= (claimed * BigInt(MAX_TEAM_SHARE_BPS)) / 10_000n).toBe(true); // the cap: never more than 87.5%
    }
  });

  test("rounding goes to the holders: the team's cut is floored, so a 3-zat claim gives the team 2 and the holders 1", () => {
    expect(splitClaim(3n, 8750)).toEqual({ holders: 1n, team: 2n });
    expect(splitClaim(4n, 8750)).toEqual({ holders: 1n, team: 3n });
    expect(splitClaim(7n, 8750)).toEqual({ holders: 1n, team: 6n });
  });

  test("a split followed by a pro-rata split pays out exactly the claim, to the last zat, through the real rounding", () => {
    const rnd = lcg(7);
    for (let n = 0; n < 300; n++) {
      const claimed = BigInt(Math.floor(rnd() * 1e12)) + 1n;
      const holders = Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, i) => ({ wallet: `w${i}`, balance: BigInt(1 + Math.floor(rnd() * 1e9)) }));
      const { holders: pool, team } = splitClaim(claimed, 8750);
      const shares = proRataSplit(pool, holders);
      expect(shares.reduce((a, s) => a + s.amount, 0n) + team).toBe(claimed);
    }
  });

  test("a team share above the cap, or a non-integer, is refused", () => {
    expect(() => splitClaim(100n, MAX_TEAM_SHARE_BPS + 1)).toThrow(/teamBps/);
    expect(() => splitClaim(100n, -1)).toThrow(/teamBps/);
    expect(() => splitClaim(100n, 12.5)).toThrow(/teamBps/);
    expect(() => splitClaim(-1n, 8750)).toThrow(/claimed/);
  });
});

describe("deliveryReserve: the team reserves the delivery cost, capped at its own share", () => {
  const base = { withdrawFeeZats: 32_000n, reserveBps: 100 };

  test("covers the withdraw fee, the Zcash fee for N+1 outputs and 1% slippage when the team share is large enough", () => {
    const r = deliveryReserve({ ...base, teamGross: 1_000_000n, shieldedTotal: 2_000_000n, shieldedCount: 10 });
    expect(r).toBe(32_000n + zcashFeeEstimate(10) + 20_000n); // 32,000 + 55,000 + 20,000
  });

  test("CAP: when the team share is smaller than the cost, the reserve is the whole team share and no more", () => {
    const r = deliveryReserve({ ...base, teamGross: 40_000n, shieldedTotal: 2_000_000n, shieldedCount: 10 });
    expect(r).toBe(40_000n);
  });

  test("no shielded rows, no shielded total, or no team share -> nothing reserved", () => {
    expect(deliveryReserve({ ...base, teamGross: 1_000_000n, shieldedTotal: 0n, shieldedCount: 0 })).toBe(0n);
    expect(deliveryReserve({ ...base, teamGross: 0n, shieldedTotal: 2_000_000n, shieldedCount: 3 })).toBe(0n);
  });

  test("slippage rounds up, never down", () => {
    const r = deliveryReserve({ withdrawFeeZats: 0n, reserveBps: 100, teamGross: 10n ** 9n, shieldedTotal: 101n, shieldedCount: 1 });
    expect(r).toBe(zcashFeeEstimate(1) + 2n); // ceil(101 x 1%) = 2
  });
});

describe("settleDelivery: the rule when the swap settles", () => {
  const T = 500_000n;
  const S = 2_000_000n;
  const N = 10;
  const fee = zcashFeeEstimate(N);

  function ledgerBalances(r: bigint, out: bigint, s: ReturnType<typeof settleDelivery>) {
    // Solana ZEC in = S + r; native ZEC out = out. Where did every zat go?
    const loss = S + r - out; // what the swap kept (its fee and spread)
    expect(s.paid + fee + s.teamNative).toBe(out); // native: holders + Zcash fee + team's leftover == what the treasury received
    expect(s.paid + s.holderShortfall).toBe(S); // holders: paid + shortfall == planned
    expect(loss + fee - s.deliveryCost - s.holderShortfall).toBe(0n); // cost = swap loss + Zcash fee, split between team and holders
  }

  test("the reserve covers the cost: holders get their FULL share, the team keeps what is left as native ZEC", () => {
    const r = deliveryReserve({ teamGross: T, shieldedTotal: S, shieldedCount: N, withdrawFeeZats: 32_000n, reserveBps: 100 });
    const out = S + r - 32_000n - 5_000n; // the swap kept 37,000 (withdraw fee and a little spread)
    const s = settleDelivery({ teamGross: T, reserve: r, shieldedTotal: S, settledOut: out, networkFee: fee });
    expect(s.paid).toBe(S);
    expect(s.holderShortfall).toBe(0n);
    expect(s.deliveryCost).toBe(37_000n + fee);
    expect(s.teamNative).toBe(r - s.deliveryCost);
    expect(s.teamSolana).toBe(T - r);
    expect(s.teamSolana + s.teamNative).toBe(T - s.deliveryCost); // the team's net is its gross minus the delivery cost
    ledgerBalances(r, out, s);
  });

  test("the cost exceeds the reserve (team share smaller than the cost): the team pays all it has, holders bear the rest pro rata, nothing carries", () => {
    const smallT = 40_000n;
    const r = deliveryReserve({ teamGross: smallT, shieldedTotal: S, shieldedCount: N, withdrawFeeZats: 32_000n, reserveBps: 100 });
    expect(r).toBe(smallT);
    const out = S + r - 32_000n - 5_000n;
    const s = settleDelivery({ teamGross: smallT, reserve: r, shieldedTotal: S, settledOut: out, networkFee: fee });
    expect(s.teamNative).toBe(0n);
    expect(s.deliveryCost).toBe(smallT); // the team's whole share, never more
    expect(s.teamSolana).toBe(0n);
    expect(s.holderShortfall).toBe(37_000n + fee - smallT); // holders bear exactly the excess
    expect(s.paid).toBe(S - s.holderShortfall);
    ledgerBalances(r, out, s);
  });

  test("a swap that returns exactly the deposit and a cost of zero gives everything back to the team", () => {
    const r = 100_000n;
    const out = S + r;
    const s = settleDelivery({ teamGross: T, reserve: r, shieldedTotal: S, settledOut: out, networkFee: 0n });
    expect(s.paid).toBe(S);
    expect(s.teamNative).toBe(r);
    expect(s.deliveryCost).toBe(0n);
  });

  test("a swap output below the Zcash fee pays holders nothing and does not go negative", () => {
    const s = settleDelivery({ teamGross: T, reserve: 100_000n, shieldedTotal: S, settledOut: 1_000n, networkFee: fee });
    expect(s.paid).toBe(0n);
    expect(s.holderShortfall).toBe(S);
    expect(s.teamNative).toBe(0n);
  });

  test("random settlements: native ZEC and holder amounts always balance to the zat", () => {
    const rnd = lcg(2026);
    for (let i = 0; i < 5_000; i++) {
      const team = BigInt(Math.floor(rnd() * 2e6));
      const shielded = BigInt(1_000_000 + Math.floor(rnd() * 5e8));
      const n = 1 + Math.floor(rnd() * 300);
      const r = deliveryReserve({ teamGross: team, shieldedTotal: shielded, shieldedCount: n, withdrawFeeZats: 32_000n, reserveBps: 100 });
      expect(r <= team).toBe(true);
      const loss = BigInt(Math.floor(rnd() * 3e5));
      const out = shielded + r > loss ? shielded + r - loss : 0n;
      const f = zcashFeeEstimate(n);
      const s = settleDelivery({ teamGross: team, reserve: r, shieldedTotal: shielded, settledOut: out, networkFee: f });
      expect(s.paid + s.holderShortfall).toBe(shielded);
      expect(s.paid <= shielded).toBe(true);
      const available = out > f ? out - f : 0n;
      expect(s.paid + s.teamNative).toBe(available);
      expect(s.teamSolana).toBe(team - r);
    }
  });

  test("no swap (failed before funds moved, or refunded): the reserve was never spent, the team keeps its whole share in Solana ZEC", () => {
    expect(settleWithoutSwap(T)).toEqual({ paid: 0n, holderShortfall: 0n, teamNative: 0n, deliveryCost: 0n, teamSolana: T });
  });
});

// Stress scale run 2026-10-03 (audit/STRESS-REPORT.md scenario 1): 720 recipients were paid in 3 Ironwood transactions of
// at most 350 outputs, and the node charged 3,615,000 zats = 5,000 x (720 + 3), one change output per transaction. The
// estimate assumed ONE transaction (5,000 x 721), so the ledger's team native ZEC was 10,000 zats above what was really
// left in the treasury wallet.
describe("zcashFeeEstimate: one change output per chunk, not per batch", () => {
  test("720 recipients at 350 per transaction = 3 transactions = 5,000 x (720 + 3), the fee regtest really charged", () => {
    expect(zcashFeeEstimate(720, 350)).toBe(3_615_000n);
  });
  test("up to one chunk the estimate is unchanged: 5,000 x (N + 1)", () => {
    expect(zcashFeeEstimate(350, 350)).toBe(5000n * 351n);
    expect(zcashFeeEstimate(1, 350)).toBe(10_000n);
    expect(zcashFeeEstimate(351, 350)).toBe(5000n * 353n);
  });
  test("the reserve and the settlement use the chunked fee", () => {
    const r = deliveryReserve({ withdrawFeeZats: 32_000n, reserveBps: 100, teamGross: 10n ** 9n, shieldedTotal: 100_000_000n, shieldedCount: 720, maxPerTx: 350 });
    expect(r).toBe(32_000n + 3_615_000n + 1_000_000n);
  });
});
