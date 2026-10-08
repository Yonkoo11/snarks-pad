#!/usr/bin/env bun
// The keeper loop (src/scheduler.ts): runs epochs on their cadence, takes the random holder samples, honors the
// kill switch (PAYOUTS_PAUSED=1 or the pause file), and shuts down gracefully on SIGINT/SIGTERM: an epoch in
// flight stops at its next safe point and the next start resumes it.
//   bun run keeper            loop forever (one tick a minute by default)
//   bun run keeper -- --once  one tick, then exit (for cron or a drill)
// Cadence: PAD_EPOCH_EVERY_HOURS (48), PAD_SHIELDED_EVERY_DAYS (7), PAD_FIRST_EPOCH_AT (ISO), PAD_KEEPER_TICK_MS,
// PAD_RESUME_EVERY_MS. Health log: engine/data/keeper-health.log (one JSON line per event; on devnet also the faucet's fills left).
// RPC use: this process counts its calls per method and writes them to the rpc_usage table once an hour (and when it stops); with PAD_RPC_MONTHLY_CREDITS set the
// loop warns when the month projects past 50% and 80% of the plan (src/rpcBudget.ts).
import { config } from "../src/config";
import { runEpoch } from "../src/epoch/engine";
import { takeDueSamples } from "../src/epoch/snapshots";
import { readFaucet } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { requestStop } from "../src/pause";
import { startRpcUsageFlush } from "../src/rpcBudget";
import { appendHealthLine, runKeeperLoop } from "../src/scheduler";
import { assertStartable } from "../src/startupChecks";
import { getConnection } from "../src/solana";
import { selectSwapAdapter } from "../src/swap/select";

let stopping = false;
let wake: () => void = () => {};
const stopSignal = new Promise<void>((resolve) => {
  wake = resolve;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1); // a second signal: the operator is not waiting for a safe point
    stopping = true;
    requestStop(); // the epoch in flight stops at its next safe point
    appendHealthLine({ at: new Date().toISOString(), event: "stopping", signal });
    wake();
  });
}

assertStartable("keeper", config.mode); // audit S6: never a mainnet round on the public RPC; the regtest lightwalletd default is called out
const stopRpcUsageFlush = startRpcUsageFlush("keeper");
const swap = selectSwapAdapter(); // refuses to start outside local mode without the treasury settings
console.log(`snarks-engine keeper (PAD_MODE=${config.mode}, RPC host ${config.solana.rpcHost}, claim co-signer ${config.devnetCoSignerKeypair ? "set (test network: the keeper approves its own claims after decoding them)" : "none: the owner approves every claim"})`);
appendHealthLine({ at: new Date().toISOString(), event: "started", mode: config.mode, rpcHost: config.solana.rpcHost, epochEveryMs: config.scheduler.epochEveryMs, shieldedEveryMs: config.scheduler.shieldedEveryMs });
const ticks = await runKeeperLoop(
  {
    nowMs: Date.now,
    runEpoch: ({ includeShielded }) => runEpoch(swap, undefined, { includeShielded }),
    takeDueSamples,
    readFaucet, // devnet only: null elsewhere, so mainnet and local runs never look for a faucet key
    readKeeperSol: async () => {
      const keeper = loadKeeperKeypair().publicKey;
      return { address: keeper.toBase58(), lamports: await getConnection().getBalance(keeper, "confirmed") };
    },
    probeChain: () => getConnection().getSlot(), // only while backing off from a chain that could not be read (src/scheduler.ts)
    rpcMonthlyCredits: config.rpc.monthlyCredits,
    log: appendHealthLine,
  },
  {
    tickMs: config.scheduler.tickMs,
    once: process.argv.includes("--once"),
    shouldStop: () => stopping,
    sleep: (ms) => Promise.race([Bun.sleep(ms), stopSignal]),
  },
);
stopRpcUsageFlush(); // the counts of the hour in progress
appendHealthLine({ at: new Date().toISOString(), event: "stopped", ticks });
process.exit(0);
