// The values of the pad's permanent Meteora config and of its Squads multisig,
// exactly as audit/CONFIG-REVIEW.md (pass S1) reviewed them. This is the ONE
// place they live: src/config.ts takes its defaults from here, the config
// builder (dbc/config.ts) is fed by config.ts, the creation tools
// (dbc/createConfig.ts, dbc/createMultisig.ts) print and send what the builder
// makes, and test/config-create.test.ts asserts these constants equal the
// numbers written in CONFIG-REVIEW.md. Changing any value here needs a new S1
// review, because a created config can never be edited.
//
// Imports nothing from the engine (config.ts imports this file).
import { MigrationFeeOption } from "@meteora-ag/dynamic-bonding-curve-sdk";

export const REVIEWED_CONFIG = Object.freeze({
  /**
   * The 1% tier's fee on the bonding curve once the launch window has closed, in basis points (CONFIG-REVIEW section 4: pool_fees.base_fee; since
   * 2026-10-05 the fee scheduler's ENDING fee, audit/CONFIG-REVIEW-TIERS.md section 5). It is the tier's id and what every trade pays after the window.
   */
  feeBps: 100,
  /** Of every fee, the share that is claimed and paid to holders; Meteora keeps the other 20%. */
  holderShareBps: 8000,
  /** Market cap at launch and at graduation, whole ZEC (section 3: 5 ZEC and 20 ZEC). */
  initialMarketCapZec: 5,
  migrationMarketCapZec: 20,
  /** Whole tokens, fixed supply (section 4: token_supply). */
  totalSupply: 1_000_000_000,
  baseDecimals: 6,
  quoteDecimals: 8,
  /** DAMM v2 config the graduated pool uses: option 2 = FixedBps100 -> Hv8Lmzm... (section 4: migration_fee_option). */
  migrationFeeOption: MigrationFeeOption.FixedBps100,
  dammMigrationConfig: "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  /** Solana ZEC (section 4: quote_mint). */
  quoteMintMainnet: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
  /**
   * After graduation the DAMM v2 pool fee is not flat (S1-M1): 1% rising to about this much in volatile
   * trading, from the dynamic-fee fields of the mainnet config Hv8Lmzm... Used by the copy.
   */
  postGraduationFeeMaxBps: 120,
});

/**
 * The launch window ("snipe tax") every tier config carries: the DBC base-fee scheduler in linear mode. The fee is `startBps` in the pool's first period and falls by the same step every period
 * until it reaches the tier's own fee, which it then keeps for the life of the curve. The pool is created in the launch transaction, so the window
 * starts there. Timing is in SECONDS: the config's activation type is Timestamp, so the program counts `period_frequency` in unix seconds.
 * `firstSwapWithMinFee`: the launcher's own first buy, inside the launch transaction, pays the ending fee and not `startBps` (program rule
 * process_swap.rs:214-220: flag on, no swap yet, the initialize-pool instruction in the same transaction with no CPI); anyone else's buy in the window pays the
 * period's fee, which goes where every fee goes. Changing any value here needs a new S1 review: a created config can never be edited.
 */
export const REVIEWED_WINDOW = Object.freeze({
  /** The fee in the first period, in bps: the program's maximum (MAX_FEE_NUMERATOR 990,000,000 of 1e9). */
  startBps: 9900,
  /** How many steps the fee falls in; after the last one the fee is the tier's. */
  periods: 5,
  /** Seconds per step (Timestamp activation). */
  periodSeconds: 1,
  /** The launcher's own first buy in the launch transaction pays the tier's fee. */
  firstSwapWithMinFee: true,
});

const FEE_DENOMINATOR = 1_000_000_000n;
const BPS_DENOMINATOR = 10_000n;

/** A tier's window in the program's own numbers (fee numerators out of 1e9) and in bps. Pure integer arithmetic. */
export interface WindowSchedule {
  cliffNumerator: bigint;
  endNumerator: bigint;
  /** Taken off the fee at the end of every period (the config's `third_factor`); exact, never rounded. */
  reductionFactor: bigint;
  periods: number;
  periodSeconds: number;
  /** periods x periodSeconds: how long the window lasts. */
  durationSeconds: number;
  cliffBps: number;
  endBps: number;
  /** The fee of period 0, 1, ... `periods`, in bps: what a buy in that second of the window pays. The last one is the tier's fee. */
  feeByPeriodBps: number[];
  firstSwapWithMinFee: boolean;
}

/**
 * The window of a tier whose fee after it is `endBps`. Refuses (throws) unless the step is a whole number of fee-numerator units: the program stores
 * `floor((cliff - end) / periods)` and the fee after the last period is `cliff - periods x step`, so a step that does not divide leaves the fee after the
 * window above the tier's fee (F-038: 12 periods ended at 1.0000004%). With the reviewed 99% and 5 periods every whole-bps tier is exact:
 * (990,000,000 - bps x 100,000) / 5 is 196M, 194M, 190M, 186M and 178M for 1, 2, 4, 6 and 10%.
 */
export function windowScheduleOf(endBps: number): WindowSchedule {
  const w = REVIEWED_WINDOW;
  if (!Number.isInteger(endBps) || endBps < 25 || endBps >= w.startBps) throw new Error(`a launch window ends on a whole-bps fee of 25 to ${w.startBps - 1}; got ${endBps}`);
  const cliffNumerator = (BigInt(w.startBps) * FEE_DENOMINATOR) / BPS_DENOMINATOR;
  const endNumerator = (BigInt(endBps) * FEE_DENOMINATOR) / BPS_DENOMINATOR;
  const drop = cliffNumerator - endNumerator;
  if (drop % BigInt(w.periods) !== 0n) throw new Error(`the ${endBps} bps window does not end exactly on its fee: (${cliffNumerator} - ${endNumerator}) is not divisible by ${w.periods}`);
  const reductionFactor = drop / BigInt(w.periods);
  const feeByPeriodBps = Array.from({ length: w.periods + 1 }, (_, k) => Number(((cliffNumerator - BigInt(k) * reductionFactor) * BPS_DENOMINATOR) / FEE_DENOMINATOR));
  if (cliffNumerator - BigInt(w.periods) * reductionFactor !== endNumerator || feeByPeriodBps[w.periods] !== endBps) throw new Error(`the ${endBps} bps window does not end on its fee`);
  return {
    cliffNumerator, endNumerator, reductionFactor, periods: w.periods, periodSeconds: w.periodSeconds, durationSeconds: w.periods * w.periodSeconds,
    cliffBps: w.startBps, endBps, feeByPeriodBps, firstSwapWithMinFee: w.firstSwapWithMinFee,
  };
}

/**
 * The creator-fee tier menu (audit/CONFIG-REVIEW-TIERS.md, S1-delta). Each tier is ONE
 * permanent DBC config derived from the SNARKS 1% one above. Only these fields differ from it (the curve, supply, quote mint,
 * custody, the launch window's cliff, steps and length, and everything else are identical): the fee after the launch window (which fixes the
 * window's per-step reduction), `creator_trading_fee_percentage`, the DAMM v2 migration fee option (which names the DAMM v2 config), and the
 * partner / creator split of the graduated LP (all of it permanently locked).
 *
 * `creatorFeePercentage` is a SHARE of what is left after Meteora's 20%, rounded down (DBC state/config.rs:1014-1033), so it is
 * chosen to leave the vault 0.80% of every trade at every tier: 0.8 x fee x (100 - pct) / 100. That keeps holders at 0.60% and the
 * team at 0.20% (the 75/25 policy of the epoch engine), except 6% where a whole-number percentage cannot be exact (83 leaves
 * 0.816%: holders 0.612%, team 0.204%). The LP split after graduation uses the same percentages, so the vault earns the same
 * share of the graduated pool's fee. The tier id is its curve fee in bps. Changing any value needs a new S1 review.
 */
export interface ReviewedTier {
  /** The flat fee on the bonding curve, in bps: also the tier's id. */
  readonly bps: number;
  /** Share of the fee left after Meteora's 20% that the pool's creator claims (whole percent, `creator_trading_fee_percentage`). */
  readonly creatorFeePercentage: number;
  /** DAMM v2 fee option the graduated pool uses, and the mainnet config account it names (checked against the SDK table in the tests). */
  readonly migrationFeeOption: MigrationFeeOption;
  readonly dammMigrationConfig: string;
  /** Permanently locked LP of the graduated pool, in percent: the vault's and the creator's (they total 100). */
  readonly partnerLockedLpPercentage: number;
  readonly creatorLockedLpPercentage: number;
  /** The fee the graduated DAMM v2 pool charges before its dynamic part, in bps (the 10% tier drops to the 6% pool). */
  readonly postGraduationFeeBps: number;
}

/** The tier SNARKS itself launched on: the config of CONFIG-REVIEW.md, no creator share. */
export const DEFAULT_TIER_BPS = 100;

export const REVIEWED_TIERS: Readonly<Record<number, ReviewedTier>> = Object.freeze({
  100: {
    bps: REVIEWED_CONFIG.feeBps, creatorFeePercentage: 0, migrationFeeOption: REVIEWED_CONFIG.migrationFeeOption,
    dammMigrationConfig: REVIEWED_CONFIG.dammMigrationConfig, partnerLockedLpPercentage: 100, creatorLockedLpPercentage: 0, postGraduationFeeBps: 100,
  },
  200: {
    bps: 200, creatorFeePercentage: 50, migrationFeeOption: MigrationFeeOption.FixedBps200,
    dammMigrationConfig: "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq", partnerLockedLpPercentage: 50, creatorLockedLpPercentage: 50, postGraduationFeeBps: 200,
  },
  400: {
    bps: 400, creatorFeePercentage: 75, migrationFeeOption: MigrationFeeOption.FixedBps400,
    dammMigrationConfig: "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD", partnerLockedLpPercentage: 25, creatorLockedLpPercentage: 75, postGraduationFeeBps: 400,
  },
  600: {
    bps: 600, creatorFeePercentage: 83, migrationFeeOption: MigrationFeeOption.FixedBps600,
    dammMigrationConfig: "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u", partnerLockedLpPercentage: 17, creatorLockedLpPercentage: 83, postGraduationFeeBps: 600,
  },
  // 10% on the curve only: Meteora has no fixed 10% DAMM v2 pool, so it graduates into the 6% one (copy says so).
  1000: {
    bps: 1000, creatorFeePercentage: 90, migrationFeeOption: MigrationFeeOption.FixedBps600,
    dammMigrationConfig: "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u", partnerLockedLpPercentage: 17, creatorLockedLpPercentage: 83, postGraduationFeeBps: 600,
  },
});

export const TIER_MENU_BPS: readonly number[] = Object.freeze(Object.keys(REVIEWED_TIERS).map(Number).sort((a, b) => a - b));

/** The reviewed tier with this id, or null: a fee that is not on the menu is never a tier. */
export function reviewedTier(bps: number): ReviewedTier | null {
  return Number.isInteger(bps) ? (REVIEWED_TIERS[bps] ?? null) : null;
}

/**
 * What buildConfigParams() serializes for the 1% tier with the values above (CONFIG-REVIEW section 3, run 2026-10-01; the base fee since the launch
 * window of 2026-10-05, CONFIG-REVIEW-TIERS section 5): a cliff of 99%, 5 periods of 1 second, a reduction of 196,000,000 per period (down to 10,000,000 = 1%).
 */
export const REVIEWED_SERIALIZED: Readonly<{
  cliffFeeNumerator: string;
  firstFactor: number;
  secondFactor: string;
  thirdFactor: string;
  migrationQuoteThreshold: string;
  sqrtStartPrice: string;
  tokenSupplyRaw: string;
  curve: readonly { sqrtPrice: string; liquidity: string }[];
}> = Object.freeze({
  cliffFeeNumerator: "990000000",
  firstFactor: 5,
  secondFactor: "1",
  thirdFactor: "196000000",
  migrationQuoteThreshold: "666666666",
  sqrtStartPrice: "13043821027047436",
  tokenSupplyRaw: "1000000000000000",
  curve: [
    { sqrtPrice: "26087635650665564", liquidity: "17391761352005868380800437509798" },
    { sqrtPrice: "79226673521066979257578248091", liquidity: "2863359401554164099987362" },
  ],
});

/** The Squads v4 multisig of CONFIG-REVIEW section 5 (members: owner, backup, keeper; the vault is the config's fee claimer). */
export const REVIEWED_MULTISIG = Object.freeze({
  memberCount: 3,
  threshold: 2,
  timeLock: 0,
  /** Config authority none = autonomous: no single key can change members. */
  vaultIndex: 0,
});

/** The environment variables that would change a permanent value: refused on mainnet (CONFIG-REVIEW S1-L2). */
export const PERMANENT_VALUE_ENV_VARS = ["DBC_FEE_BPS", "DBC_INITIAL_MCAP_ZEC", "DBC_MIGRATION_MCAP_ZEC"] as const;
