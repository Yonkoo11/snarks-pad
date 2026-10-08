#!/usr/bin/env bun
// Reads tier configs off the chain and runs the reviewed full-field check on each, read-only: nothing is signed or sent. This is the "reviewed output" of
// audit/CONFIG-REVIEW-TIERS.md section 5 and the gate G12 of ops/MAINNET-RUNBOOK.md (the configs carry the launch window, to the unit).
//   scripts/devnet.sh bun scripts/review-configs.ts --from ../probe/fee-scheduler/results/d3-devnet-configs.json
//   PAD_MODE=devnet DEVNET_QUOTE_MINT=<mint> bun scripts/review-configs.ts --claimer <vault> --config 100=<id> --config 200=<id> ...
//   PAD_MODE=mainnet bun scripts/review-configs.ts --claimer <vault> --config 100=<id> ...        (the mainnet check: reads only)
// A results file is `{ claimer, configs: [{ tier, id }] }`. Exit 0 only when every config has 0 mismatches against the reviewed spec of ITS tier AND the fee schedule
// worked out from the chain's own fields, second by second, equals the reviewed table. Any other exit means do not launch on it.
import { PublicKey } from "@solana/web3.js";
import { ActivationType, feeNumeratorToBps } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { config } from "../src/config";
import { verifyConfigState } from "../src/dbc/config";
import { windowScheduleOf } from "../src/dbc/reviewed";
import { feeBpsAt, scheduleOfState } from "../src/dbc/window";
import { getDbcClient } from "../src/solana";

interface Target {
  tier: number;
  id: string;
}

const argAll = (name: string): string[] => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
const argOne = (name: string): string | undefined => argAll(name)[0];

function targets(): { claimer: PublicKey; list: Target[] } {
  const from = argOne("--from");
  const file = from ? (JSON.parse(readFileSync(from, "utf8")) as { claimer?: string; configs: Target[] }) : null;
  const claimer = argOne("--claimer") ?? file?.claimer;
  if (!claimer) throw new Error("usage: review-configs.ts (--from <results.json> | --claimer <vault> --config <tierBps>=<configId> ...)");
  const pairs = argAll("--config").map((p) => {
    const [tier, id] = p.split("=");
    return { tier: Number(tier), id: id ?? "" };
  });
  return { claimer: new PublicKey(claimer), list: [...(file?.configs ?? []), ...pairs] };
}

const pct = (bps: number): string => `${bps / 100}%`;

/** One config: the reviewed check's mismatches, the scheduler's fields as the chain stores them, and the fee second by second from those fields. */
async function review(t: Target, claimer: PublicKey): Promise<{ line: string; ok: boolean }> {
  const state = await getDbcClient().state.getPoolConfig(new PublicKey(t.id));
  if (!state) return { line: `tier ${t.tier} bps config ${t.id}: NOT FOUND on ${config.mode}`, ok: false };
  const problems = verifyConfigState(state, claimer, t.tier);
  const sched = scheduleOfState(state);
  const want = windowScheduleOf(t.tier === 100 ? config.solana.dbc.feeBps : t.tier);
  const seconds = Array.from({ length: want.periods + 2 }, (_, k) => k);
  const fromChain = seconds.map((k) => feeBpsAt(sched, new BN(0), new BN(k * want.periodSeconds)));
  const table = [...want.feeByPeriodBps, want.endBps];
  const sameTable = fromChain.every((b, i) => b === table[i]);
  const mismatches = problems.length + (sameTable ? 0 : 1);
  const fields = `cliff ${sched.cliffNumerator} (${pct(Math.round(feeNumeratorToBps(sched.cliffNumerator)))}), ${sched.periods} steps x ${sched.periodSeconds} s, reduction ${sched.reductionFactor}, mode ${sched.mode}, first-swap-min-fee ${sched.firstSwapAtEndFee ? 1 : 0}, activation ${sched.activationType === ActivationType.Timestamp ? "Timestamp" : "Slot"}`;
  const head = `tier ${t.tier} bps config ${t.id}: ${mismatches} mismatches against the reviewed spec of tier ${t.tier}`;
  const body = `\n    on chain: ${fields}\n    fee by second 0..${seconds.length - 1}, from the chain's own fields: ${fromChain.map(pct).join(" ")}; reviewed table: ${table.map(pct).join(" ")}: ${sameTable ? "equal" : "DIFFERENT"}`;
  const detail = problems.map((p) => `\n    MISMATCH ${p}`).join("");
  return { line: head + body + detail, ok: mismatches === 0 };
}

const { claimer, list } = targets();
if (list.length === 0) throw new Error("no configs to review");
console.log(`cluster ${config.mode}, fee claimer ${claimer.toBase58()}, quote mint ${config.solana.dbc.quoteMint.toBase58()}`);
let bad = 0;
for (const t of list) {
  const r = await review(t, claimer);
  console.log(r.line);
  if (!r.ok) bad++;
}
console.log(bad === 0 ? `REVIEWED: ${list.length} of ${list.length} configs, 0 mismatches` : `REFUSED: ${bad} of ${list.length} configs have mismatches; launch on none of them`);
process.exit(bad === 0 ? 0 : 1);
