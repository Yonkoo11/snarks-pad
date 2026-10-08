#!/usr/bin/env bun
// S4 ST-SSE-02: the "keeper process" of the stream test. Records `count` trades of `mint` into the database named by PAD_DB_FILE, one every
// `gapMs`, through the engine's own db module (the same insert trade-confirm and the seed scripts use), and prints `n sig atMs` per row.
//   PAD_DB_FILE=<db> bun stress/s4/sse-writer.ts <mint> <wallet> <count> <gapMs>
import * as db from "../../src/db";

const [mint, wallet, countArg, gapArg] = process.argv.slice(2);
const count = Number(countArg ?? 100);
const gap = Number(gapArg ?? 200);
const run = `${Date.now()}-${process.pid}`;
for (let i = 0; i < count; i++) {
  const sig = `s4-${run}-${i}`;
  db.insertTrade({ sig, mint: mint!, side: i % 2 ? "sell" : "buy", wallet: wallet!, amountToken: String(1_000 + i), amountZec: String(10_000 + i), at: new Date().toISOString() });
  console.log(`${i} ${sig} ${Date.now()}`);
  if (gap > 0) await Bun.sleep(gap);
}
