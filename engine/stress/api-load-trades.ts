#!/usr/bin/env bun
// The writer of the stream scenario in stress/api-load.ts (contract v2.6): records one trade every 400 ms into the database the API serves
// (PAD_DB_FILE), as another process would, so the API's event streams hear trades it did not record itself. Stopped by the harness.
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";

const coins = db.listCoins().filter((c) => c.status === "launched");
if (coins.length === 0) throw new Error("the database has no launched coin");
for (let i = 0; ; i++) {
  const coin = coins[i % coins.length]!;
  db.insertTrade({
    sig: `stream-load-${Date.now()}-${i}`, mint: coin.mint, side: i % 3 === 0 ? "sell" : "buy", wallet: Keypair.generate().publicKey.toBase58(),
    amountToken: "1000000000", amountZec: String(1_000_000 + (i % 50) * 10_000), at: new Date().toISOString(),
  });
  await Bun.sleep(400);
}
