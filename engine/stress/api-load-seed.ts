#!/usr/bin/env bun
// Gives a seeded local database the size the API load step (stress/api-load.ts, audit/STRESS-REPORT.md scenario 5) runs on:
// recorded trades spread over the last 24 hours, two published epochs of paid-out rows, opted-in wallets and one large holder
// sample. The coins stay the ones the local chain really has (a copy of the database `bun run e2e` leaves), so every pool view
// is a real read; everything added here is database rows only. Writes the wallet list api-load.ts takes.
//   PAD_DB_FILE=<copy of a seeded local db> bun stress/api-load-seed.ts <wallets.json>
import { writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";

const N_TRADES = Number(Bun.env.TRADES ?? 3000);
const N_OPTIN = Number(Bun.env.OPTIN ?? 720);
const N_PAID_PER_EPOCH = Number(Bun.env.PAID ?? 2000);
const N_SAMPLE = Number(Bun.env.SAMPLE ?? 2100);
const HOUR = 3_600_000;
const wallet = () => Keypair.generate().publicKey.toBase58();

const coins = db.listCoins().filter((c) => c.status === "launched");
if (coins.length === 0) throw new Error("the database has no launched coin: seed it with `bun run e2e` first, and give this script a copy of it");
const holders = Array.from({ length: N_SAMPLE }, wallet);

for (let i = 0; i < N_TRADES; i++) {
  const coin = coins[i % coins.length]!;
  const zats = 1_000_000 + ((i * 7_919) % 90_000_000);
  db.insertTrade({
    sig: `load-${i}-${wallet()}`, mint: coin.mint, side: i % 4 === 0 ? "sell" : "buy", wallet: holders[i % holders.length]!,
    amountToken: String(BigInt(zats) * 1_700_000n), amountZec: String(zats), at: new Date(Date.now() - ((i * 28_800) % (23 * HOUR))).toISOString(),
  });
}

for (let e = 0; e < 2; e++) {
  const id = `epoch-load-${e}-${crypto.randomUUID()}`;
  db.upsertEpoch({
    id, at: new Date(Date.now() - (e + 1) * 48 * HOUR).toISOString(), coinMints: JSON.stringify(coins.map((c) => c.mint)), harvestedZats: "40000000", feeZats: "0",
    status: "ok", swapProvider: null, swapRef: null, swapState: "settled", swapAmountOutZats: "0", zcashTxids: "[]",
  });
  for (let i = 0; i < N_PAID_PER_EPOCH; i++) {
    const w = holders[i % holders.length]!;
    const shielded = i % 3 === 0;
    db.planPayout({ epochId: id, wallet: w, kind: shielded ? "shielded" : "solana", amountZats: String(10_000 + (i % 977)), ...(shielded ? { zcashAddress: "uregtest1loadtestaddressnotarealone" } : {}) });
    db.markPayoutSent(id, w, shielded ? "shielded" : "solana", shielded ? "d".repeat(64) : `load-sig-${e}-${i}`);
  }
}

const optins = holders.slice(0, N_OPTIN);
for (const w of optins) db.upsertOptin(w, "uregtest1loadtestaddressnotarealone");
db.insertHolderSample(coins[0]!.mint, new Date().toISOString(), holders.map((w) => ({ wallet: w, balance: 1_000_000n })));

const out = process.argv[2];
if (!out) throw new Error("usage: bun stress/api-load-seed.ts <wallets.json>");
writeFileSync(out, JSON.stringify({ mints: Object.fromEntries(coins.map((c) => [c.symbol, c.mint])), holders: holders.slice(0, 200), optins: optins.slice(0, 50).map((wallet) => ({ wallet })) }), { mode: 0o600 });
console.log(`seeded ${coins.length} coins with ${N_TRADES} trades in the last 24 h, 2 epochs x ${N_PAID_PER_EPOCH} paid rows, ${N_OPTIN} opt-ins, one ${N_SAMPLE}-holder sample -> ${out}`);
