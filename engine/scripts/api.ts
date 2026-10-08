#!/usr/bin/env bun
import { config } from "../src/config";
import { startApiServer } from "../src/api";
import { startRpcUsageFlush } from "../src/rpcBudget";
import { assertStartable } from "../src/startupChecks";

assertStartable("api", config.mode); // audit S6: no mainnet API on the public RPC; an unserved PUBLIC_DIR is called out
const server = startApiServer();
// This process counts its RPC calls per method and writes them to the rpc_usage table once an hour (src/rpcBudget.ts), and once more when it is stopped.
const stopRpcUsageFlush = startRpcUsageFlush("api");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopRpcUsageFlush();
    process.exit(0);
  });
}
console.log(`snarks-engine API on :${server.port} (PAD_MODE=${config.mode}, RPC host ${config.solana.rpcHost})`);
