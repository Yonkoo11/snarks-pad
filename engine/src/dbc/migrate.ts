// Graduation: once a coin's curve is full, anyone can move it to a DAMM v2
// pool (permissionless, about 0.0226 SOL, paid by whoever calls it). The
// keeper calls it so a coin never sits "full but not migrated". Everything here
// is decided from chain state, never from a remembered "I sent it": a crash
// between sending and recording is healed by the next call reading
// `isMigrated` off the pool, so no migration transaction needs to be persisted.
import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "../config";
import { getConnection, getCpAmm, getDbcClient } from "../solana";
import { loadKeeperKeypair } from "../keeper";
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

async function recordMigration(coin: CoinRow, feeClaimer: PublicKey): Promise<CoinRow> {
  const { dbc } = config.solana;
  const dammPool = deriveDammV2PoolAddress(dammConfigOf(coin), new PublicKey(coin.mint), dbc.quoteMint);
  const positions = await getCpAmm().getUserPositionByPool(dammPool, feeClaimer);
  const nft = positions[0]?.positionState.nftMint.toBase58() ?? null;
  db.markCoinMigrated(coin.mint, dammPool.toBase58(), nft);
  return db.getCoin(coin.mint)!;
}

async function sendMigration(coin: CoinRow): Promise<void> {
  const keeper = loadKeeperKeypair();
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await getDbcClient().migration.migrateToDammV2({
    payer: keeper.publicKey,
    pool: new PublicKey(coin.poolId!),
    dammConfig: dammConfigOf(coin),
  });
  await sendAndConfirmTransaction(getConnection(), transaction, [keeper, firstPositionNftKeypair, secondPositionNftKeypair], { commitment: "confirmed" });
}

/**
 * Brings one coin's migration state up to date: already migrated -> record it
 * (idempotent); curve full -> send the migration, then record it; otherwise
 * nothing. Returns the coin row as it stands afterwards.
 */
export async function reconcileMigration(coin: CoinRow, feeClaimer: PublicKey): Promise<CoinRow> {
  if (!coin.poolId) return coin;
  let stage = await readCurveStage(coin.poolId);
  if (stage === "complete") {
    try {
      await sendMigration(coin);
    } catch (err) {
      // Someone else (migration is permissionless) may have beaten us to it.
      stage = await readCurveStage(coin.poolId);
      if (stage !== "migrated") throw err;
    }
    stage = await readCurveStage(coin.poolId);
  }
  return stage === "migrated" && !coin.dammPool ? recordMigration(coin, feeClaimer) : coin;
}
