#!/usr/bin/env bun
// Runs one epoch: migrate any coin whose curve is full, claim every launched
// coin's pool fee (already ZEC), pay default holders directly and opted-in
// holders through one batched shielded payout. Resumable: see src/epoch/engine.ts.
import { config } from "../src/config";
import { runEpoch } from "../src/epoch/engine";
import { assertStartable } from "../src/startupChecks";
import { selectSwapAdapter } from "../src/swap/select";
import { getBalance } from "../src/zcash/devtool";
import { TREASURY_DIR } from "../src/zcash/regtest";

async function main(): Promise<void> {
  assertStartable("keeper", config.mode); // a manual mainnet round obeys the same rule as the keeper (audit S6)
  const swap = selectSwapAdapter();
  const { epoch, awaitingClaims, paused, halted } = await runEpoch(swap);
  if (paused) console.log("payouts are paused, nothing was claimed or sent:", paused);
  else if (halted) console.log("no new epoch was started; an earlier epoch needs attention:\n  " + halted.join("\n  "));
  else if (awaitingClaims) console.log("epoch waiting, nothing was finalized or paid; the next run resumes it:\n  " + awaitingClaims.join("\n  "));
  else if (epoch) console.log("epoch", epoch.id, "status", epoch.status, "harvestedZats", epoch.harvestedZats);
  else console.log("no fees to claim this epoch; no epoch recorded");
  if (config.isLocal) console.log("treasury shielded spendable:", getBalance(TREASURY_DIR).spendableZats.toString(), "zats");
}

main().catch((err) => {
  console.error("epoch run failed:", err);
  process.exit(1);
});
