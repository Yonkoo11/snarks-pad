// Keeper-side setup: creating the pad's DBC config. This signs and pays with
// the keeper key, so it must never be imported from the HTTP API (INV-17:
// test/api-no-keeper.test.ts walks the API's import graph and fails if it is).
import { Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { config } from "../config";
import { getConnection, getDbcClient } from "../solana";
import { loadKeeperKeypair } from "../keeper";
import * as db from "../db";
import type { DbcConfigRow } from "../db";
import { KEEPER_PUBKEY_META } from "../holders";
import { buildConfigParams, checkConfigOnChain, configRefusal, latestConfigForTier, readAndVerifyConfig, tierOfRow } from "./config";
import { DEFAULT_TIER_BPS } from "./reviewed";

const { dbc } = config.solana;

/** Records the keeper's PUBLIC address where the API can read it (it must never load the secret key). */
export function recordKeeperIdentity(): PublicKey {
  const keeper = loadKeeperKeypair().publicKey;
  db.setMeta(KEEPER_PUBKEY_META, keeper.toBase58());
  return keeper;
}

/**
 * Creates a DBC config whose fee claimer (and leftover receiver) is `feeClaimer`
 * and records it after reading it back and verifying every field. The leftover
 * receiver is permanent like the fee claimer, so it is the claimer too: a
 * keeper rotation never strands anything. `tierBps` picks the reviewed fee tier (default: the SNARKS 1% config).
 */
export async function createDbcConfig(feeClaimer: PublicKey, tierBps: number = DEFAULT_TIER_BPS): Promise<DbcConfigRow> {
  const keeper = loadKeeperKeypair();
  const configKp = Keypair.generate();
  const tx = await getDbcClient().partner.createConfig({
    config: configKp.publicKey,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    quoteMint: dbc.quoteMint,
    payer: keeper.publicKey,
    ...buildConfigParams(tierBps),
  });
  await sendAndConfirmTransaction(getConnection(), tx, [keeper, configKp], { commitment: "confirmed" });
  const row = await readAndVerifyConfig(configKp.publicKey, feeClaimer, tierBps);
  db.insertDbcConfig(row);
  return row;
}

/**
 * The config new launches use. Order: a config already recorded in the DB, re-checked
 * on chain (local/devnet: recreated if the chain no longer has it; elsewhere: refused); else
 * the one named by DBC_CONFIG_ID (mainnet: the owner creates it; it is read
 * back and verified, never trusted); else the keeper creates one (local and
 * devnet only: outside them a config is permanent and the owner signs it).
 * The fee claimer is FEE_CLAIMER_PUBKEY when set (the Squads vault), else the keeper.
 */
export async function ensureDbcConfig(): Promise<DbcConfigRow> {
  const keeper = recordKeeperIdentity();
  const claimer = dbc.feeClaimer ?? keeper;
  // The default (SNARKS) config only: a fee-tier config being the newest row must never become the pad's default one.
  const recorded = dbc.configId ? db.getDbcConfig(dbc.configId.toBase58()) : latestConfigForTier(DEFAULT_TIER_BPS);
  if (recorded) {
    const check = await checkConfigOnChain(new PublicKey(recorded.configId), new PublicKey(recorded.feeClaimer), tierOfRow(recorded));
    if (check.ok) return recorded;
    // Local/devnet with no pinned config: the chain was reset or no longer
    // matches the row, so create a fresh one (it becomes the newest row). Anywhere a
    // config is permanent or pinned, refuse rather than trust the DB.
    if (dbc.configId || (!config.isLocal && config.mode !== "devnet")) throw configRefusal(recorded.configId, check.problems);
    return createDbcConfig(claimer);
  }
  if (dbc.configId) {
    const row = await readAndVerifyConfig(dbc.configId, claimer);
    db.insertDbcConfig(row);
    return row;
  }
  if (!config.isLocal && config.mode !== "devnet") {
    throw new Error("set DBC_CONFIG_ID: a mainnet DBC config is permanent, so the owner creates it and the pad only reads it back");
  }
  return createDbcConfig(claimer);
}
