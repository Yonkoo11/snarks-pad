#!/usr/bin/env bun
// S4 ST-LW-01 and ST-LW-02: the launch window's live fee at the period boundaries and under server-clock skew, as tables, plus the measured
// distance between a chain's own clock (the block time of the newest slot, what the program charges by) and this machine's wall clock.
//   bun stress/s4/window-clock.ts [--devnet]       (--devnet also samples the public devnet endpoint, read-only, 20 getBlockTime calls)
// No chain write, no key.
import { Connection } from "@solana/web3.js";
import { ActivationType, getCurrentPoint, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { buildConfigParams } from "../../src/dbc/config";
import { CLOCK_MARGIN_SECONDS, feeBpsAt, scheduleOfState, windowNowByClock } from "../../src/dbc/window";

const cfg = { poolFees: { baseFee: buildConfigParams(100).poolFees.baseFee }, activationType: ActivationType.Timestamp, enableFirstSwapWithMinFee: 1 } as unknown as PoolConfig;
const s = scheduleOfState(cfg);
const ACTIVATION = 1_791_163_393;
const act = new BN(ACTIVATION);
const chainFee = (second: number): number => feeBpsAt(s, act, new BN(ACTIVATION + Math.floor(second)));
const fmt = (bps: number | null): string => (bps === null ? "null" : `${bps / 100}%`);

console.log(`## ST-LW-01 feeNowBps by the server clock (read ${CLOCK_MARGIN_SECONDS} s back) against the chain's step at the same instant, 1% tier`);
console.log("| t after activation | chain charges (floor t) | engine feeNowBps | engine secondsLeft | engine vs chain |");
console.log("|---|---|---|---|---|");
let belowChain = 0;
for (const t of [0, 0.5, 0.99, 1.0, 1.01, 1.99, 2.01, 2.99, 3.01, 3.99, 4.01, 4.99, 5.0, 5.01, 5.99, 6.0, 6.01, 7.5]) {
  const e = windowNowByClock(s, act, (ACTIVATION + t) * 1000);
  const c = chainFee(t);
  const rel = e.feeNowBps === null ? "?" : e.feeNowBps > c ? "higher (safe, one step late)" : e.feeNowBps === c ? "equal" : "LOWER (unsafe)";
  if (e.feeNowBps !== null && e.feeNowBps < c) belowChain++;
  console.log(`| ${t.toFixed(2)} s | ${fmt(c)} | ${fmt(e.feeNowBps)} | ${e.windowSecondsLeft} | ${rel} |`);
}
console.log(`\nRows where the engine's fee is below the chain's: ${belowChain}\n`);

console.log("## ST-LW-02 the server's clock off the chain's by -3 .. +3 s (positive = server ahead): the engine's fee at each chain second");
console.log("| chain second | chain charges | skew -3 s | -2 s | -1 s | 0 | +1 s | +2 s | +3 s |");
console.log("|---|---|---|---|---|---|---|---|---|");
const unsafe: string[] = [];
for (let second = 0; second <= 7; second++) {
  const cells = [-3, -2, -1, 0, 1, 2, 3].map((skew) => {
    const e = windowNowByClock(s, act, (ACTIVATION + second + 0.5 + skew) * 1000);
    const c = chainFee(second + 0.5);
    if (e.feeNowBps !== null && e.feeNowBps < c) unsafe.push(`skew ${skew > 0 ? "+" : ""}${skew} s at chain second ${second}: engine ${fmt(e.feeNowBps)} (left ${e.windowSecondsLeft}) while the chain charges ${fmt(c)}`);
    return `${fmt(e.feeNowBps)}${e.windowSecondsLeft ? ` (${e.windowSecondsLeft} s)` : ""}`;
  });
  console.log(`| ${second} | ${fmt(chainFee(second + 0.5))} | ${cells.join(" | ")} |`);
}
console.log("\nCells where the engine shows a lower fee than the chain charges (Buy would open while the window is still charging):");
for (const u of unsafe) console.log(`- ${u}`);
if (unsafe.length === 0) console.log("- none");

async function skewOf(conn: Connection, label: string, samples: number, gapMs: number): Promise<void> {
  const rows: { slot: number; blockTime: number | null; wall: number; sdkPoint: number }[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      const slot = await conn.getSlot("confirmed");
      const sdkPoint = Number((await getCurrentPoint(conn, ActivationType.Timestamp)).toString());
      const blockTime = await conn.getBlockTime(slot);
      rows.push({ slot, blockTime, wall: Date.now() / 1000, sdkPoint });
    } catch (err) {
      console.log(`- ${label}: sample ${i} failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
    await Bun.sleep(gapMs);
  }
  const skews = rows.filter((r) => r.blockTime !== null).map((r) => r.wall - r.blockTime!);
  const sdkSkews = rows.map((r) => r.wall - r.sdkPoint);
  const stat = (a: number[]): string => (a.length ? `min ${Math.min(...a).toFixed(2)} s, median ${[...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!.toFixed(2)} s, max ${Math.max(...a).toFixed(2)} s over ${a.length}` : "no samples");
  console.log(`\n### ${label}: wall clock minus the chain's clock (positive = the chain trails this machine)`);
  console.log(`- getBlockTime(newest confirmed slot): ${stat(skews)}`);
  console.log(`- the SDK's getCurrentPoint (what the quote uses): ${stat(sdkSkews)}`);
  const over = skews.filter((x) => x > CLOCK_MARGIN_SECONDS).length;
  console.log(`- samples where the chain trails by more than the ${CLOCK_MARGIN_SECONDS} s margin: ${over} of ${skews.length}`);
}

console.log("\n## Measured clock distance");
await skewOf(new Connection("http://127.0.0.1:8899", "confirmed"), "local validator (same machine)", 20, 300);
if (process.argv.includes("--devnet")) await skewOf(new Connection("https://api.devnet.solana.com", "confirmed"), "devnet (public endpoint, read-only)", 20, 600);
