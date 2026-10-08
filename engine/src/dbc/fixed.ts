// GET /api/coins/:mint/fixed docs/API.md v2.6: everything the coin page's "what is fixed" panel prints, read from the chain
// (the coin's DBC config account, its mint account, the Squads multisig behind the fee claimer, the DAMM v2 pool once graduated) and
// from the reviewed tier table, each value with the account it came from so the page can link an explorer. Read-only; cached for
// FIXED_MAX_AGE_MS; imports nothing from the keeper side (INV-17).
import { PublicKey } from "@solana/web3.js";
import { ExtensionType, getExtensionData, unpackMint } from "@solana/spl-token";
import * as sqds from "@sqds/multisig";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PoolStatus } from "@meteora-ag/cp-amm-sdk";
import { config } from "../config";
import { getConnection, getDbcClient } from "../solana";
import { viewCpAmm } from "./cpAmm";
import type { CoinRow } from "../db";
import { REVIEWED_MULTISIG, reviewedTier } from "./reviewed";
import { coinTier, makeReadCache } from "./read";
import { endFeeBps, launchWindowOf, scheduleOfState, type LaunchWindow } from "./window";

export const FIXED_MAX_AGE_MS = Number(process.env.PAD_FIXED_MAX_AGE_MS ?? 30_000);

/** After graduation the DAMM v2 pool's dynamic fee adds up to a fifth of its base fee (CONFIG-REVIEW S1-M1): "base x 1.2". */
const GRADUATED_FEE_MAX_PERCENT_OF_BASE = 120;

export interface FixedView {
  mint: string;
  network: "local" | "devnet" | "mainnet";
  config: { id: string; source: string };
  curveFee: { bps: number; source: string };
  // The launch window of the coin's config (v2.8): the fee steps from `cliffBps` to `endBps` between `startsAt` and `endsAt`, and the launcher's own first buy pays
  // `endBps`. `source` is the config account (the scheduler and the first-buy flag), `poolSource` the pool account (the activation point). null: a flat-fee config.
  launchWindow: (LaunchWindow & { firstSwapAtEndFee: boolean; source: string; poolSource: string }) | null;
  graduatedFee: { minBps: number; maxBps: number; source: string };
  creatorShare: { bps: number; percentage: number; source: string };
  migration: { thresholdZats: string; source: string };
  liquidity: { partnerLockedPct: number; creatorLockedPct: number; unlockedPct: number; source: string };
  tokenAuthorities: { mintAuthority: string | null; freezeAuthority: string | null; updateAuthority: string | null; source: string };
  feeClaimer: {
    address: string;
    kind: "squads_vault" | "other";
    multisig: { address: string; threshold: number; members: number; timeLock: number; autonomous: boolean } | null;
    source: string;
  };
  pause: {
    padCanPause: false;
    curve: { pausableByMeteoraCurrentCode: false; source: string };
    pool: { pausableByMeteora: true; paused: boolean | null; source: string };
  };
  snapshotRule: { samplesPerWindow: number; windowHours: number; minBalanceRaw: string; rule: string; excluded: string[] };
  readAt: string;
}

/** The Token-2022 metadata extension starts with the update authority (32 bytes, all zero = none). null for a mint without it. */
export function metadataUpdateAuthority(tlvData: Buffer): string | null {
  const data = getExtensionData(ExtensionType.TokenMetadata, tlvData);
  if (!data || data.length < 32) return null;
  const key = new PublicKey(data.subarray(0, 32));
  return key.equals(PublicKey.default) ? null : key.toBase58();
}

async function readMintAuthorities(mint: PublicKey): Promise<FixedView["tokenAuthorities"]> {
  const info = await getConnection().getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  const m = unpackMint(mint, info, info.owner);
  return {
    mintAuthority: m.mintAuthority?.toBase58() ?? null,
    freezeAuthority: m.freezeAuthority?.toBase58() ?? null,
    updateAuthority: metadataUpdateAuthority(m.tlvData),
    source: mint.toBase58(),
  };
}

/** The Squads multisig whose vault 0 is `claimer`, when SQUADS_MULTISIG names it; null for any other claimer (a plain keypair, or a multisig this pad does not know). */
async function readClaimerMultisig(claimer: PublicKey): Promise<FixedView["feeClaimer"]["multisig"]> {
  const address = config.solana.dbc.squadsMultisig;
  if (!address || !sqds.getVaultPda({ multisigPda: address, index: REVIEWED_MULTISIG.vaultIndex })[0].equals(claimer)) return null;
  const ms = await sqds.accounts.Multisig.fromAccountAddress(getConnection(), address, "confirmed");
  return { address: address.toBase58(), threshold: ms.threshold, members: ms.members.length, timeLock: ms.timeLock, autonomous: ms.configAuthority.equals(PublicKey.default) };
}

async function readDammPaused(coin: CoinRow): Promise<boolean | null> {
  if (!coin.dammPool) return null;
  const pool = await viewCpAmm().fetchPoolState(new PublicKey(coin.dammPool));
  return pool.poolStatus === PoolStatus.Disable;
}

function snapshotRule(): FixedView["snapshotRule"] {
  const { count } = config.epoch.snapshots;
  return {
    samplesPerWindow: count,
    windowHours: Math.round(config.scheduler.epochEveryMs / 3_600_000),
    minBalanceRaw: config.epoch.minHolderBalanceRaw.toString(),
    rule: `A holder's weight is the least balance held across ${count} random checks inside the round's window and one more when the fee is claimed, so buying just before a round and selling just after earns nothing.`,
    excluded: ["pool vaults and any other program-owned account", "the keeper", "the fee claimer and the members of its multisig"],
  };
}

async function readFixed(coin: CoinRow): Promise<FixedView> {
  const client = getDbcClient();
  const virtualPool = await client.state.getPool(new PublicKey(coin.poolId!));
  if (!virtualPool) throw new Error(`DBC pool ${coin.poolId} not found`);
  const configId = virtualPool.poolState.config;
  const [state, tokenAuthorities, paused] = await Promise.all([client.state.getPoolConfig(configId), readMintAuthorities(new PublicKey(coin.mint)), readDammPaused(coin)]);
  if (!state) throw new Error(`DBC config ${configId.toBase58()} not found`);
  const multisig = await readClaimerMultisig(state.feeClaimer);

  const cfg = configId.toBase58();
  const schedule = scheduleOfState(state);
  const window = launchWindowOf(schedule, virtualPool.poolState.activationPoint);
  const tier = reviewedTier(coinTier(coin))!;
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[state.migrationFeeOption]?.toBase58() ?? tier.dammMigrationConfig;
  return {
    mint: coin.mint,
    network: config.mode,
    config: { id: cfg, source: cfg },
    curveFee: { bps: endFeeBps(schedule), source: cfg },
    launchWindow: window ? { ...window, firstSwapAtEndFee: schedule.firstSwapAtEndFee, source: cfg, poolSource: coin.poolId! } : null,
    graduatedFee: { minBps: tier.postGraduationFeeBps, maxBps: Math.round((tier.postGraduationFeeBps * GRADUATED_FEE_MAX_PERCENT_OF_BASE) / 100), source: dammConfig },
    creatorShare: { bps: (8000 * state.creatorTradingFeePercentage) / 100, percentage: state.creatorTradingFeePercentage, source: cfg },
    migration: { thresholdZats: state.migrationQuoteThreshold.toString(), source: cfg },
    liquidity: {
      partnerLockedPct: state.partnerPermanentLockedLiquidityPercentage,
      creatorLockedPct: state.creatorPermanentLockedLiquidityPercentage,
      unlockedPct: state.partnerLiquidityPercentage + state.creatorLiquidityPercentage,
      source: cfg,
    },
    tokenAuthorities,
    feeClaimer: { address: state.feeClaimer.toBase58(), kind: multisig ? "squads_vault" : "other", multisig, source: cfg },
    pause: {
      padCanPause: false,
      curve: { pausableByMeteoraCurrentCode: false, source: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58() },
      pool: { pausableByMeteora: true, paused, source: coin.dammPool ?? DAMM_V2_PROGRAM_ID.toBase58() },
    },
    snapshotRule: snapshotRule(),
    readAt: new Date().toISOString(),
  };
}

/** What is fixed about a coin, read at most once per window per coin; a failed read is not kept. */
export const fixedOf = makeReadCache(readFixed, (c: CoinRow) => `${c.mint}:${c.poolId}:${c.dammPool ?? ""}`, FIXED_MAX_AGE_MS);
