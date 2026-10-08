// The pad's Meteora DBC config: ONE account per fee claimer, created once,
// permanent (fee_claimer, fee and migration target cannot change afterwards;
// plan 4 "Key custody"). `buildConfigParams` is the single place its parameters
// live, and `verifyConfigState` reads a created config back and compares every
// field that matters against them (the S1 config review, run by code).
//
// NOTHING in this file may sign, pay or load a secret key: the HTTP API
// imports it (INV-17). Creating a config is dbc/setup.ts, keeper-side only.
import { PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DammV2DynamicFeeMode, MigratedCollectFeeMode, MigrationOption,
  TokenAuthorityOption, TokenDecimal, TokenType, buildCurveWithMarketCap, feeNumeratorToBps, getFeeSchedulerMinBaseFeeNumerator,
  DAMM_V2_MIGRATION_FEE_ADDRESS, type ConfigParameters, type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { config } from "../config";
import { getConnection, getDbcClient } from "../solana";
import * as db from "../db";
import type { DbcConfigRow } from "../db";
import { KEEPER_PUBKEY_META } from "../holders";
import { DEFAULT_TIER_BPS, REVIEWED_MULTISIG, REVIEWED_WINDOW, reviewedTier, windowScheduleOf, type ReviewedTier } from "./reviewed";

const { dbc } = config.solana;

/** The reviewed spec of `tierBps`, or a refusal: a config is only ever built or accepted for a fee on the menu. */
export function requireTier(tierBps: number): ReviewedTier {
  const tier = reviewedTier(tierBps);
  if (!tier) throw new Error(`${tierBps} bps is not a reviewed fee tier (audit/CONFIG-REVIEW-TIERS.md)`);
  return tier;
}

/**
 * The fee a tier's config charges once its launch window has closed, in bps: the tier's id. The default tier (the SNARKS 1% config) reads it from
 * the runtime config, which equals the reviewed value unless an env override is set outside mainnet (src/config.ts); every other tier is its reviewed number.
 */
function curveFeeBps(tierBps: number): number {
  return tierBps === DEFAULT_TIER_BPS ? dbc.feeBps : requireTier(tierBps).bps;
}

/**
 * The SDK's own serialization of a tier's launch window must equal the reviewed numbers to the unit (windowScheduleOf is exact by construction): a
 * reduction that did not divide would leave the fee after the window above the tier's fee (F-038). Throws before anything is created.
 */
export function assertWindowExact(feeBps: number, params: ConfigParameters): void {
  const w = windowScheduleOf(feeBps);
  const b = params.poolFees.baseFee;
  const got = [b.cliffFeeNumerator.toString(), String(b.firstFactor), b.secondFactor.toString(), b.thirdFactor.toString(), String(b.baseFeeMode)];
  const want = [w.cliffNumerator.toString(), String(w.periods), String(w.periodSeconds), w.reductionFactor.toString(), String(BaseFeeMode.FeeSchedulerLinear)];
  if (got.join(",") !== want.join(",")) throw new Error(`the SDK serialized the ${feeBps} bps launch window as ${got.join(",")}; the reviewed window is ${want.join(",")}`);
  const ends = BigInt(getFeeSchedulerMinBaseFeeNumerator(b.cliffFeeNumerator, b.firstFactor, b.thirdFactor, b.baseFeeMode).toString());
  if (ends !== w.endNumerator) throw new Error(`the ${feeBps} bps window ends on numerator ${ends}, not ${w.endNumerator}`);
}

/** The exact curve + launch window + fee + migration parameters of the config of tier `tierBps` (default: SNARKS 1%). Pure: no chain access. */
export function buildConfigParams(tierBps: number = DEFAULT_TIER_BPS): ConfigParameters {
  const tier = requireTier(tierBps);
  const feeBps = curveFeeBps(tierBps);
  const window = windowScheduleOf(feeBps);
  const params = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: dbc.baseDecimals as TokenDecimal,
      tokenQuoteDecimal: dbc.quoteDecimals as TokenDecimal,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: dbc.totalSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        // the launch window: 99% in the first period, down to the tier's fee in `periods` equal steps of `periodSeconds` (REVIEWED_WINDOW)
        feeSchedulerParam: { startingFeeBps: window.cliffBps, endingFeeBps: feeBps, numberOfPeriod: window.periods, totalDuration: window.durationSeconds },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees accrue in ZEC on buys AND sells
      creatorTradingFeePercentage: tier.creatorFeePercentage, // 0 on SNARKS: holders take it all; a share of the fee left after Meteora's 20% on the other tiers
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: REVIEWED_WINDOW.firstSwapWithMinFee, // the launcher's own first buy, inside the launch transaction, pays the tier's fee
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: tierBps === DEFAULT_TIER_BPS ? dbc.migrationFeeOption : tier.migrationFeeOption,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 0 },
    },
    liquidityDistribution: {
      // All of the graduated LP stays permanently locked: the vault's share and (tiers above 1%) the creator's, which is what lets a
      // creator keep collecting the pool's fee after graduation. Neither can ever pull liquidity out.
      partnerPermanentLockedLiquidityPercentage: tier.partnerLockedLpPercentage,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: tier.creatorLockedLpPercentage,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: dbc.initialMarketCapZec,
    migrationMarketCap: dbc.migrationMarketCapZec,
  });
  assertWindowExact(feeBps, params);
  return params;
}

type Expect = (label: string, got: unknown, want: unknown) => void;
type Rec = Record<string, unknown>;

/** A stored number as a BN, or 0 for anything that is not one (a malformed field reads as a mismatch below, never as an exception). */
const bnOf = (v: unknown): BN => (/^\d+$/.test(String(v)) ? new BN(String(v)) : new BN(0));

/**
 * The fee a config charges after its launch window, as a fee numerator: the scheduler's minimum (the cliff itself for a flat fee). A state whose fields cannot
 * be a scheduler at all (the program would never store one) gives 0, which the comparison with the tier's fee then reports.
 */
export function feeAfterWindow(base: Rec): BN {
  try {
    return getFeeSchedulerMinBaseFeeNumerator(bnOf(base.cliffFeeNumerator), Number(base.firstFactor) || 0, bnOf(base.thirdFactor), Number(base.baseFeeMode) || 0);
  } catch {
    return new BN(0);
  }
}

function checkFees(s: Rec, p: ConfigParameters, tierBps: number, expect: Expect): void {
  const fees = s.poolFees as Rec;
  const base = fees.baseFee as Rec;
  const pb = p.poolFees.baseFee as unknown as Rec;
  const wantBps = curveFeeBps(tierBps);
  const toBps = (n: BN) => feeNumeratorToBps(n as PoolConfig["poolFees"]["baseFee"]["cliffFeeNumerator"]);
  expect("launch window first fee, bps (the cliff)", toBps(base.cliffFeeNumerator as BN), REVIEWED_WINDOW.startBps);
  expect("base fee cliff numerator", base.cliffFeeNumerator, pb.cliffFeeNumerator);
  expect("base fee mode (0 = linear scheduler)", base.baseFeeMode, pb.baseFeeMode);
  expect("launch window steps (firstFactor)", base.firstFactor, pb.firstFactor);
  expect("launch window seconds per step (secondFactor, seconds under Timestamp activation)", base.secondFactor, pb.secondFactor);
  expect("launch window reduction per step (thirdFactor)", base.thirdFactor, pb.thirdFactor);
  const ends = feeAfterWindow(base);
  expect("fee after the launch window, bps", toBps(ends), wantBps);
  expect("fee after the launch window, numerator (exact, no rounding left over)", ends.toString(), windowScheduleOf(wantBps).endNumerator.toString());
  expect("dynamic fee initialized (must be off)", (fees.dynamicFee as Rec | undefined)?.initialized ?? 0, p.poolFees.dynamicFee ? 1 : 0);
  expect("collect fee mode (0 = quote token)", s.collectFeeMode, CollectFeeMode.QuoteToken);
  expect("creator trading fee percentage", s.creatorTradingFeePercentage, requireTier(tierBps).creatorFeePercentage);
  expect("first swap with min fee (1 = the launcher's own first buy pays the tier fee)", Number(s.enableFirstSwapWithMinFee), Number(p.enableFirstSwapWithMinFee));
  expect("pool creation fee", String(s.poolCreationFee), "0");
}

function checkMigration(s: Rec, p: ConfigParameters, tierBps: number, expect: Expect): void {
  const tier = requireTier(tierBps);
  expect("migration option (1 = DAMM v2)", s.migrationOption, MigrationOption.MET_DAMM_V2);
  expect("migration fee option", s.migrationFeeOption, tierBps === DEFAULT_TIER_BPS ? dbc.migrationFeeOption : tier.migrationFeeOption);
  expect("migration fee percentage (quote taken at migration)", s.migrationFeePercentage, p.migrationFee.feePercentage);
  expect("creator share of the migration fee", s.creatorMigrationFeePercentage, p.migrationFee.creatorFeePercentage);
  expect("migration quote threshold (raw quote units)", s.migrationQuoteThreshold, p.migrationQuoteThreshold);
  expect("migrated pool collect fee mode", s.migratedCollectFeeMode, p.migratedPoolFee.collectFeeMode);
  expect("migrated pool dynamic fee", s.migratedDynamicFee, p.migratedPoolFee.dynamicFee);
  expect("migrated pool fee bps", s.migratedPoolFeeBps, p.migratedPoolFee.poolFeeBps);
  expect("migrated pool base fee mode", s.migratedPoolBaseFeeMode, p.migratedPoolBaseFeeMode);
  expect("migrated compounding fee bps", s.migratedCompoundingFeeBps, p.compoundingFeeBps);
}

function checkLiquidity(s: Rec, p: ConfigParameters, tierBps: number, expect: Expect): void {
  const tier = requireTier(tierBps);
  expect("partner permanently locked LP percentage", s.partnerPermanentLockedLiquidityPercentage, tier.partnerLockedLpPercentage);
  expect("creator permanently locked LP percentage (reviewed)", s.creatorPermanentLockedLiquidityPercentage, tier.creatorLockedLpPercentage);
  expect("partner unlocked LP percentage", s.partnerLiquidityPercentage, p.partnerLiquidityPercentage);
  expect("creator permanently locked LP percentage", s.creatorPermanentLockedLiquidityPercentage, p.creatorPermanentLockedLiquidityPercentage);
  expect("creator unlocked LP percentage", s.creatorLiquidityPercentage, p.creatorLiquidityPercentage);
  for (const who of ["partner", "creator"] as const) {
    const v = (s[`${who}LiquidityVestingInfo`] ?? {}) as Rec;
    const pv = p[`${who}LiquidityVestingInfo`] as unknown as Rec;
    expect(`${who} LP vesting initialized`, v.isInitialized ?? 0, Number(pv.vestingPercentage) > 0 ? 1 : 0);
    for (const f of ["vestingPercentage", "bpsPerPeriod", "numberOfPeriods", "cliffDurationFromMigrationTime", "frequency"]) expect(`${who} LP vesting ${f}`, v[f], pv[f]);
  }
  const lv = (s.lockedVestingConfig ?? {}) as Rec;
  for (const f of ["amountPerPeriod", "cliffDurationFromMigrationTime", "frequency", "numberOfPeriod", "cliffUnlockAmount"]) {
    expect(`locked base-token vesting ${f} (non-zero = tokens vested to the creator)`, lv[f], (p.lockedVesting as unknown as Rec)[f]);
  }
}

function checkTokenAndCurve(s: Rec, p: ConfigParameters, expect: Expect): void {
  expect("base token type (1 = Token-2022)", s.tokenType, TokenType.Token2022);
  expect("quote token flag (0 = classic SPL quote)", s.quoteTokenFlag, 0);
  expect("base token decimals", s.tokenDecimal, p.tokenDecimal);
  expect("activation type", s.activationType, p.activationType);
  expect("token update authority (1 = immutable)", s.tokenUpdateAuthority, TokenAuthorityOption.Immutable);
  expect("fixed token supply flag", s.fixedTokenSupplyFlag, p.tokenSupply ? 1 : 0);
  expect("pre-migration token supply", s.preMigrationTokenSupply, p.tokenSupply?.preMigrationTokenSupply ?? 0);
  expect("post-migration token supply", s.postMigrationTokenSupply, p.tokenSupply?.postMigrationTokenSupply ?? 0);
  expect("sqrt start price", s.sqrtStartPrice, p.sqrtStartPrice);
  const curve = ((s.curve ?? []) as Rec[]).filter((c) => String(c.sqrtPrice) !== "0");
  expect("curve point count", curve.length, p.curve.length);
  p.curve.forEach((c, i) => {
    expect(`curve[${i}] sqrt price`, curve[i]?.sqrtPrice, c.sqrtPrice);
    expect(`curve[${i}] liquidity`, curve[i]?.liquidity, c.liquidity);
  });
}

/**
 * Every mismatch between an on-chain config and what this pad requires; empty = the config is acceptable.
 * Compares EVERY stored field the program writes in `PoolConfig::init` (DBC state/config.rs:773-830)
 * against `buildConfigParams()`, not a subset: on mainnet the config may be created outside this code and
 * this read-back is the only gate (audit/CONFIG-REVIEW.md S1-H1). Not compared: `version`, padding, and the
 * amounts the program derives itself (swap/migration base amounts, migration sqrt price).
 * `tierBps` names the reviewed tier the config must be (default: the SNARKS 1% config), so a 2% config is a mismatch against
 * the 1% spec and the reverse: a config is accepted only for the tier it is asked about.
 */
export function verifyConfigState(state: PoolConfig, feeClaimer: PublicKey, tierBps: number = DEFAULT_TIER_BPS): string[] {
  const p = buildConfigParams(tierBps);
  const problems: string[] = [];
  const expect: Expect = (label, got, want) => {
    if (String(got) !== String(want)) problems.push(`${label}: on chain ${String(got)}, required ${String(want)}`);
  };
  expect("quote mint", state.quoteMint.toBase58(), dbc.quoteMint.toBase58());
  expect("fee claimer", state.feeClaimer.toBase58(), feeClaimer.toBase58());
  expect("leftover receiver (permanent too; must be the fee claimer so a keeper rotation strands nothing)", state.leftoverReceiver.toBase58(), feeClaimer.toBase58());
  const s = state as unknown as Rec;
  checkFees(s, p, tierBps, expect);
  checkMigration(s, p, tierBps, expect);
  checkLiquidity(s, p, tierBps, expect);
  checkTokenAndCurve(s, p, expect);
  return problems;
}

export function rowFromState(configId: PublicKey, state: PoolConfig): DbcConfigRow {
  return {
    configId: configId.toBase58(),
    // the tier's id is the fee AFTER the launch window (the scheduler's minimum), never the 99% cliff: tierOfRow reads it
    feeBps: feeNumeratorToBps(feeAfterWindow(state.poolFees.baseFee as unknown as Rec) as PoolConfig["poolFees"]["baseFee"]["cliffFeeNumerator"]),
    feeClaimer: state.feeClaimer.toBase58(),
    migrationQuoteThreshold: state.migrationQuoteThreshold.toString(),
    // the DAMM v2 config the chain says this config migrates into (verified against the tier before a row is made)
    dammConfig: (DAMM_V2_MIGRATION_FEE_ADDRESS[state.migrationFeeOption] ?? dbc.dammConfig).toBase58(),
    poolCreationFeeLamports: state.poolCreationFee.toString(),
    createdAt: new Date().toISOString(),
  };
}

export type ConfigCheck = { ok: true; row: DbcConfigRow } | { ok: false; problems: string[] };

/**
 * Reads `configId` off the chain: it must exist, be owned by the DBC program and
 * match this pad's spec of tier `tierBps` (default: SNARKS 1%) for `expectedClaimer`. A DB row is never proof
 * that it does (a validator reset or a different cluster leaves the row behind). RPC
 * errors propagate: an unreachable node is not a missing config.
 */
export async function checkConfigOnChain(configId: PublicKey, expectedClaimer: PublicKey, tierBps: number = DEFAULT_TIER_BPS): Promise<ConfigCheck> {
  const info = await getConnection().getAccountInfo(configId, "confirmed");
  if (!info) return { ok: false, problems: [`not found on ${config.mode}`] };
  if (!info.owner.equals(dbc.programId)) return { ok: false, problems: [`owner ${info.owner.toBase58()} is not the DBC program ${dbc.programId.toBase58()}`] };
  const state = await getDbcClient().state.getPoolConfig(configId);
  if (!state) return { ok: false, problems: ["not a DBC pool config account"] };
  const problems = verifyConfigState(state, expectedClaimer, tierBps);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, row: rowFromState(configId, state) };
}

/** A config this pad will not use: it fails the full-field check, or it names someone else as fee claimer. */
export class ConfigRefusedError extends Error {}

export function configRefusal(configId: string, problems: string[]): Error {
  return new ConfigRefusedError(`DBC config ${configId} fails the on-chain check:\n  ${problems.join("\n  ")}`);
}

/**
 * The tier a recorded config belongs to. A row's fee is the tier's id (the row is made from the chain's own fee after the launch window); a fee that is
 * not on the menu can only be the default config built with an env override outside mainnet (src/config.ts), so it is the default tier.
 */
export function tierOfRow(row: Pick<DbcConfigRow, "feeBps">): number {
  return reviewedTier(row.feeBps) ? row.feeBps : DEFAULT_TIER_BPS;
}

/**
 * The config -> tier map the engine knows: every config recorded in the DB with the tier it was verified as. A config id that is
 * not recorded is not in the map (and so is not launched on): the DB row is written only after the full-field check passed.
 */
export function configTierMap(): Map<string, number> {
  return new Map(db.listDbcConfigs().map((r) => [r.configId, tierOfRow(r)]));
}

/** The newest recorded config of a tier, or null. */
export function latestConfigForTier(tierBps: number): DbcConfigRow | null {
  return db.listDbcConfigs().find((r) => tierOfRow(r) === tierBps) ?? null;
}

/**
 * The address every config of this pad must name as fee claimer: FEE_CLAIMER_PUBKEY, else vault 0 of SQUADS_MULTISIG, else the
 * recorded keeper (custody Option A). null = nothing says, which a caller treats as "not configured". Reads no secret.
 */
export function expectedFeeClaimer(): PublicKey | null {
  if (dbc.feeClaimer) return dbc.feeClaimer;
  if (dbc.squadsMultisig) return sqds.getVaultPda({ multisigPda: dbc.squadsMultisig, index: REVIEWED_MULTISIG.vaultIndex })[0];
  const keeper = db.getMeta(KEEPER_PUBKEY_META);
  return keeper ? new PublicKey(keeper) : null;
}

/**
 * A DB row is re-checked on chain every time it is used: a launch must never be
 * built against a config the chain does not have (validator reset, other
 * cluster) or that no longer matches the row's own fee claimer and the spec of its tier.
 */
export async function verifyRecordedConfig(recorded: DbcConfigRow): Promise<DbcConfigRow> {
  const check = await checkConfigOnChain(new PublicKey(recorded.configId), new PublicKey(recorded.feeClaimer), tierOfRow(recorded));
  if (!check.ok) throw configRefusal(recorded.configId, check.problems);
  return recorded;
}

/** Reads a config off the chain and refuses it unless it matches this pad's spec of tier `tierBps` for `expectedClaimer`. */
export async function readAndVerifyConfig(configId: PublicKey, expectedClaimer: PublicKey, tierBps: number = DEFAULT_TIER_BPS): Promise<DbcConfigRow> {
  const check = await checkConfigOnChain(configId, expectedClaimer, tierBps);
  if (!check.ok) throw configRefusal(configId.toBase58(), check.problems);
  return check.row;
}

export class PadNotConfiguredError extends Error {
  constructor() {
    super("no DBC config is recorded: run `bun run seed` (local/devnet) or set DBC_CONFIG_ID and FEE_CLAIMER_PUBKEY");
  }
}

/** A launch asked for a fee tier that is not on the menu, or whose config this pad has not created and verified. */
export class TierNotAvailableError extends Error {
  constructor(public tierBps: number, public reason: "not_a_tier" | "not_created") {
    super(reason === "not_a_tier" ? `${tierBps} bps is not a fee tier on the menu` : `the ${tierBps} bps fee tier has no verified config on ${config.mode} yet: run \`bun run config:create -- --tier ${tierBps}\``);
  }
}

/** A recorded tier config whose fee claimer is not this pad's own: never launched on (a config's claimer is permanent). */
async function requireOwnClaimer(row: DbcConfigRow): Promise<void> {
  const own = expectedFeeClaimer();
  if (!own) throw new PadNotConfiguredError();
  if (row.feeClaimer !== own.toBase58()) {
    throw configRefusal(row.configId, [`fee claimer: recorded ${row.feeClaimer}, this pad's own is ${own.toBase58()}; a coin launched on it would pay its fees to someone else`]);
  }
}

/**
 * The config a launch of tier `tierBps` uses, read-only. The default tier: the newest default config recorded in the DB (or
 * DBC_CONFIG_ID's row), re-checked on chain and refused if the chain no longer has it or it no longer matches; else DBC_CONFIG_ID
 * read back off the chain, verified against the expected fee claimer and recorded. Another tier: the newest recorded config of that
 * tier, re-checked on chain against the tier's spec AND required to name this pad's own fee claimer; never created here.
 * Never signs anything: safe for the API.
 */
export async function requireDbcConfig(tierBps: number = DEFAULT_TIER_BPS): Promise<DbcConfigRow> {
  if (!reviewedTier(tierBps)) throw new TierNotAvailableError(tierBps, "not_a_tier");
  if (tierBps !== DEFAULT_TIER_BPS) {
    const row = latestConfigForTier(tierBps);
    if (!row) throw new TierNotAvailableError(tierBps, "not_created");
    await requireOwnClaimer(row);
    return verifyRecordedConfig(row);
  }
  const recorded = dbc.configId ? db.getDbcConfig(dbc.configId.toBase58()) : latestConfigForTier(DEFAULT_TIER_BPS);
  if (recorded) return verifyRecordedConfig(recorded);
  if (!dbc.configId) throw new PadNotConfiguredError();
  const keeper = db.getMeta(KEEPER_PUBKEY_META);
  const claimer = dbc.feeClaimer ?? (keeper ? new PublicKey(keeper) : null);
  if (!claimer) throw new PadNotConfiguredError();
  const row = await readAndVerifyConfig(dbc.configId, claimer);
  db.insertDbcConfig(row);
  return row;
}

/**
 * The tiers a launch can ask for right now: the menu entries with a recorded config, plus the default one when DBC_CONFIG_ID pins it.
 * Not yet re-verified on chain: a launch does that, and refuses what fails.
 */
export function tiersAvailable(): number[] {
  const have = new Set([...configTierMap().values()].filter((t) => reviewedTier(t) !== null));
  if (dbc.configId) have.add(DEFAULT_TIER_BPS);
  return [...have].sort((a, b) => a - b);
}
