#!/usr/bin/env bun
// Seeds the S4 live database: real coins launched on the local validator (the MAINNET DBC binary) through the engine's own launch builder, each
// creator a fresh key the keeper funds; three recorded trade rows and one keeper holder sample per coin for the list, tape and stream cases; a
// 4% tier config for the Creator-wallet case; seven epoch rows with formula-shaped ids for the CSV case (status ok, dated 2020 so they never
// read as the latest round).
//   PAD_MODE=local PAD_DB_FILE=data/stress/s4-live.sqlite PUBLIC_DIR=data/stress/s4-public PAD_FEATURED_MINTS= bun stress/s4/seed-live.ts [count=40]
// Writes data/stress/s4-seed.json: { configId100, configId400, mints, creators } (the creators' secret keys: local test wallets only).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { config } from "../../src/config";
import * as db from "../../src/db";
import { buildLaunchTx, confirmLaunch } from "../../src/dbc/launch";
import { createDbcConfig, ensureDbcConfig, recordKeeperIdentity } from "../../src/dbc/setup";
import { fundTestWallet } from "../../src/faucet";
import { loadKeeperKeypair } from "../../src/keeper";
import { getConnection } from "../../src/solana";

if (!config.isLocal) throw new Error("local only");
const count = Number(process.argv[2] ?? 40);
const keeper = loadKeeperKeypair();
const claimer = recordKeeperIdentity();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const one = await ensureDbcConfig();
const four = await createDbcConfig(claimer, 400);
log(`configs: 1% ${one.configId}, 4% ${four.configId}`);

const mints: string[] = [];
const creators: number[][] = [];
const conn = getConnection();
for (let i = 0; i < count; i++) {
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 1, keeper);
  const r = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: `S4 coin ${i + 1}`, symbol: `S4C${i + 1}`, description: `stress coin ${i + 1}`, imageUrl: "", initialBuyZats: "20000000", feeTier: 100, socials: {} });
  const tx = VersionedTransaction.deserialize(Buffer.from(r.txBase64, "base64"));
  tx.sign([creator]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  await confirmLaunch(sig, r.mint);
  const now = Date.now();
  for (let t = 0; t < 3; t++) {
    db.insertTrade({ sig: `seed-${r.mint.slice(0, 8)}-${t}`, mint: r.mint, side: t === 1 ? "sell" : "buy", wallet: t === 0 ? creator.publicKey.toBase58() : Keypair.generate().publicKey.toBase58(), amountToken: "1000000", amountZec: "500000", at: new Date(now - (3 - t) * 60_000).toISOString() });
  }
  db.insertHolderSample(r.mint, new Date(now).toISOString(), [{ wallet: creator.publicKey.toBase58(), balance: 1_000_000n }]);
  mints.push(r.mint);
  creators.push(Array.from(creator.secretKey));
  log(`launched ${i + 1}/${count} ${r.mint}`);
}

const hostile = ['=HYPERLINK("http://evil.example")', "+cmd|' /C calc'!A0", "-2+3+cmd", "@SUM(1+1)*cmd", "\tTab start", "\rCR start", "-1"];
hostile.forEach((id, i) => {
  db.upsertEpoch({ id, at: `2020-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, coinMints: JSON.stringify(["=1+1", "+x", "-x", "@x"]), harvestedZats: "0", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
});
const file = join(config.paths.dataDir, "stress", "s4-seed.json");
writeFileSync(file, JSON.stringify({ configId100: one.configId, configId400: four.configId, mints, creators, hostileEpochIds: hostile }, null, 2));
log(`seed written: ${file} (${mints.length} coins)`);
