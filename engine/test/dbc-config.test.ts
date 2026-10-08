// The pad's DBC config is permanent, so its parameters are pinned here and a
// created config is verified field by field (the S1 config review, by code).
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { CollectFeeMode, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenType, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { config } from "../src/config";
import { assertWindowExact, buildConfigParams, feeAfterWindow, rowFromState, verifyConfigState } from "../src/dbc/config";
import { REVIEWED_WINDOW, TIER_MENU_BPS, windowScheduleOf } from "../src/dbc/reviewed";

const { dbc } = config.solana;
const CLAIMER = new PublicKey("ANcxBq4HpuCXhZxJE2MC6QXG1gkV9NFEYMrvcttnXAcL");

/** A config exactly as the chain would return it for what buildConfigParams asks for (shape read from a real local config). `tier` picks the tier's config (default: the 1% one). */
function goodState(over: Record<string, unknown> = {}, tier?: number): PoolConfig {
  const p = buildConfigParams(tier);
  const vest = (v: typeof p.partnerLiquidityVestingInfo) => ({ isInitialized: 0, ...v });
  return {
    quoteMint: dbc.quoteMint, feeClaimer: CLAIMER, leftoverReceiver: CLAIMER,
    poolFees: { baseFee: { ...p.poolFees.baseFee }, dynamicFee: { initialized: 0 } },
    partnerLiquidityVestingInfo: vest(p.partnerLiquidityVestingInfo), creatorLiquidityVestingInfo: vest(p.creatorLiquidityVestingInfo),
    collectFeeMode: p.collectFeeMode, migrationOption: p.migrationOption, activationType: p.activationType, tokenDecimal: p.tokenDecimal,
    version: 0, tokenType: p.tokenType, quoteTokenFlag: 0,
    partnerPermanentLockedLiquidityPercentage: p.partnerPermanentLockedLiquidityPercentage, partnerLiquidityPercentage: p.partnerLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: p.creatorPermanentLockedLiquidityPercentage, creatorLiquidityPercentage: p.creatorLiquidityPercentage,
    migrationFeeOption: p.migrationFeeOption, fixedTokenSupplyFlag: 1, creatorTradingFeePercentage: p.creatorTradingFeePercentage,
    tokenUpdateAuthority: p.tokenUpdateAuthority, migrationFeePercentage: 0, creatorMigrationFeePercentage: 0,
    migrationQuoteThreshold: p.migrationQuoteThreshold, lockedVestingConfig: { ...p.lockedVesting },
    preMigrationTokenSupply: p.tokenSupply!.preMigrationTokenSupply, postMigrationTokenSupply: p.tokenSupply!.postMigrationTokenSupply,
    migratedCollectFeeMode: 0, migratedDynamicFee: 0, migratedPoolFeeBps: 0, migratedPoolBaseFeeMode: 0, enableFirstSwapWithMinFee: Number(p.enableFirstSwapWithMinFee),
    migratedCompoundingFeeBps: 0, poolCreationFee: new BN(0), sqrtStartPrice: p.sqrtStartPrice,
    // the account holds 20 curve slots; unused ones are zero
    curve: [...p.curve, ...Array.from({ length: 20 - p.curve.length }, () => ({ sqrtPrice: new BN(0), liquidity: new BN(0) }))],
    ...over,
  } as unknown as PoolConfig;
}

describe("buildConfigParams", () => {
  const p = buildConfigParams();

  test("1% pool fee after the launch window, paid in ZEC (quote token) on buys and sells, no creator cut", () => {
    expect(dbc.feeBps).toBe(100);
    // the launch window (CONFIG-REVIEW-TIERS section 5): 99% of the 1e9 denominator in the first second, 5 steps of 1 s, 196,000,000 off each: 10,000,000 = 1% at second 5
    expect(new BN(p.poolFees.baseFee.cliffFeeNumerator).toString()).toBe("990000000");
    expect([p.poolFees.baseFee.firstFactor, new BN(p.poolFees.baseFee.secondFactor).toString(), new BN(p.poolFees.baseFee.thirdFactor).toString()]).toEqual([5, "1", "196000000"]);
    expect(feeAfterWindow(p.poolFees.baseFee as unknown as Record<string, unknown>).toString()).toBe("10000000");
    expect(p.collectFeeMode).toBe(CollectFeeMode.QuoteToken);
    expect(p.creatorTradingFeePercentage).toBe(0);
  });

  test("Token-2022 base with an immutable token-update authority and no pool creation fee for coin #1", () => {
    expect(p.tokenType).toBe(TokenType.Token2022);
    expect(p.tokenUpdateAuthority).toBe(TokenAuthorityOption.Immutable);
    expect(new BN(p.poolCreationFee).toString()).toBe("0");
  });

  test("migrates to DAMM v2 with the 1% config Hv8Lmzm..., 100% of the LP the partner's and permanently locked", () => {
    expect(p.migrationOption).toBe(MigrationOption.MET_DAMM_V2);
    expect(p.migrationFeeOption).toBe(MigrationFeeOption.FixedBps100);
    expect(dbc.dammConfig.toBase58()).toBe("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp");
    expect(p.partnerPermanentLockedLiquidityPercentage).toBe(100);
    expect(p.partnerLiquidityPercentage).toBe(0);
    expect(p.creatorPermanentLockedLiquidityPercentage + p.creatorLiquidityPercentage).toBe(0);
  });

  test("the holder share of the fee is 80% (Meteora keeps 20%)", () => {
    expect(dbc.holderShareBps).toBe(8000);
  });
});

describe("verifyConfigState", () => {
  test("a config that matches the builder passes", () => {
    expect(verifyConfigState(goodState(), CLAIMER)).toEqual([]);
  });

  test.each([
    ["a different fee claimer", { feeClaimer: new PublicKey("11111111111111111111111111111112") }, /fee claimer/],
    ["a leftover receiver that is not the fee claimer", { leftoverReceiver: new PublicKey("11111111111111111111111111111112") }, /leftover receiver/],
    ["a 2% fee after the window", { poolFees: { baseFee: { ...buildConfigParams(200).poolFees.baseFee }, dynamicFee: { initialized: 0 } } }, /fee after the launch window, bps/],
    ["a flat 1% fee with no launch window (a config made before the window)", { poolFees: { baseFee: { ...buildConfigParams().poolFees.baseFee, cliffFeeNumerator: new BN(10_000_000), firstFactor: 0, secondFactor: new BN(0), thirdFactor: new BN(0) }, dynamicFee: { initialized: 0 } } }, /launch window first fee/],
    ["a launch window that starts at 50% instead of 99%", { poolFees: { baseFee: { ...buildConfigParams().poolFees.baseFee, cliffFeeNumerator: new BN(500_000_000), thirdFactor: new BN(98_000_000) }, dynamicFee: { initialized: 0 } } }, /launch window first fee/],
    ["a window of 5 steps of 2 seconds instead of 1", { poolFees: { baseFee: { ...buildConfigParams().poolFees.baseFee, secondFactor: new BN(2) }, dynamicFee: { initialized: 0 } } }, /seconds per step/],
    ["a window of 12 steps that ends above the tier's fee (the F-038 draft: 1.0000004%)", { poolFees: { baseFee: { ...buildConfigParams().poolFees.baseFee, firstFactor: 12, secondFactor: new BN(5), thirdFactor: new BN(81_666_666) }, dynamicFee: { initialized: 0 } } }, /fee after the launch window, numerator/],
    ["fees collected in the output token", { collectFeeMode: CollectFeeMode.OutputToken }, /collect fee mode/],
    ["a creator trading-fee cut", { creatorTradingFeePercentage: 10 }, /creator trading fee/],
    ["an upgradable token-update authority", { tokenUpdateAuthority: TokenAuthorityOption.CreatorUpdateAuthority }, /token update authority/],
    ["a partner LP that is not fully locked", { partnerPermanentLockedLiquidityPercentage: 50 }, /locked LP/],
    ["the 0.25% DAMM config", { migrationFeeOption: MigrationFeeOption.FixedBps25 }, /migration fee option/],
    ["a pool creation fee", { poolCreationFee: new BN(1_000_000) }, /pool creation fee/],
    // S1-H1 (audit/CONFIG-REVIEW.md): fields the first version of this check did not read
    ["a longer fee schedule than the reviewed window", { poolFees: { baseFee: { ...buildConfigParams().poolFees.baseFee, firstFactor: 10, secondFactor: new BN(60) }, dynamicFee: { initialized: 0 } } }, /launch window steps/],
    ["a dynamic (volatility) fee on top of the 1%", { poolFees: { baseFee: { ...buildConfigParams().poolFees.baseFee }, dynamicFee: { initialized: 1 } } }, /dynamic fee/],
    ["a different migration threshold", { migrationQuoteThreshold: new BN(1) }, /migration quote threshold/],
    ["a different start price", { sqrtStartPrice: new BN(1) }, /sqrt start price/],
    ["a different curve", { curve: [{ sqrtPrice: new BN(5), liquidity: new BN(5) }] }, /curve/],
    ["base-token vesting to the creator", { lockedVestingConfig: { ...buildConfigParams().lockedVesting, cliffUnlockAmount: new BN(1_000_000) } }, /locked base-token vesting cliffUnlockAmount/],
    ["a migration fee taken from the quote at graduation", { migrationFeePercentage: 10, creatorMigrationFeePercentage: 50 }, /migration fee percentage/],
    ["creator LP vesting", { creatorLiquidityVestingInfo: { isInitialized: 1, vestingPercentage: 10, bpsPerPeriod: 0, numberOfPeriods: 0, cliffDurationFromMigrationTime: 0, frequency: 0 } }, /creator LP vesting/],
    ["9-decimal base token", { tokenDecimal: 9 }, /base token decimals/],
    ["slot-based activation", { activationType: 0 }, /activation type/],
    ["a different total supply", { preMigrationTokenSupply: new BN(1) }, /pre-migration token supply/],
    ["a launcher's first buy that pays the 99% (the flag is off)", { enableFirstSwapWithMinFee: 0 }, /first swap with min fee/],
    ["a Token-2022 quote", { quoteTokenFlag: 1 }, /quote token flag/],
  ])("refuses %s", (_label, over, pattern) => {
    const problems = verifyConfigState(goodState(over as Record<string, unknown>), CLAIMER);
    expect(problems.some((m) => pattern.test(m))).toBe(true);
  });

  test("a config for a different quote mint is refused", () => {
    const wrong = goodState({ quoteMint: new PublicKey("So11111111111111111111111111111111111111112") });
    expect(verifyConfigState(wrong, CLAIMER).some((m) => /quote mint/.test(m))).toBe(true);
  });
});

describe("the reviewed mainnet values (audit/CONFIG-REVIEW.md); changing any of them needs a new S1 review", () => {
  test("the builder still produces exactly the values S1 reviewed", () => {
    const p = buildConfigParams();
    expect(new BN(p.migrationQuoteThreshold).toString()).toBe("666666666"); // 6.67 ZEC
    expect(new BN(p.sqrtStartPrice).toString()).toBe("13043821027047436");
    expect(p.curve.map((c) => [new BN(c.sqrtPrice).toString(), new BN(c.liquidity).toString()])).toEqual([
      ["26087635650665564", "17391761352005868380800437509798"],
      ["79226673521066979257578248091", "2863359401554164099987362"],
    ]);
    expect(new BN(p.tokenSupply!.preMigrationTokenSupply).toString()).toBe("1000000000000000");
    expect(new BN(p.tokenSupply!.postMigrationTokenSupply).toString()).toBe("1000000000000000");
    expect([p.tokenDecimal, p.activationType, p.poolFees.baseFee.baseFeeMode, p.poolFees.baseFee.firstFactor]).toEqual([6, 1, 0, 5]);
    expect(p.poolFees.dynamicFee).toBeNull();
    expect(p.enableFirstSwapWithMinFee).toBe(true); // the launcher's own first buy pays the tier fee (the window's one exemption)
    expect(p.migratedPoolFee).toEqual({ collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 });
  });
});

describe("the launch window of every tier (CONFIG-REVIEW-TIERS section 5)", () => {
  // The five tiers' fee numerators and what the window takes off each step: (990,000,000 - tier) / 5, a whole number every time.
  const REDUCTION: Record<number, bigint> = { 100: 196_000_000n, 200: 194_000_000n, 400: 190_000_000n, 600: 186_000_000n, 1000: 178_000_000n };

  test("the reviewed window is 99% -> the tier's fee in 5 steps of 1 second, with the launcher's own first buy exempt", () => {
    expect({ ...REVIEWED_WINDOW }).toEqual({ startBps: 9900, periods: 5, periodSeconds: 1, firstSwapWithMinFee: true });
  });

  test.each([...TIER_MENU_BPS])("tier %i bps: (990,000,000 - tier) / 5 is a whole number and the window ends exactly on the tier's fee", (bps) => {
    const w = windowScheduleOf(bps);
    const tierNumerator = BigInt(bps) * 100_000n;
    expect((990_000_000n - tierNumerator) % 5n).toBe(0n);
    expect(w.reductionFactor).toBe(REDUCTION[bps]!);
    expect(w.cliffNumerator - 5n * w.reductionFactor).toBe(tierNumerator);
    expect(w.feeByPeriodBps.length).toBe(6);
    expect(w.feeByPeriodBps[0]).toBe(9900);
    expect(w.feeByPeriodBps[5]).toBe(bps);
    expect(w.durationSeconds).toBe(5);
  });

  test.each([...TIER_MENU_BPS])("tier %i bps: the SDK serializes exactly the reviewed numbers, and the fee after the window is the tier's to the unit", (bps) => {
    const p = buildConfigParams(bps);
    const b = p.poolFees.baseFee;
    expect([b.cliffFeeNumerator.toString(), b.firstFactor, b.secondFactor.toString(), b.thirdFactor.toString(), b.baseFeeMode]).toEqual(["990000000", 5, "1", REDUCTION[bps]!.toString(), 0]);
    expect(feeAfterWindow(b as unknown as Record<string, unknown>).toString()).toBe((BigInt(bps) * 100_000n).toString());
    expect(() => assertWindowExact(bps, p)).not.toThrow();
    expect(p.enableFirstSwapWithMinFee).toBe(true);
    expect(new BN(p.migrationQuoteThreshold).toString()).toBe("666666666"); // the window changed no curve number
  });

  test("a fee that is not a whole bps, below the 0.25% floor or at the cliff has no window", () => {
    for (const bad of [24, 0, 9900, 12_000, 150.5, Number.NaN]) expect(() => windowScheduleOf(bad)).toThrow(/launch window/);
  });

  test("the guard catches what it exists for: an SDK that rounded the reduction (12 periods) or changed a field", () => {
    const p = buildConfigParams(100);
    const off = { ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, thirdFactor: new BN(195_999_999) } } };
    expect(() => assertWindowExact(100, off)).toThrow(/reviewed window/);
  });

  test("a config row carries the fee AFTER the window as its id, never the 99% cliff, so a recorded config maps to its tier", () => {
    for (const bps of TIER_MENU_BPS) expect(rowFromState(new PublicKey("11111111111111111111111111111112"), goodState({}, bps)).feeBps).toBe(bps);
  });

  test("a good state of each tier passes for its own tier and is refused for every other", () => {
    for (const bps of TIER_MENU_BPS) {
      expect(verifyConfigState(goodState({}, bps), CLAIMER, bps)).toEqual([]);
      for (const other of TIER_MENU_BPS.filter((t) => t !== bps)) expect(verifyConfigState(goodState({}, bps), CLAIMER, other).length).toBeGreaterThan(0);
    }
  });
});
