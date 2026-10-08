// Creates the pad's PERMANENT Meteora DBC config (audit/CONFIG-REVIEW.md S1-H2). It sends exactly what
// buildConfigParams() builds from the reviewed values (dbc/reviewed.ts), with the Squads vault of the pad's
// multisig as fee claimer and leftover receiver, and reads the account back with the full-field check before
// recording it. The payer (the keeper) keeps no power over the config: the program does not store it.
//
// Dry run by default: every field it would send is printed and nothing is signed. It refuses unless the
// multisig passes the reviewed-shape checks, and refuses if a config for this vault already exists, is
// recorded or is pinned (DBC_CONFIG_ID), because a second config would split the coins' fees across two
// fee-claim paths. Keeper-side only: it loads the keeper key (never import it from the HTTP API).
import { Keypair, PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import BN from "bn.js";
import { config } from "../config";
import * as db from "../db";
import { loadKeeperKeypair } from "../keeper";
import { getConnection, getDbcClient } from "../solana";
import { buildConfigParams, checkConfigOnChain, expectedFeeClaimer, readAndVerifyConfig, requireTier, tierOfRow, verifyConfigState } from "./config";
import { clearPendingCreate, resolvePendingCreate, signRecordAndSend } from "./pendingCreate";
import { DEFAULT_TIER_BPS, REVIEWED_MULTISIG, REVIEWED_WINDOW, windowScheduleOf, type WindowSchedule } from "./reviewed";
import { tierShares, tradeSplit } from "./tiers";
import { multisigReviewedProblems, vaultOf } from "./squads";

export const CONFIG_CREATE_FLAG = "--i-understand-this-creates-a-permanent-config";
export const CONFIG_PENDING_META = "dbc_config_pending";
/** One pending-creation record per tier, so a creation that may still land is resolved as the tier it was started as. */
export const configPendingMeta = (tierBps: number): string => (tierBps === DEFAULT_TIER_BPS ? CONFIG_PENDING_META : `${CONFIG_PENDING_META}_${tierBps}`);
/** The config account's rent is about 0.006 SOL (CONFIG-REVIEW section 8); margin on top. */
const MIN_KEEPER_LAMPORTS = 10_000_000n;

const { dbc } = config.solana;

export interface ConfigCreateOptions {
  multisig: PublicKey;
  execute: boolean;
  /** The reviewed fee tier to create, in bps (default: the SNARKS 1% config). */
  tierBps?: number;
}

export interface ConfigCreateResult {
  executed: boolean;
  problems: string[];
  lines: string[];
  configId?: string;
}

const isBn = (v: unknown): boolean => typeof v === "object" && v !== null && (BN.isBN(v) || v.constructor?.name === "BN");

/** Every leaf of a value as `path = value`, in order (BN and PublicKey as strings). */
export function flattenFields(value: unknown, path = ""): [string, string][] {
  if (value === null || value === undefined) return [[path, String(value)]];
  if (isBn(value) || value instanceof PublicKey || typeof value !== "object") return [[path, String(value)]];
  if (Array.isArray(value)) return value.flatMap((v, i) => flattenFields(v, `${path}[${i}]`));
  return Object.entries(value).flatMap(([k, v]) => flattenFields(v, path ? `${path}.${k}` : k));
}

/** The whole creation call: the builder's parameters plus the three addresses that are passed beside them. */
export function configFieldTable(vault: PublicKey, payer: PublicKey, tierBps: number = DEFAULT_TIER_BPS): [string, string][] {
  return [
    ["feeClaimer (Squads vault 0 of the pad multisig)", vault.toBase58()],
    ["leftoverReceiver (permanent; the same vault)", vault.toBase58()],
    ["quoteMint (Solana ZEC)", dbc.quoteMint.toBase58()],
    ["payer (the keeper: pays rent, keeps no power over the config)", payer.toBase58()],
    ...flattenFields(buildConfigParams(tierBps)),
  ];
}

interface Plan {
  keeper: PublicKey;
  vault: PublicKey;
  tierBps: number;
  problems: string[];
}

async function multisigProblems(multisig: PublicKey, keeper: PublicKey): Promise<string[]> {
  const conn = getConnection();
  const info = await conn.getAccountInfo(multisig, "confirmed");
  if (!info) return [`no account at ${multisig.toBase58()} on ${config.mode}`];
  if (!info.owner.equals(sqds.PROGRAM_ID)) return [`${multisig.toBase58()} is owned by ${info.owner.toBase58()}, not the Squads v4 program ${sqds.PROGRAM_ID.toBase58()}`];
  try {
    if (!Buffer.from(info.data.subarray(0, 8)).equals(Buffer.from(sqds.generated.multisigDiscriminator))) throw new Error("not a multisig account");
    const ms = await sqds.accounts.Multisig.fromAccountAddress(conn, multisig, "confirmed");
    return multisigReviewedProblems(ms, keeper);
  } catch {
    return [`${multisig.toBase58()} is a Squads account but not a multisig`];
  }
}

/**
 * A config of this tier for this vault that already meets TODAY's spec (the launch window included), recorded here, pinned or on chain: one per tier,
 * since a second would split the fee-claim paths. A config made before the launch window (a flat fee) is an older generation: it stays on chain and in
 * the database for the coins launched on it and is not a duplicate, because no launch is ever built on it (the full-field check refuses it).
 */
async function existingConfigProblems(vault: PublicKey, tierBps: number): Promise<string[]> {
  const problems: string[] = [];
  const isDefault = tierBps === DEFAULT_TIER_BPS;
  const label = isDefault ? "" : `, tier ${tierBps} bps`;
  if (isDefault && dbc.configId) {
    const pinned = await checkConfigOnChain(dbc.configId, vault, tierBps);
    if (pinned.ok) problems.push(`DBC_CONFIG_ID is set (${dbc.configId.toBase58()}) and meets the current spec: a config is already pinned`);
  }
  for (const row of db.listDbcConfigs().filter((r) => tierOfRow(r) === tierBps)) {
    if ((await checkConfigOnChain(new PublicKey(row.configId), new PublicKey(row.feeClaimer), tierBps)).ok) {
      problems.push(`a config that meets the current spec is already recorded: ${row.configId} (fee claimer ${row.feeClaimer}${label})`);
    }
  }
  for (const c of await getDbcClient().state.getPoolConfigsByOwner(vault)) {
    if (verifyConfigState(c.account, vault, tierBps).length === 0) problems.push(`a config that meets the current spec already exists on ${config.mode}: ${c.publicKey.toBase58()}${label}`);
  }
  return problems;
}

/** A tier's config must name the vault the pad launches on and claims from, else every launch on it is refused later (launch checks it too). */
function tierClaimerProblems(vault: PublicKey, tierBps: number): string[] {
  if (tierBps === DEFAULT_TIER_BPS) return [];
  const own = expectedFeeClaimer();
  if (own && own.equals(vault)) return [];
  return [`this vault ${vault.toBase58()} is not the pad's fee claimer (${own ? own.toBase58() : "none known"}): set FEE_CLAIMER_PUBKEY or SQUADS_MULTISIG to the multisig this pad claims with, so tier configs and SNARKS share one claim path`];
}

async function makePlan(multisig: PublicKey, tierBps: number): Promise<Plan> {
  const keeper = loadKeeperKeypair().publicKey;
  const vault = vaultOf(multisig, REVIEWED_MULTISIG.vaultIndex);
  const problems = [...(await multisigProblems(multisig, keeper)), ...tierClaimerProblems(vault, tierBps), ...(await existingConfigProblems(vault, tierBps))];
  const lamports = BigInt(await getConnection().getBalance(keeper, "confirmed"));
  if (lamports < MIN_KEEPER_LAMPORTS) problems.push(`the keeper ${keeper.toBase58()} holds ${lamports} lamports; it needs at least ${MIN_KEEPER_LAMPORTS} for the config's rent`);
  return { keeper, vault, tierBps, problems };
}

/** The seconds a period covers, as the dry run prints them: "second 3", "seconds 2-3", or "from second 5" for the fee that stays. */
function periodLabel(k: number, w: WindowSchedule): string {
  if (k === w.periods) return `from second ${w.durationSeconds}`;
  const first = k * w.periodSeconds;
  return w.periodSeconds === 1 ? `second ${first}` : `seconds ${first}-${first + w.periodSeconds - 1}`;
}

/** The launch window of a tier in plain numbers: what a buy pays in each second of it, and what is checked on chain afterwards. */
function windowLines(tierBps: number): string[] {
  const w = windowScheduleOf(curveFee(tierBps));
  const pct = (bps: number) => `${bps / 100}%`;
  const steps = w.feeByPeriodBps.map((bps, k) => `${periodLabel(k, w)}: ${pct(bps)}`).join(", ");
  const first = `${w.periodSeconds === 1 ? "second" : `${w.periodSeconds} seconds`}`;
  return [
    `Launch window (fee scheduler, linear): ${pct(w.cliffBps)} in the first ${first}, ${w.periods} equal steps of ${w.reductionFactor} (of 1e9) every ${w.periodSeconds} s, then the tier's ${pct(w.endBps)} for good. By second: ${steps}.`,
    `Exact: (${w.cliffNumerator} - ${w.endNumerator}) / ${w.periods} = ${w.reductionFactor}, a whole number; the fee after the window is ${w.endNumerator} of 1e9 = ${pct(w.endBps)} to the unit. The launcher's own first buy in the launch transaction pays ${pct(w.endBps)} (enable_first_swap_with_min_fee ${REVIEWED_WINDOW.firstSwapWithMinFee ? "on" : "off"}).`,
  ];
}

const curveFee = (tierBps: number): number => (tierBps === DEFAULT_TIER_BPS ? dbc.feeBps : requireTier(tierBps).bps);

/** What the tier means in plain numbers: shown with the dry run so the owner reads who gets what before anything is signed. */
function tierLines(tierBps: number): string[] {
  if (tierBps === DEFAULT_TIER_BPS) return windowLines(tierBps);
  const t = requireTier(tierBps);
  const s = tradeSplit(10_000_000_000n, tierBps); // a 100-ZEC trade after the window, in zats
  const zec = (z: bigint) => (Number(z) / 1e8).toFixed(3);
  const sh = tierShares(tierBps);
  return [
    `Fee tier ${tierBps} bps (${tierBps / 100}% on the curve once the launch window has closed). Differs from the SNARKS 1% config in 6 fields only: the fee after the window ${tierBps} bps (which fixes the window's reduction per step), creator_trading_fee_percentage ${t.creatorFeePercentage}, migration_fee_option ${t.migrationFeeOption} (DAMM v2 config ${t.dammMigrationConfig}, ${t.postGraduationFeeBps / 100}% after graduation), partner locked LP ${t.partnerLockedLpPercentage}%, creator locked LP ${t.creatorLockedLpPercentage}%.`,
    ...windowLines(tierBps),
    `Per 100 ZEC traded: Meteora ${zec(s.meteora)}, creator ${zec(s.creator)}, holders ${zec(s.holders)}, team ${zec(s.team)} (shares of the fee in bps: ${JSON.stringify(sh)}; once the launch window has closed).`,
  ];
}

function describePlan(plan: Plan, multisig: PublicKey): string[] {
  const fields = configFieldTable(plan.vault, plan.keeper, plan.tierBps);
  const width = Math.max(...fields.map(([k]) => k.length));
  return [
    `DBC config to create on ${config.mode}. PERMANENT: every value below is fixed for every coin launched on it, forever.`,
    `Squads multisig ${multisig.toBase58()} -> fee claimer = vault ${plan.vault.toBase58()}. Compare it with the address on your paper.`,
    ...tierLines(plan.tierBps),
    ...fields.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
    plan.tierBps === DEFAULT_TIER_BPS
      ? "These are the values of audit/CONFIG-REVIEW.md section 3 and 4 with the launch window of audit/CONFIG-REVIEW-TIERS.md section 5, built by dbc/reviewed.ts."
      : "These are the values of audit/CONFIG-REVIEW.md section 3 and 4 with the tier fields and the launch window of audit/CONFIG-REVIEW-TIERS.md, built by dbc/reviewed.ts.",
  ];
}

/** Sends the creation, then reads the account back with the full-field check; records it only when that passes. */
async function createAndVerify(plan: Plan): Promise<{ configId: PublicKey; sig: string }> {
  const keeper = loadKeeperKeypair();
  const configKp = Keypair.generate(); // used once, to sign the creation; it has no power afterwards
  const tx = await getDbcClient().partner.createConfig({
    config: configKp.publicKey, feeClaimer: plan.vault, leftoverReceiver: plan.vault, quoteMint: dbc.quoteMint,
    payer: keeper.publicKey, ...buildConfigParams(plan.tierBps),
  });
  const sig = await signRecordAndSend(configPendingMeta(plan.tierBps), configKp.publicKey.toBase58(), tx, keeper, [configKp]);
  return { configId: configKp.publicKey, sig };
}

async function verifyAndRecord(vault: PublicKey, configId: PublicKey, tierBps: number): Promise<string[]> {
  let row;
  try {
    row = await readAndVerifyConfig(configId, vault, tierBps);
  } catch (err) {
    throw new Error(`the config ${configId.toBase58()} was created but FAILS the full-field check; do NOT launch a coin on it. ${(err as Error).message}`);
  }
  db.insertDbcConfig(row);
  clearPendingCreate(configPendingMeta(tierBps));
  return [
    `config: ${configId.toBase58()}`,
    "Read back from the chain with the full-field check: 0 mismatches.",
    tierBps === DEFAULT_TIER_BPS
      ? `Next: set DBC_CONFIG_ID=${configId.toBase58()} and FEE_CLAIMER_PUBKEY=${vault.toBase58()} on the keeper and the API.`
      : `Recorded as the ${tierBps} bps tier config: the API finds it in the database (nothing to set); FEE_CLAIMER_PUBKEY=${vault.toBase58()} must be set on the keeper and the API.`,
  ];
}

export async function runConfigCreate(opts: ConfigCreateOptions): Promise<ConfigCreateResult> {
  const tierBps = opts.tierBps ?? DEFAULT_TIER_BPS;
  requireTier(tierBps);
  const vault = vaultOf(opts.multisig, REVIEWED_MULTISIG.vaultIndex);
  const pendingMeta = configPendingMeta(tierBps);
  const earlier = await resolvePendingCreate(pendingMeta);
  if (earlier.state === "in_flight") {
    return { executed: false, problems: [`an earlier config creation (${earlier.pending.subject}) may still land; wait about two minutes and run this again`], lines: [] };
  }
  if (earlier.state === "landed") {
    if (!opts.execute) return { executed: false, problems: [`an earlier config creation landed (${earlier.pending.subject}); run with ${CONFIG_CREATE_FLAG} to verify and record it`], lines: [] };
    const lines = await verifyAndRecord(vault, new PublicKey(earlier.pending.subject), tierBps);
    return { executed: true, problems: [], lines, configId: earlier.pending.subject };
  }
  const plan = await makePlan(opts.multisig, tierBps);
  const lines = describePlan(plan, opts.multisig);
  if (plan.problems.length > 0 || !opts.execute) return { executed: false, problems: plan.problems, lines };
  const { configId } = await createAndVerify(plan);
  return { executed: true, problems: [], lines: [...lines, ...(await verifyAndRecord(vault, configId, tierBps))], configId: configId.toBase58() };
}
