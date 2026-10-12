// The creator-fee tier menu: the reviewed spec of every tier, and who gets what from one trade on each, with the
// program's exact rounding (src/dbc/tiers.ts quotes the source lines). The live proof that the CHAIN splits a real
// trade the same way is in test/tiers-live.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import BN from "bn.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, getExcludedFeeAmount, splitFees, type PoolFeesConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DEFAULT_TIER_BPS, REVIEWED_CONFIG, REVIEWED_TIERS, TIER_MENU_BPS, reviewedTier } from "../src/dbc/reviewed";
import { feeNumeratorOf, roundTripCostBps, splitSwapFee, tierShares, tradeSplit } from "../src/dbc/tiers";

/** 100 whole ZEC in zats: "per $100" is per 100 units of the quote asset, the unit the research table uses. */
const HUNDRED = 100n * 100_000_000n;

const EXPECTED_PER_100: Record<number, { fee: bigint; meteora: bigint; creator: bigint; partner: bigint; holders: bigint; team: bigint }> = {
  // zats out of 10,000,000,000
  100: { fee: 100_000_000n, meteora: 20_000_000n, creator: 0n, partner: 80_000_000n, holders: 10_000_000n, team: 70_000_000n },
  200: { fee: 200_000_000n, meteora: 40_000_000n, creator: 80_000_000n, partner: 80_000_000n, holders: 10_000_000n, team: 70_000_000n },
  400: { fee: 400_000_000n, meteora: 80_000_000n, creator: 240_000_000n, partner: 80_000_000n, holders: 10_000_000n, team: 70_000_000n },
  // 83% is the closest whole percent to the 83.33% that would leave exactly 0.80%: 480,000,000 x 83 / 100 = 398,400,000 creator
  600: { fee: 600_000_000n, meteora: 120_000_000n, creator: 398_400_000n, partner: 81_600_000n, holders: 10_200_000n, team: 71_400_000n },
  1000: { fee: 1_000_000_000n, meteora: 200_000_000n, creator: 720_000_000n, partner: 80_000_000n, holders: 10_000_000n, team: 70_000_000n },
};

describe("the menu", () => {
  test("is exactly 1%, 2%, 4%, 6% and 10%, and tier 1% is the config SNARKS launched on", () => {
    expect([...TIER_MENU_BPS]).toEqual([100, 200, 400, 600, 1000]);
    expect(DEFAULT_TIER_BPS).toBe(100);
    const t = REVIEWED_TIERS[100]!;
    expect([t.bps, t.creatorFeePercentage, t.migrationFeeOption, t.dammMigrationConfig, t.partnerLockedLpPercentage, t.creatorLockedLpPercentage]).toEqual([
      REVIEWED_CONFIG.feeBps, 0, REVIEWED_CONFIG.migrationFeeOption, REVIEWED_CONFIG.dammMigrationConfig, 100, 0,
    ]);
  });

  test("each tier names the DAMM v2 config the SDK's own table lists for its migration fee option (never hand-typed)", () => {
    for (const bps of TIER_MENU_BPS) {
      const t = REVIEWED_TIERS[bps]!;
      expect(DAMM_V2_MIGRATION_FEE_ADDRESS[t.migrationFeeOption]!.toBase58()).toBe(t.dammMigrationConfig);
    }
  });

  test("the graduated pool charges the fee the tier promises; 10% is the only tier that drops, to the 6% pool", () => {
    expect(TIER_MENU_BPS.map((b) => REVIEWED_TIERS[b]!.postGraduationFeeBps)).toEqual([100, 200, 400, 600, 600]);
    expect(REVIEWED_TIERS[1000]!.dammMigrationConfig).toBe(REVIEWED_TIERS[600]!.dammMigrationConfig);
    for (const b of TIER_MENU_BPS.filter((x) => x !== 1000)) expect(REVIEWED_TIERS[b]!.postGraduationFeeBps).toBe(b);
  });

  test("the LP of the graduated pool is the vault's and the creator's, all permanently locked, and mirrors the fee split", () => {
    for (const bps of TIER_MENU_BPS) {
      const t = REVIEWED_TIERS[bps]!;
      expect(t.partnerLockedLpPercentage + t.creatorLockedLpPercentage).toBe(100);
    }
    expect(TIER_MENU_BPS.map((b) => REVIEWED_TIERS[b]!.creatorLockedLpPercentage)).toEqual([0, 50, 75, 83, 83]);
    expect(TIER_MENU_BPS.map((b) => REVIEWED_TIERS[b]!.creatorFeePercentage)).toEqual([0, 50, 75, 83, 90]);
  });

  test("the vault earns the same share of volume after graduation as on the curve (0.80%; 0.816% at 6%, and at 10% once it is in the 6% pool)", () => {
    for (const bps of TIER_MENU_BPS) {
      const t = REVIEWED_TIERS[bps]!;
      const onCurve = (bps * 0.8 * (100 - t.creatorFeePercentage)) / 100; // bps of volume
      const afterGraduation = (t.postGraduationFeeBps * 0.8 * t.partnerLockedLpPercentage) / 100;
      // the 10% tier graduates into the 6% pool (17% LP): it pays the vault what the 6% tier does, 0.816%, not the 0.80% of its curve
      expect(afterGraduation).toBeCloseTo(bps === 1000 ? 81.6 : onCurve, 6);
      expect(onCurve).toBeGreaterThanOrEqual(80);
      expect(onCurve).toBeLessThan(81.7);
    }
  });

  test("a fee that is not on the menu is not a tier", () => {
    for (const bad of [0, 1, 50, 150, 300, 500, 999, 1001, 10_000, -100, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(reviewedTier(bad)).toBeNull();
    for (const bad of [0, 150, 700]) expect(() => tradeSplit(HUNDRED, bad)).toThrow(/not a reviewed fee tier/);
    expect(reviewedTier(Number("toString" as unknown as number))).toBeNull();
  });
});

describe("the exact split of a $100 trade, Meteora / creator / holders / team", () => {
  test.each(TIER_MENU_BPS.map((b) => [b]))("tier %d bps", (bps) => {
    const s = tradeSplit(HUNDRED, bps);
    const want = EXPECTED_PER_100[bps]!;
    expect({ fee: s.fee, meteora: s.meteora, creator: s.creator, partner: s.partner, holders: s.holders, team: s.team }).toEqual(want);
    // every zat is accounted for
    expect(s.meteora + s.creator + s.holders + s.team).toBe(s.fee);
  });

  test("holders get 0.10% and the team 0.70% of volume at every tier except 6%, which leaves 0.102% and 0.714%", () => {
    for (const bps of TIER_MENU_BPS) {
      const s = tradeSplit(HUNDRED, bps);
      if (bps === 600) expect([s.holders, s.team]).toEqual([10_200_000n, 71_400_000n]);
      else expect([s.holders, s.team]).toEqual([10_000_000n, 70_000_000n]);
    }
  });
});

describe("rounding, from the program source", () => {
  test("the fee rounds UP (a 1-zat trade still pays 1 zat), Meteora rounds DOWN, the creator rounds DOWN, the pad gets the remainder", () => {
    // 1 zat at 1%: ceil(0.01) = 1; Meteora floor(0.2) = 0; creator 0; partner 1
    expect(splitSwapFee(1n, feeNumeratorOf(100), 0)).toEqual({ fee: 1n, meteora: 0n, creator: 0n, partner: 1n });
    // 999 zats at 2%: fee ceil(19.98) = 20; Meteora 4; trading 16; creator floor(16 x 50%) = 8; partner 8
    expect(splitSwapFee(999n, feeNumeratorOf(200), 50)).toEqual({ fee: 20n, meteora: 4n, creator: 8n, partner: 8n });
    // 333 zats at 6%: fee ceil(19.98) = 20; Meteora 4; trading 16; creator floor(13.28) = 13; partner 3
    expect(splitSwapFee(333n, feeNumeratorOf(600), 83)).toEqual({ fee: 20n, meteora: 4n, creator: 13n, partner: 3n });
    // 7 zats at 10%: fee ceil(0.7) = 1; Meteora 0; trading 1; creator floor(0.9) = 0; the pad gets the whole zat
    expect(splitSwapFee(7n, feeNumeratorOf(1000), 90)).toEqual({ fee: 1n, meteora: 0n, creator: 0n, partner: 1n });
    // an exact multiple does not round up: 100 zats at 1% is 1, not 2
    expect(splitSwapFee(100n, feeNumeratorOf(100), 0).fee).toBe(1n);
  });

  test("the numerator is bps x 1e5 (1% = 10,000,000 of 1e9, the reviewed cliff fee)", () => {
    expect(feeNumeratorOf(100)).toBe(10_000_000n);
    expect(TIER_MENU_BPS.map((b) => feeNumeratorOf(b))).toEqual([10_000_000n, 20_000_000n, 40_000_000n, 60_000_000n, 100_000_000n]);
  });

  test("the fee and Meteora's part equal the SDK's own getExcludedFeeAmount + splitFees for 2,000 amounts per tier; the five parts always add up", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    const poolFees = {} as PoolFeesConfig;
    for (const bps of TIER_MENU_BPS) {
      const tier = REVIEWED_TIERS[bps]!;
      const numerator = new BN(feeNumeratorOf(bps).toString());
      for (let i = 0; i < 2000; i++) {
        const amount = BigInt(next()) * BigInt(1 + (i % 50_000)) + BigInt(i);
        const mine = splitSwapFee(amount, feeNumeratorOf(bps), tier.creatorFeePercentage);
        const [, tradingFee] = getExcludedFeeAmount(numerator, new BN(amount.toString()));
        const [trading, protocol] = splitFees(poolFees, tradingFee, false);
        expect(mine.fee.toString()).toBe(tradingFee.toString());
        expect(mine.meteora.toString()).toBe(protocol.toString());
        expect(mine.creator + mine.partner).toBe(BigInt(trading.toString()));
        expect(mine.meteora + mine.creator + mine.partner).toBe(mine.fee);
      }
    }
  });

  test("refuses nonsense instead of guessing", () => {
    expect(() => splitSwapFee(-1n, 1n, 0)).toThrow();
    expect(() => splitSwapFee(1n, 1n, 101)).toThrow();
    expect(() => splitSwapFee(1n, 1n, 1.5)).toThrow();
  });
});

describe("shares of the whole fee, for the copy", () => {
  test("Meteora 20% at every tier; creator, holders and team fill the rest; each tier's five numbers add to 100%", () => {
    expect(TIER_MENU_BPS.map((b) => tierShares(b))).toEqual([
      { meteoraBps: 2000, creatorBps: 0, claimedBps: 8000, holdersBps: 1000, teamBps: 7000 },
      { meteoraBps: 2000, creatorBps: 4000, claimedBps: 4000, holdersBps: 500, teamBps: 3500 },
      { meteoraBps: 2000, creatorBps: 6000, claimedBps: 2000, holdersBps: 250, teamBps: 1750 },
      { meteoraBps: 2000, creatorBps: 6640, claimedBps: 1360, holdersBps: 170, teamBps: 1190 },
      { meteoraBps: 2000, creatorBps: 7200, claimedBps: 800, holdersBps: 100, teamBps: 700 },
    ]);
    for (const b of TIER_MENU_BPS) {
      const s = tierShares(b);
      expect(s.meteoraBps + s.creatorBps + s.holdersBps + s.teamBps).toBe(10_000);
    }
  });

  test("the cost of buying and selling straight back (fee only): about 2%, 4%, 8%, 12% and 19%", () => {
    expect(TIER_MENU_BPS.map((b) => roundTripCostBps(b))).toEqual([199, 396, 784, 1164, 1900]);
  });
});

describe("dbc/reviewed.ts equals audit/CONFIG-REVIEW-TIERS.md", () => {
  const REVIEW = readFileSync(join(config.paths.repoRoot, "audit", "CONFIG-REVIEW-TIERS.md"), "utf8");
  const row = (label: string): string[] => {
    const line = REVIEW.split("\n").find((l) => l.startsWith(`| ${label}`));
    if (!line) throw new Error(`CONFIG-REVIEW-TIERS.md no longer has the row ${label}`);
    return line.split("|").slice(2, -1).map((c) => c.trim());
  };

  test("the first line is the sharp-edges marker and the review cites the module", () => {
    expect(REVIEW.split("\n")[0]).toBe('<!-- VERIFIED-INVOCATION: Skill(skill="sharp-edges:sharp-edges") on 2026-10-02 -->');
    expect(REVIEW).toContain("engine/src/dbc/reviewed.ts");
  });

  test("the five differing fields, per tier, are the numbers in the module", () => {
    const num = (c: string) => Number(c.replace(/,/g, "").split(" ")[0]);
    expect(row("`cliff_fee_numerator`").map(num)).toEqual(TIER_MENU_BPS.map((b) => Number(feeNumeratorOf(b))));
    expect(row("`creator_trading_fee_percentage`").map(num)).toEqual(TIER_MENU_BPS.map((b) => REVIEWED_TIERS[b]!.creatorFeePercentage));
    expect(row("`partner_permanent_locked_liquidity_percentage`").map(num)).toEqual(TIER_MENU_BPS.map((b) => REVIEWED_TIERS[b]!.partnerLockedLpPercentage));
    expect(row("`creator_permanent_locked_liquidity_percentage`").map(num)).toEqual(TIER_MENU_BPS.map((b) => REVIEWED_TIERS[b]!.creatorLockedLpPercentage));
    const mig = row("`migration_fee_option`");
    TIER_MENU_BPS.forEach((b, i) => {
      expect(mig[i]).toContain(REVIEWED_TIERS[b]!.dammMigrationConfig);
      expect(mig[i]!.startsWith(String(REVIEWED_TIERS[b]!.migrationFeeOption))).toBe(true);
    });
  });

  test("the per-100 table is the tradeSplit output", () => {
    for (const bps of TIER_MENU_BPS) {
      const s = tradeSplit(10_000_000_000n, bps);
      const line = REVIEW.split("\n").find((l) => l.startsWith(`| ${bps / 100}% | ${s.fee.toLocaleString("en-US")} |`));
      expect(line).toBeDefined();
      for (const v of [s.meteora, s.creator, s.partner, s.holders, s.team]) expect(line).toContain(v.toLocaleString("en-US"));
    }
  });
});
