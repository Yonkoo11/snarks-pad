#!/usr/bin/env bun
// S4 ST-RG-04/05/07: the keeper's holder-sample round through a counting stub RPC (stress/s4/stub-rpc.ts in front of the local validator), in a
// process whose guard is set like the devnet instance's. The real `takeDueSamples` runs on a plan whose every instant is already due, so the
// round is one observation of every launched coin.
//   PAD_MODE=local PAD_DB_FILE=<a copy of s4-live.sqlite> SOLANA_LOCAL_RPC=http://127.0.0.1:<stub> PAD_RPC_MAX_PER_SECOND=7 PAD_RPC_SCAN_MAX_PER_SECOND=1 \
//     bun stress/s4/keeper-samples.ts <stub base> paced|scanfail|scanfail-all
import * as db from "../../src/db";
import { ensurePlan, loadPlan, minimumBalanceHolders, takeDueSamples } from "../../src/epoch/snapshots";

const stub = process.argv[2]!;
const mode = process.argv[3] ?? "paced";
const rule = async (q: string): Promise<void> => void (await fetch(`${stub}/__rule?${q}`));
const reset = async (): Promise<void> => void (await fetch(`${stub}/__reset`, { method: "POST" }));
const stats = async (): Promise<Record<string, any>> => (await fetch(`${stub}/__stats`)).json() as Promise<Record<string, any>>;

const coins = db.listCoins().filter((c) => c.status === "launched");
const errors: string[] = [];
const realError = console.error;
console.error = (...a: unknown[]) => {
  errors.push(a.map(String).join(" "));
  realError(...a);
};

if (mode === "paced") await rule("mode=ok&cap=7&scanCap=1");
if (mode === "scanfail") await rule("methods=getProgramAccounts&mode=429&after=4");
if (mode === "scanfail-all") await rule("methods=getProgramAccounts&mode=429");
await reset();

const now = Date.now();
db.getDb().query("DELETE FROM meta WHERE key = 'snapshot_plan'").run();
const plan = ensurePlan(now - 6 * 3_600_000, now, 6); // six instants in the past six hours: all due now
const t0 = performance.now();
const consumed = await takeDueSamples(now, plan);
const ms = Math.round(performance.now() - t0);
const at = new Date(now).toISOString();
const stored = coins.filter((c) => db.listHolderSamples(c.mint, new Date(now - 1).toISOString(), at).length > 0).length;
const after = loadPlan()!;
const s = await stats();
console.log(JSON.stringify({
  mode, coins: coins.length, consumed, planTakenBefore: plan.taken, planTakenAfter: after.taken, storedSamples: stored, roundMs: ms,
  stub: { total: s.total, served: s.served, maxPerSecond: s.maxPerSecond, byMethod: s.byMethod },
  errorLines: errors.length, firstErrors: errors.slice(0, 3).map((e) => e.slice(0, 140)),
}));

if (mode !== "paced") {
  // The exact effect of a lost slot on a holder's weight: the minimum is taken over the samples that were stored, so a slot that failed is one check fewer.
  const a = "holderA";
  const sniper = "sniperB";
  const six = [[[a, 100n], [sniper, 0n]], [[a, 100n]], [[a, 100n], [sniper, 900n]], [[a, 100n], [sniper, 900n]], [[a, 100n], [sniper, 900n]], [[a, 100n], [sniper, 900n]]] as [string, bigint][][];
  const claim = [[a, 100n], [sniper, 900n]] as [string, bigint][];
  const toHolders = (rows: [string, bigint][]) => rows.filter(([, b]) => b > 0n).map(([wallet, balance]) => ({ wallet, balance }));
  const withAll = minimumBalanceHolders([...six.map(toHolders), toHolders(claim)]);
  const lostFirstTwo = minimumBalanceHolders([...six.slice(2).map(toHolders), toHolders(claim)]);
  console.log(JSON.stringify({
    weightEffect: {
      rule: "a holder's weight is its least balance across the stored samples plus the claim-time one; a wallet absent from any stored sample weighs 0",
      allSixStored: Object.fromEntries(withAll.map((h) => [h.wallet, h.balance.toString()])),
      slots1and2Lost: Object.fromEntries(lostFirstTwo.map((h) => [h.wallet, h.balance.toString()])),
      reading: "the sniper that bought after slot 2 weighs 0 with all six samples and 900 when the first two slots were lost: a lost slot can only raise a weight, never lower it, and the plan's counter still advanced",
      mainnetGate: "with minWindowSamples 3 (mainnet) a coin with fewer than 3 stored samples in the window is not claimed in that epoch (engine/src/epoch/engine.ts claimOneCoin), so a round where 4 of 6 slots are lost leaves every coin unclaimed until a later epoch",
    },
  }));
}
