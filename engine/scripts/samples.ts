#!/usr/bin/env bun
// Holder samples of the current window, by coin: `bun scripts/samples.ts` lists them (read-only); `--take` stores one more
// sample of every launched coin right now, the same observation the keeper takes at its random instants (src/epoch/snapshots.ts).
// Written 2026-10-12 when a manual round was refused by the sample gate (PAD_SNAPSHOT_MIN_SAMPLES) and the keeper logs nothing about samples.
import { config } from "../src/config";
import * as db from "../src/db";
import { loadPlan, takeSamplesNow } from "../src/epoch/snapshots";

async function main(): Promise<void> {
  const now = Date.now();
  if (process.argv.includes("--take")) console.log("stored samples of", await takeSamplesNow(now), "coins at", new Date(now).toISOString());
  const plan = loadPlan();
  if (!plan) {
    console.log("no snapshot plan yet (the keeper draws one on its first tick of a window)");
    return;
  }
  const start = new Date(plan.windowStartMs).toISOString();
  const end = new Date(plan.windowEndMs).toISOString();
  console.log(`window ${start} to ${end}; planned instants ${plan.times.length}, taken ${plan.taken}; ${config.epoch.snapshots.minWindowSamples} per coin required to claim`);
  for (const coin of db.listCoins()) {
    if (coin.status !== "launched") continue;
    const samples = db.listHolderSamples(coin.mint, start, new Date(now).toISOString());
    const when = samples.map((s) => `${s.takenAt.slice(5, 16).replace("T", " ")} (${s.holders.length} holders)`).join(", ");
    console.log(`${coin.symbol.padEnd(10)} ${samples.length} sample${samples.length === 1 ? "" : "s"}${when ? ": " + when : ""}`);
  }
}

main().catch((err) => {
  console.error("samples failed:", err);
  process.exit(1);
});
