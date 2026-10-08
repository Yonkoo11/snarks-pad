#!/usr/bin/env bun
// F-038 probe: the Meteora DBC fee scheduler as a snipe tax, measured on DEVNET.
//   PAD_MODE=devnet bun scripts/probe-f038.ts [--periods 12] [--no-migrate] [--first-swap-min-fee]
// Creates ONE throwaway config (the 1% tier's curve, fee 50% at launch falling to 1% over 60 s in 12 periods), launches a
// probe coin on it, buys at t=0, right after, mid-window and after the window, reads the fee the chain took each time, then
// fills the curve and migrates it. Also simulates the program's answer to a 99% cliff, a cliff above 99%, an ending fee below
// 0.25% and a half-filled scheduler. Payer = the Solana CLI default key (PROBE_PAYER_KEYPAIR overrides). Touches no tier
// config, no DB row, no engine state: it has its own quote mint and its own config, and refuses any cluster but devnet.
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DammV2DynamicFeeMode, DAMM_V2_MIGRATION_FEE_ADDRESS, MigratedCollectFeeMode, MigrationOption,
  SwapMode, TokenAuthorityOption, TokenType, U64_MAX, buildCurveWithMarketCap, calculateFeeSchedulerEndingBaseFeeBps, deriveDammV2PoolAddress,
  deriveDbcPoolAddress, feeNumeratorToBps, getBaseFeeNumerator, getCurrentPoint, getFeeSchedulerParams, validateConfigParameters, validateFeeScheduler,
  type BaseFee, type BaseFeeParams, type ConfigParameters, type TokenDecimal,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { decodePodAlignedFeeTimeScheduler, getBaseFeeModeFromPodAlignedData } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { getConnection, getCpAmm, getDbcClient } from "../src/solana";
import { REVIEWED_CONFIG, REVIEWED_SERIALIZED, REVIEWED_TIERS } from "../src/dbc/reviewed";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const FEE_DENOMINATOR = 1_000_000_000n;
const START_BPS = 5000;
const END_BPS = 100;
const WINDOW_S = 60;
// --periods N picks the step count (default 12, the owner's draft); --no-migrate stops after the buys and the partner claim.
const argAfter = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const PERIODS = Number(argAfter("--periods") ?? 12);
const MIGRATE = !process.argv.includes("--no-migrate");
// --first-swap-min-fee sets enable_first_swap_with_min_fee on the config: the launcher's buy inside the launch transaction pays the
// scheduler's MIN fee (process_swap.rs:214-220: flag on, no swap yet, the init-pool instruction in the same tx, no CPI).
const FIRST_SWAP_MIN_FEE = process.argv.includes("--first-swap-min-fee");
if (!Number.isInteger(PERIODS) || PERIODS < 1 || PERIODS > WINDOW_S) throw new Error("--periods must be a whole number 1..60");
const FIRST_BUY = 50_000_000n; // 0.5 quote units at t=0
const SMALL_BUY = 30_000_000n;
const LATE_BUY = 100_000_000n; // 1 unit: ceil(1e8 x 10,000,004 / 1e9) = 1,000,001, one unit more than an exact 1%
const RESULTS_DIR = join(config.paths.repoRoot, "probe", "fee-scheduler", "results");
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const results: Record<string, unknown> = { probe: "F-038", cluster: "devnet", startedAt: new Date().toISOString(), schedule: { startBps: START_BPS, endBps: END_BPS, periods: PERIODS, windowS: WINDOW_S, migrate: MIGRATE, firstSwapMinFee: FIRST_SWAP_MIN_FEE } };

// ---------- part 1: the scheduler arithmetic, no chain ----------

function describeBaseFee(b: BaseFee): Record<string, string | number> {
  return {
    baseFeeMode: b.baseFeeMode, cliffFeeNumerator: b.cliffFeeNumerator.toString(), firstFactor_numberOfPeriod: b.firstFactor,
    secondFactor_periodFrequency: b.secondFactor.toString(), thirdFactor_reductionFactor: b.thirdFactor.toString(),
    endingBps_sdk: calculateFeeSchedulerEndingBaseFeeBps(Number(b.cliffFeeNumerator.toString()), b.firstFactor, Number(b.secondFactor.toString()), Number(b.thirdFactor.toString()), b.baseFeeMode),
  };
}

function feeAt(b: BaseFee, elapsedS: number): { numerator: string; percent: string } {
  const n = getBaseFeeNumerator(b.cliffFeeNumerator, b.firstFactor, b.secondFactor, b.thirdFactor, b.baseFeeMode, new BN(elapsedS), new BN(0));
  return { numerator: n.toString(), percent: (Number(n.toString()) / 1e7).toFixed(7) + "%" };
}

function schedulerMath(): { linear: BaseFee; exponential: BaseFee } {
  const linear = getFeeSchedulerParams(START_BPS, END_BPS, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S);
  const exponential = getFeeSchedulerParams(START_BPS, END_BPS, BaseFeeMode.FeeSchedulerExponential, PERIODS, WINDOW_S);
  log("linear scheduler fields:", describeBaseFee(linear));
  log("exponential scheduler fields:", describeBaseFee(exponential));
  const table = [0, 1, 4, 5, 9, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 59, 60, 61, 120, 3600].map((t) => ({ t, linear: feeAt(linear, t), exponential: feeAt(exponential, t) }));
  for (const row of table) log(`t=${String(row.t).padStart(4)} s  linear ${row.linear.numerator.padStart(9)} (${row.linear.percent})  exponential ${row.exponential.numerator.padStart(9)} (${row.exponential.percent})`);
  const tierNumerator = BigInt(END_BPS) * FEE_DENOMINATOR / 10_000n;
  const linearEnd = BigInt(feeAt(linear, WINDOW_S).numerator);
  const exactPeriods = Array.from({ length: WINDOW_S }, (_, i) => i + 1).filter((n) => (BigInt(START_BPS - END_BPS) * FEE_DENOMINATOR / 10_000n) % BigInt(n) === 0n && WINDOW_S % n === 0);
  log(`linear end-of-window numerator ${linearEnd} vs tier ${tierNumerator}: ${linearEnd === tierNumerator ? "EXACT" : "NOT EXACT (off by " + (linearEnd - tierNumerator) + ")"}`);
  log(`period counts that make a ${WINDOW_S} s linear window end EXACTLY at ${END_BPS} bps (both 490,000,000 and ${WINDOW_S} divisible): ${exactPeriods.join(", ")}`);
  results.scheduler = { linear: describeBaseFee(linear), exponential: describeBaseFee(exponential), table, linearEndExact: linearEnd === tierNumerator, exactPeriodCounts: exactPeriods };
  return { linear, exponential };
}

function sdkAcceptance(): void {
  const tryParams = (label: string, s: number, e: number, mode: BaseFeeMode, n: number, d: number) => {
    try {
      const b = getFeeSchedulerParams(s, e, mode, n, d);
      return { label, sdk: "accepted", fields: describeBaseFee(b) };
    } catch (err) {
      return { label, sdk: "refused", error: (err as Error).message };
    }
  };
  const cases = [
    tryParams("99% cliff -> 1% (9900 -> 100 bps)", 9900, 100, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S),
    tryParams("50% cliff -> 1% (5000 -> 100 bps)", 5000, 100, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S),
    tryParams("99.01% cliff (9901 bps)", 9901, 100, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S),
    tryParams("ending fee 24 bps (below the 0.25% floor)", 5000, 24, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S),
    tryParams("ending fee 25 bps (the floor)", 5000, 25, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S),
    tryParams("flat 1% with periods set", 100, 100, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S),
    tryParams("decaying fee with 0 periods", 5000, 100, BaseFeeMode.FeeSchedulerLinear, 0, WINDOW_S),
    tryParams("decaying fee with 0 duration", 5000, 100, BaseFeeMode.FeeSchedulerLinear, PERIODS, 0),
    tryParams("60 s in 7 periods (60/7 is not whole)", 5000, 100, BaseFeeMode.FeeSchedulerLinear, 7, WINDOW_S),
  ];
  for (const c of cases) log("SDK getFeeSchedulerParams:", c);
  const cliff = new BN(500_000_000);
  const red = new BN(40_833_333);
  const three = [
    { label: "all three set", ok: validateFeeScheduler(PERIODS, new BN(5), red, cliff, BaseFeeMode.FeeSchedulerLinear) },
    { label: "reductionFactor 0, periods and frequency set", ok: validateFeeScheduler(PERIODS, new BN(5), new BN(0), cliff, BaseFeeMode.FeeSchedulerLinear) },
    { label: "numberOfPeriod 0, frequency and reduction set", ok: validateFeeScheduler(0, new BN(5), red, cliff, BaseFeeMode.FeeSchedulerLinear) },
    { label: "periodFrequency 0, periods and reduction set", ok: validateFeeScheduler(PERIODS, new BN(0), red, cliff, BaseFeeMode.FeeSchedulerLinear) },
    { label: "all three zero (flat)", ok: validateFeeScheduler(0, new BN(0), new BN(0), cliff, BaseFeeMode.FeeSchedulerLinear) },
  ];
  for (const t of three) log("SDK validateFeeScheduler:", t);
  results.sdkAcceptance = { getFeeSchedulerParams: cases, validateFeeScheduler: three };
}

// ---------- part 2: devnet ----------

function loadPayer(): Keypair {
  const path = process.env.PROBE_PAYER_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function requireDevnet(conn: Connection): Promise<void> {
  if (config.mode !== "devnet") throw new Error("devnet only: PAD_MODE=devnet");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`refusing: genesis ${genesis} is not devnet`);
}

/** The 1% tier's exact curve and settings (src/dbc/config.ts buildConfigParams) with the fee scheduler swapped in. */
function probeConfigParams(baseFeeParams: BaseFeeParams): ConfigParameters {
  const { dbc } = config.solana;
  const tier = REVIEWED_TIERS[100]!;
  const p = buildCurveWithMarketCap({
    token: { tokenType: TokenType.Token2022, tokenBaseDecimal: dbc.baseDecimals as TokenDecimal, tokenQuoteDecimal: dbc.quoteDecimals as TokenDecimal, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: dbc.totalSupply, leftover: 0 },
    fee: { baseFeeParams, dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: tier.creatorFeePercentage, poolCreationFee: 0, enableFirstSwapWithMinFee: FIRST_SWAP_MIN_FEE },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: tier.migrationFeeOption, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 0 },
    },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: tier.partnerLockedLpPercentage, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: tier.creatorLockedLpPercentage, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    initialMarketCap: dbc.initialMarketCapZec,
    migrationMarketCap: dbc.migrationMarketCapZec,
  });
  // Prove it is the 1% tier's curve: every curve number equals what the reviewed config serializes to.
  const same = p.sqrtStartPrice.toString() === REVIEWED_SERIALIZED.sqrtStartPrice && p.migrationQuoteThreshold.toString() === REVIEWED_SERIALIZED.migrationQuoteThreshold
    && p.curve.length === REVIEWED_SERIALIZED.curve.length && p.curve.every((c, i) => c.sqrtPrice.toString() === REVIEWED_SERIALIZED.curve[i]!.sqrtPrice && c.liquidity.toString() === REVIEWED_SERIALIZED.curve[i]!.liquidity);
  if (!same) throw new Error("the probe curve differs from the reviewed 1% curve; an env override is set");
  return p;
}

async function sendSigned(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log(`${label}: ${sig}`);
  return sig;
}

async function txSlotAndTime(conn: Connection, sig: string): Promise<{ slot: number; blockTime: number }> {
  for (let i = 0; i < 10; i++) {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx?.blockTime) return { slot: tx.slot, blockTime: tx.blockTime };
    await Bun.sleep(500);
  }
  throw new Error(`transaction ${sig} not readable`);
}

interface Counters { partner: bigint; creator: bigint; protocol: bigint; total: bigint }

async function counters(pool: PublicKey): Promise<Counters> {
  const s = (await getDbcClient().state.getPool(pool))!.poolState;
  const partner = BigInt(s.partnerQuoteFee.toString());
  const creator = BigInt(s.creatorQuoteFee.toString());
  const protocol = BigInt(s.protocolQuoteFee.toString());
  return { partner, creator, protocol, total: partner + creator + protocol };
}

/** Simulates a config creation with hand-set base-fee fields: what the PROGRAM says, independent of the SDK's own checks. */
async function simulateConfig(conn: Connection, payer: Keypair, quoteMint: PublicKey, base: ConfigParameters, label: string, override: Partial<BaseFee>): Promise<Record<string, unknown>> {
  const params: ConfigParameters = { ...base, poolFees: { ...base.poolFees, baseFee: { ...base.poolFees.baseFee, ...override } } };
  let sdk: string;
  try {
    validateConfigParameters({ ...params, leftoverReceiver: payer.publicKey });
    sdk = "accepted";
  } catch (err) {
    sdk = `refused: ${(err as Error).message}`;
  }
  const cfg = Keypair.generate();
  const tx = await getDbcClient().partner.program.methods.createConfig(params).accountsPartial({ config: cfg.publicKey, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey, quoteMint, payer: payer.publicKey }).transaction();
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, cfg);
  const sim = await conn.simulateTransaction(tx);
  const errLine = (sim.value.logs ?? []).find((l) => /Error Code|Error Number|failed/.test(l)) ?? null;
  const out = { label, fields: describeBaseFee(params.poolFees.baseFee), sdkValidateConfigParameters: sdk, program: sim.value.err ? "REFUSED" : "ACCEPTED (simulation)", programError: sim.value.err ? JSON.stringify(sim.value.err) : null, programLog: errLine };
  log("program simulation:", out);
  return out;
}

async function programAcceptance(conn: Connection, payer: Keypair, quoteMint: PublicKey, linear: BaseFee): Promise<void> {
  const base = probeConfigParams({ baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: START_BPS, endingFeeBps: END_BPS, numberOfPeriod: PERIODS, totalDuration: WINDOW_S } });
  const ninetyNine = getFeeSchedulerParams(9900, END_BPS, BaseFeeMode.FeeSchedulerLinear, PERIODS, WINDOW_S);
  const expo = getFeeSchedulerParams(START_BPS, END_BPS, BaseFeeMode.FeeSchedulerExponential, PERIODS, WINDOW_S);
  const cases = [
    await simulateConfig(conn, payer, quoteMint, base, "(d) 99% cliff -> 1%, linear 12 x 5 s", ninetyNine),
    await simulateConfig(conn, payer, quoteMint, base, "(d) 99.01% cliff (990,100,000) -> 1%", { cliffFeeNumerator: new BN(990_100_000), firstFactor: PERIODS, secondFactor: new BN(5), thirdFactor: new BN(81_675_000) }),
    await simulateConfig(conn, payer, quoteMint, base, "(e) 50% -> 24 bps (ending 2,399,996 < 2,500,000)", { cliffFeeNumerator: new BN(500_000_000), firstFactor: PERIODS, secondFactor: new BN(5), thirdFactor: new BN(41_466_667) }),
    await simulateConfig(conn, payer, quoteMint, base, "(e) 50% -> 25 bps exactly (ending 2,500,000)", { cliffFeeNumerator: new BN(500_000_000), firstFactor: 10, secondFactor: new BN(6), thirdFactor: new BN(49_750_000) }),
    await simulateConfig(conn, payer, quoteMint, base, "(e) reductionFactor 0 with 12 periods x 5 s", { ...linear, thirdFactor: new BN(0) }),
    await simulateConfig(conn, payer, quoteMint, base, "(e) numberOfPeriod 0 with frequency and reduction set", { ...linear, firstFactor: 0 }),
    await simulateConfig(conn, payer, quoteMint, base, "(e) periodFrequency 0 with periods and reduction set", { ...linear, secondFactor: new BN(0) }),
    await simulateConfig(conn, payer, quoteMint, base, "exponential 50% -> 1%, 12 x 5 s (as the SDK builds it)", expo),
  ];
  results.programAcceptance = cases;
}

interface BuyRecord {
  label: string; amount: string; sig: string; slot: number; blockTime: number; activationPoint: number; elapsedS: number; period: number;
  quote: { atPoint: number; elapsedS: number; feeQuoted: string; feeNumeratorAtQuote: string } | null;
  feeObserved: string; feeExpectedAtLanding: string; feeNumeratorAtLanding: string; feePercentAtLanding: string; numeratorConfirmed: boolean;
  countersAfter: { partner: string; creator: string; protocol: string };
}

function expectedFee(amount: bigint, numerator: bigint): bigint {
  return (amount * numerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR; // ceil, state/config.rs get_excluded_fee_amount Rounding::Up
}

function numeratorAt(b: BaseFee, elapsedS: number): bigint {
  return BigInt(getBaseFeeNumerator(b.cliffFeeNumerator, b.firstFactor, b.secondFactor, b.thirdFactor, b.baseFeeMode, new BN(elapsedS), new BN(0)).toString());
}

/** The chain's clock (block time of the latest slot). Helius sometimes has no block time yet for a just-confirmed slot: retry. */
async function chainNow(conn: Connection): Promise<number> {
  for (let i = 1; ; i++) {
    try {
      return Number((await getCurrentPoint(conn, ActivationType.Timestamp)).toString());
    } catch (err) {
      if (i >= 5 || !/block not available|failed to get block time/i.test(String((err as Error).message))) throw err;
      await Bun.sleep(400 * i);
    }
  }
}

async function waitUntilElapsed(conn: Connection, activation: number, targetS: number): Promise<void> {
  for (;;) {
    if ((await chainNow(conn)) - activation >= targetS) return;
    await Bun.sleep(1000);
  }
}

async function buy(conn: Connection, payer: Keypair, pool: PublicKey, scheduler: BaseFee, label: string, amount: bigint): Promise<BuyRecord> {
  const client = getDbcClient();
  const virtualPool = (await client.state.getPool(pool))!;
  const poolConfig = (await client.state.getPoolConfig(virtualPool.poolState.config))!;
  const activation = Number(virtualPool.poolState.activationPoint.toString());
  const now = await chainNow(conn);
  const q = client.pool.swapQuote2({ virtualPool, config: poolConfig, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(now), slippageBps: 500, swapMode: SwapMode.ExactIn, amountIn: new BN(amount.toString()) });
  const quote = { atPoint: now, elapsedS: now - activation, feeQuoted: q.tradingFee.add(q.protocolFee).add(q.referralFee).toString(), feeNumeratorAtQuote: numeratorAt(scheduler, now - activation).toString() };
  const before = await counters(pool);
  const tx = await client.pool.swap({ owner: payer.publicKey, pool, amountIn: new BN(amount.toString()), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null });
  const sig = await sendSigned(conn, tx, [payer], `${label} buy ${amount}`);
  return await recordBuy(conn, pool, scheduler, label, amount, sig, activation, quote, before);
}

async function recordBuy(conn: Connection, pool: PublicKey, scheduler: BaseFee, label: string, amount: bigint, sig: string, activation: number, quote: BuyRecord["quote"], before: Counters): Promise<BuyRecord> {
  const { slot, blockTime } = await txSlotAndTime(conn, sig);
  const after = await counters(pool);
  const elapsedS = blockTime - activation;
  const numerator = numeratorAt(scheduler, elapsedS);
  const feeObserved = after.total - before.total;
  const rec: BuyRecord = {
    label, amount: amount.toString(), sig, slot, blockTime, activationPoint: activation, elapsedS, period: Math.min(Math.floor(elapsedS / Number(scheduler.secondFactor.toString())), scheduler.firstFactor), quote,
    feeObserved: feeObserved.toString(), feeExpectedAtLanding: expectedFee(amount, numerator).toString(), feeNumeratorAtLanding: numerator.toString(),
    feePercentAtLanding: (Number(numerator) / 1e7).toFixed(7) + "%", numeratorConfirmed: feeObserved === expectedFee(amount, numerator),
    countersAfter: { partner: after.partner.toString(), creator: after.creator.toString(), protocol: after.protocol.toString() },
  };
  log(`${label}: slot ${slot}, t+${elapsedS}s (period ${rec.period}), fee observed ${feeObserved} of ${amount} = ${(Number(feeObserved) / Number(amount) * 100).toFixed(5)}%, numerator ${numerator} ${rec.numeratorConfirmed ? "CONFIRMED by the chain's fee" : "NOT matching"}; partner counter ${after.partner}; quote said ${quote?.feeQuoted ?? "n/a"} at t+${quote?.elapsedS ?? "n/a"}s`);
  return rec;
}

async function fillAndMigrate(conn: Connection, payer: Keypair, pool: PublicKey, quoteMint: PublicKey, baseMint: PublicKey, dammConfig: PublicKey): Promise<Record<string, unknown>> {
  const client = getDbcClient();
  const virtualPool = (await client.state.getPool(pool))!;
  const poolConfig = (await client.state.getPoolConfig(virtualPool.poolState.config))!;
  const fillTx = await client.pool.swap2({
    owner: payer.publicKey, pool, swapMode: SwapMode.PartialFill, amountIn: new BN(2_000_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null,
  });
  const fillSig = await sendSigned(conn, fillTx, [payer], "partial-fill buy to complete the curve");
  const afterFill = (await client.state.getPool(pool))!.poolState;
  const feeBefore = await counters(pool);
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig });
  const migrateSig = await sendSigned(conn, transaction, [payer, firstPositionNftKeypair, secondPositionNftKeypair], "migrate to DAMM v2");
  const migrated = (await client.state.getPool(pool))!.poolState;
  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
  const damm = await getCpAmm().fetchPoolState(dammPool);
  // DAMM v2 stores its base fee as pod-aligned bytes; the cp-amm SDK decodes them (the graduated pool's fee is a time scheduler struct with 0 periods = flat).
  const raw = damm.poolFees.baseFee.baseFeeInfo.data;
  const decoded = decodePodAlignedFeeTimeScheduler(Buffer.from(raw)) as unknown as Record<string, unknown>;
  const dammBaseFee = Object.fromEntries(Object.entries(decoded).map(([k, v]) => [k, BN.isBN(v) ? (v as BN).toString() : Array.isArray(v) ? v.length : v]));
  const out = {
    fillSig, migrationProgressAfterFill: afterFill.migrationProgress, quoteReserveAfterFill: afterFill.quoteReserve.toString(), migrationQuoteThreshold: poolConfig.migrationQuoteThreshold.toString(),
    dbcFeeNumeratorAtMigration: numeratorAt(poolConfig.poolFees.baseFee as unknown as BaseFee, 10_000).toString(), partnerFeeBeforeMigration: feeBefore.partner.toString(),
    migrateSig, isMigrated: migrated.isMigrated, dammPool: dammPool.toBase58(),
    dammBaseFee: { ...dammBaseFee, mode: getBaseFeeModeFromPodAlignedData(raw), cliffBps: feeNumeratorToBps(new BN(String(dammBaseFee.cliffFeeNumerator ?? 0))) },
    dammDynamicFeeInitialized: damm.poolFees.dynamicFee.initialized, dammCollectFeeMode: damm.collectFeeMode, dammActivationPoint: damm.activationPoint.toString(),
  };
  log("migration:", out);
  return out;
}

async function claimPartner(conn: Connection, payer: Keypair, pool: PublicKey, quoteAta: PublicKey): Promise<Record<string, unknown>> {
  const before = (await getAccount(conn, quoteAta, "confirmed", TOKEN_PROGRAM_ID)).amount;
  const owed = (await counters(pool)).partner;
  const tx = await getDbcClient().partner.claimPartnerTradingFee({ feeClaimer: payer.publicKey, payer: payer.publicKey, pool, maxBaseAmount: new BN(U64_MAX.toString()), maxQuoteAmount: new BN(U64_MAX.toString()) });
  const sig = await sendSigned(conn, tx, [payer], "claim partner trading fee");
  const got = (await getAccount(conn, quoteAta, "confirmed", TOKEN_PROGRAM_ID)).amount - before;
  const out = { sig, partnerCounterBefore: owed.toString(), received: got.toString(), equal: got === owed };
  log("partner claim:", out);
  return out;
}

async function main(): Promise<void> {
  const { linear } = schedulerMath();
  sdkAcceptance();
  const conn = getConnection();
  await requireDevnet(conn);
  const payer = loadPayer();
  const balance0 = await conn.getBalance(payer.publicKey, "confirmed");
  log("payer", payer.publicKey.toBase58(), "balance", balance0 / 1e9, "SOL; rpc host", new URL(config.solana.rpc).host);
  results.payer = payer.publicKey.toBase58();

  // a quote mint of our own (8 dp like ZEC), so no engine key or mint is touched
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, REVIEWED_CONFIG.quoteDecimals);
  const quoteAta = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, payer.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(conn, payer, quoteMint, quoteAta, payer, 5_000_000_000n);
  log("quote mint", quoteMint.toBase58(), "(8 dp, 50 units minted to the payer)");
  results.quoteMint = quoteMint.toBase58();

  // the throwaway config: the 1% tier's curve with the 50% -> 1% scheduler
  const params = probeConfigParams({ baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: START_BPS, endingFeeBps: END_BPS, numberOfPeriod: PERIODS, totalDuration: WINDOW_S } });
  log("config params to send: baseFee", describeBaseFee(params.poolFees.baseFee), "activationType", params.activationType, "(1 = Timestamp: periodFrequency is in seconds)");
  const cfgKp = Keypair.generate();
  const cfgTx = await getDbcClient().partner.createConfig({ config: cfgKp.publicKey, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey, quoteMint, payer: payer.publicKey, ...params });
  const cfgSig = await sendSigned(conn, cfgTx, [payer, cfgKp], "create probe config");
  const onChain = (await getDbcClient().state.getPoolConfig(cfgKp.publicKey))!;
  const onChainBase = onChain.poolFees.baseFee as unknown as BaseFee;
  const configRead = { ...describeBaseFee(onChainBase), activationType: onChain.activationType, feeNumeratorToBps_of_cliff: feeNumeratorToBps(onChain.poolFees.baseFee.cliffFeeNumerator), migrationQuoteThreshold: onChain.migrationQuoteThreshold.toString(), creatorTradingFeePercentage: onChain.creatorTradingFeePercentage, enableFirstSwapWithMinFee: Number(onChain.enableFirstSwapWithMinFee) };
  log("config read back from chain:", configRead);
  results.config = { id: cfgKp.publicKey.toBase58(), sig: cfgSig, readBack: configRead };

  await programAcceptance(conn, payer, quoteMint, linear);

  // launch the probe coin with the first buy in the same transaction (t = 0 by construction)
  const baseKp = Keypair.generate();
  const launchTx = await getDbcClient().creator.createPoolWithFirstBuy({
    createPoolParam: { name: "Snipe Tax Probe", symbol: "F038", uri: "none", payer: payer.publicKey, poolCreator: payer.publicKey, config: cfgKp.publicKey, baseMint: baseKp.publicKey },
    firstBuyParam: { buyer: payer.publicKey, buyAmount: new BN(FIRST_BUY.toString()), minimumAmountOut: new BN(0), referralTokenAccount: null },
  });
  const launchSig = await sendSigned(conn, launchTx, [payer, baseKp], "launch (create pool + first buy)");
  const pool = deriveDbcPoolAddress(quoteMint, baseKp.publicKey, cfgKp.publicKey);
  const activation = Number((await getDbcClient().state.getPool(pool))!.poolState.activationPoint.toString());
  const buys: BuyRecord[] = [];
  buys.push(await recordBuy(conn, pool, linear, "(a) first buy inside the launch tx", FIRST_BUY, launchSig, activation, null, { partner: 0n, creator: 0n, protocol: 0n, total: 0n }));
  log("pool", pool.toBase58(), "base mint", baseKp.publicKey.toBase58(), "activationPoint", activation, "launch slot", buys[0]!.slot, "blockTime", buys[0]!.blockTime);
  results.pool = { id: pool.toBase58(), baseMint: baseKp.publicKey.toBase58(), launchSig, activationPoint: activation };

  buys.push(await buy(conn, payer, pool, linear, "(a) buy right after launch", SMALL_BUY));
  await waitUntilElapsed(conn, activation, 28);
  buys.push(await buy(conn, payer, pool, linear, "(c) buy in the middle of the window", SMALL_BUY));
  await waitUntilElapsed(conn, activation, 63);
  buys.push(await buy(conn, payer, pool, linear, "(b) buy after the window", LATE_BUY));
  await waitUntilElapsed(conn, activation, 100);
  buys.push(await buy(conn, payer, pool, linear, "(b) buy well after the window", LATE_BUY));
  results.buys = buys;

  results.partnerClaim = await claimPartner(conn, payer, pool, quoteAta);
  if (MIGRATE) results.migration = await fillAndMigrate(conn, payer, pool, quoteMint, baseKp.publicKey, DAMM_V2_MIGRATION_FEE_ADDRESS[REVIEWED_TIERS[100]!.migrationFeeOption]!);

  const balance1 = await conn.getBalance(payer.publicKey, "confirmed");
  results.lamportsSpent = balance0 - balance1;
  results.finishedAt = new Date().toISOString();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `f038-devnet-${PERIODS}periods${FIRST_SWAP_MIN_FEE ? "-firstswapminfee" : ""}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log("spent", (balance0 - balance1) / 1e9, "SOL; results", file);
}

await main();
