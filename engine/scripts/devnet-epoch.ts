#!/usr/bin/env bun
// Drives ONE epoch on devnet to the end, the way the keeper loop plus the owner would: runs `epoch`, and whenever the
// run stops for the Squads vault claim it prints each waiting proposal DECODED from its stored message (who gets paid)
// and approves it with the stand-in owner key through the documented command (scripts/squads-proposals.ts approve);
// then it reruns until the epoch is `ok` (the simulated swap waits for Zcash testnet confirmations between runs).
// Run detached; every step is printed:
//   nohup scripts/devnet.sh bun scripts/devnet-epoch.ts > data/devnet-epoch.log 2>&1 &
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { listActiveProposals } from "../src/dbc/squads";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");
const multisig = config.solana.dbc.squadsMultisig;
const ownerKey = process.env.DEVNET_OWNER_KEYPAIR;
if (!multisig || !ownerKey) throw new Error("SQUADS_MULTISIG and DEVNET_OWNER_KEYPAIR must be set (scripts/devnet.sh loads them)");
const MAX_RUNS = Number(process.env.DEVNET_EPOCH_MAX_RUNS ?? 90);
const WAIT_MS = Number(process.env.DEVNET_EPOCH_WAIT_MS ?? 60_000);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function run(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", ...args], { cwd: config.paths.engineRoot, env: process.env });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  return { code: r.exitCode ?? 1, out };
}

async function approveWaitingProposals(): Promise<number> {
  const waiting = await listActiveProposals(getConnection(), multisig!);
  for (const p of waiting) {
    log(`PROPOSAL ${p.index} waiting for the owner; decoded from the stored message, then approved by the stand-in owner key:`);
    const r = run(["scripts/squads-proposals.ts", "approve", String(p.index), ownerKey!]);
    console.log(r.out.trim());
    if (r.code !== 0) throw new Error(`approving proposal ${p.index} failed`);
  }
  return waiting.length;
}

for (let i = 1; i <= MAX_RUNS; i++) {
  log(`epoch run ${i}`);
  const r = run(["scripts/epoch.ts"]);
  console.log(r.out.trim());
  const done = /^epoch (\S+) status ok\b/m.exec(r.out);
  if (done) {
    log("EPOCH OK", done[1]);
    process.exit(0);
  }
  if (/epoch waiting/.test(r.out)) log("approved proposals:", await approveWaitingProposals());
  if (/payouts are paused|an earlier epoch needs attention|epoch run failed/.test(r.out)) throw new Error("the epoch stopped for a reason a rerun will not fix; see the output above");
  await Bun.sleep(WAIT_MS);
}
throw new Error(`the epoch was not ok after ${MAX_RUNS} runs`);
