// Reading a coin's graduation off the chain, for any process (the API's one-minute sweep, the keeper, scripts): where its curve stands, which DAMM v2
// config it graduates into, and recording its DAMM pool once the chain shows it migrated. No key is loaded here and nothing from the keeper side is
// imported (INV-17: the API process reaches this file). Sending the migration itself needs the keeper's key and lives in dbc/migrate.ts.
import { PublicKey } from "@solana/web3.js";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "../config";
import { getCpAmm, getDbcClient } from "../solana";
import { isChainUnavailable } from "../rpcGuard";
import * as db from "../db";
import type { CoinRow } from "../db";

export type CurveStage = "open" | "complete" | "migrated";

// DBC `MigrationProgress` (state/virtual_pool.rs:83): PreBondingCurve 0,
// PostBondingCurve 1 (curve full, a vesting locker must still be created),
// LockedVesting 2 (ready to migrate), CreatedPool 3. migrate_damm_v2 requires 2.
const LOCKED_VESTING = 2;
const POST_BONDING_CURVE = 1;

/**
 * "complete" means the migration instruction can run NOW (progress 2). A full
 * curve that still needs a vesting locker (progress 1) is an error here: this
 * pad's config has no vesting, so it can only mean a different config.
 */
export async function readCurveStage(poolId: string): Promise<CurveStage> {
  const pool = await getDbcClient().state.getPool(poolId);
  if (!pool) throw new Error(`DBC pool ${poolId} not found`);
  if (pool.poolState.isMigrated !== 0) return "migrated";
  if (pool.poolState.migrationProgress === POST_BONDING_CURVE) {
    throw new Error(`DBC pool ${poolId} is full but needs a vesting locker before it can migrate; this pad's config has no vesting`);
  }
  return pool.poolState.migrationProgress === LOCKED_VESTING ? "complete" : "open";
}

/** The DAMM v2 config a coin migrates into: the one its own DBC config names (a fee tier graduates into its own fee's pool). */
export function dammConfigOf(coin: CoinRow): PublicKey {
  const row = coin.configId ? db.getDbcConfig(coin.configId) : null;
  return row ? new PublicKey(row.dammConfig) : config.solana.dbc.dammConfig;
}

/** The address a coin's config names as fee claimer (permanent per config, so coins launched under an older config keep their old claimer). */
export function feeClaimerAddressOf(coin: CoinRow): PublicKey {
  const row = coin.configId ? db.getDbcConfig(coin.configId) : null;
  if (!row) throw new Error(`coin ${coin.mint} has no recorded DBC config, so its fee claimer is unknown`);
  return new PublicKey(row.feeClaimer);
}

/** Records a migrated coin's DAMM v2 pool and the fee claimer's position in it (the partner LP position is the claimer's). Idempotent. */
export async function recordMigration(coin: CoinRow, feeClaimer: PublicKey): Promise<CoinRow> {
  const { dbc } = config.solana;
  const dammPool = deriveDammV2PoolAddress(dammConfigOf(coin), new PublicKey(coin.mint), dbc.quoteMint);
  const positions = await getCpAmm().getUserPositionByPool(dammPool, feeClaimer);
  const nft = positions[0]?.positionState.nftMint.toBase58() ?? null;
  db.markCoinMigrated(coin.mint, dammPool.toBase58(), nft);
  return db.getCoin(coin.mint)!;
}

/** How the API's sweep looks at the chain, replaceable in tests: the stage of a DBC pool, and recording a migrated coin's DAMM pool. */
export interface MigrationLook {
  stage: (poolId: string) => Promise<CurveStage>;
  record: (coin: CoinRow) => Promise<CoinRow>;
}
const chainLook: MigrationLook = { stage: readCurveStage, record: (coin) => recordMigration(coin, feeClaimerAddressOf(coin)) };

/**
 * Records every launched coin whose curve the chain shows migrated but whose row still has no DAMM pool: migration is permissionless and anyone's
 * graduation (a trader's terminal, Meteora's own cranks) is otherwise seen only at the keeper's next epoch. Written 2026-10-12 after the first mainnet coin
 * graduated hours before the epoch and the site kept showing its curve price. Returns the symbols recorded. A chain outage ends the round; any other failure
 * on one coin is logged and the next coin is looked at. A full curve not yet migrated is left to the keeper, which holds the key that pays for it.
 */
export async function reconcileMigrations(look: MigrationLook = chainLook): Promise<string[]> {
  const recorded: string[] = [];
  for (const coin of db.listCoins()) {
    if (coin.status !== "launched" || !coin.poolId || coin.dammPool) continue;
    try {
      if ((await look.stage(coin.poolId)) !== "migrated") continue;
      await look.record(coin);
      recorded.push(coin.symbol);
    } catch (err) {
      if (isChainUnavailable(err)) throw err;
      console.error(`[reconcile] migration of ${coin.symbol} not recorded: ${(err as Error)?.message ?? err}`);
    }
  }
  return recorded;
}

export const MIGRATION_RECONCILE_EVERY_MS = 60_000;
let migrationTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the one-minute migration sweep in the API process. It never throws into the API: a failed round is a log line and the next one tries again. */
export function startMigrationReconciler(): void {
  if (migrationTimer) return;
  const round = () =>
    reconcileMigrations().then(
      (r) => { if (r.length) console.log(`[reconcile] recorded migration of ${r.join(", ")}`); },
      (err) => console.error(`[reconcile] migration round failed: ${(err as Error)?.message ?? err}`),
    );
  migrationTimer = setInterval(round, MIGRATION_RECONCILE_EVERY_MS);
  migrationTimer.unref?.();
}
