// Graduation: once a coin's curve is full, anyone can move it to a DAMM v2
// pool (permissionless, about 0.0226 SOL, paid by whoever calls it). The
// keeper calls it so a coin never sits "full but not migrated". Everything here
// is decided from chain state, never from a remembered "I sent it": a crash
// between sending and recording is healed by the next call reading
// `isMigrated` off the pool, so no migration transaction needs to be persisted.
// Keeper-side: it loads the keeper key. The key-free reads (the curve's stage,
// recording a migration the chain shows, the API's sweep) are dbc/graduation.ts.
import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getConnection, getDbcClient } from "../solana";
import { loadKeeperKeypair } from "../keeper";
import type { CoinRow } from "../db";
import { dammConfigOf, readCurveStage, recordMigration } from "./graduation";

export { readCurveStage, dammConfigOf, type CurveStage } from "./graduation";

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
