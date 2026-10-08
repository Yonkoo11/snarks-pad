#!/usr/bin/env bun
// Scenario 3 driver (audit/STRESS-REPORT.md): rounds of new trades, then an epoch run under one injected failure
// (SIGKILL at a chosen point, RPC faults through stress/fault-proxy.ts, lightwalletd stopped, fake 1Click faults,
// clock skew, a full disk, two keepers), then plain restarts until the epoch is finished, then the independent check
// (stress/scale-check.ts post, carry chained from the previous round). One JSON line per round in chaos-results.jsonl.
// Run from engine/ with the chaos environment:  . stress/chaos-env.sh && nohup bun stress/chaos.ts [firstRound] > ... &
// Needs: stress/fault-proxy.ts on :18899, stress/fake-1click-server.ts on :18950, the chaos setup done.
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { approveProposal, listActiveProposals } from "../src/dbc/squads";
import { PublicKey } from "@solana/web3.js";
import { STRESS_DIR, direct, kpFromJson } from "./lib";

const WALLETS = join(STRESS_DIR, "chaos-wallets.json");
const W = JSON.parse(readFileSync(WALLETS, "utf8")) as { mints: Record<string, string>; squads: { multisig: string; owner: number[] } };
const LOG = join(STRESS_DIR, "chaos.log");
const RESULTS = join(STRESS_DIR, "chaos-results.jsonl");
const PROXY = "http://127.0.0.1:18899";
const FAKE = "http://127.0.0.1:18950";
const MAIN_DB = process.env.PAD_DB_FILE!;
const owner = kpFromJson(W.squads.owner);
const msPda = new PublicKey(W.squads.multisig);
const log = (...a: unknown[]) => {
  const line = `[${new Date().toISOString()}] ${a.map(String).join(" ")}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};

interface Round {
  name: string;
  kill?: string; // trigger, see triggered()
  phase?: "A" | "B"; // A = the run that claims and proposes; B = the run after the owner approved (money moves)
  rpc?: { mode: string; rate: number; delayMs?: number };
  zainodStopMs?: number;
  oneclick?: { m: string; n?: number; slowMs?: number };
  skewMs?: number;
  diskFull?: boolean;
  twoKeepers?: boolean;
  killGroup?: boolean; // also kill the devtool child
  fallback?: boolean; // the swap ends without funds delivered: opted-in holders are paid as Solana ZEC
}

const R = (ms: [number, number]) => `t:${Math.round(ms[0] + Math.random() * (ms[1] - ms[0]))}`;
const ROUNDS: Round[] = [
  { name: "kill during the claims", kill: "claim", phase: "A" },
  { name: "kill while the Squads proposal is built", kill: "squads", phase: "A" },
  { name: "kill with a Solana batch signed, not confirmed", kill: "sol-pending" },
  { name: "kill between Solana batches", kill: "sol-mid" },
  { name: "kill right after the swap was submitted", kill: "swap" },
  { name: "kill with a Zcash chunk handed to devtool", kill: "z-intent" },
  { name: "kill between Zcash chunks", kill: "z-mid" },
  { name: "kill the keeper while devtool pays (devtool lives on)", kill: "devtool" },
  { name: "kill at a random moment", kill: R([500, 20_000]) },
  { name: "RPC errors 30% + random kill", rpc: { mode: "rpcerror", rate: 0.3 }, kill: R([1000, 15_000]) },
  { name: "RPC HTTP 500 30% + kill between Solana batches", rpc: { mode: "http500", rate: 0.3 }, kill: "sol-mid" },
  { name: "RPC timeouts 5% (25 s each)", rpc: { mode: "timeout", rate: 0.05, delayMs: 25_000 } },
  { name: "RPC slow 1.5 s + kill between Zcash chunks", rpc: { mode: "slow", rate: 1, delayMs: 1500 }, kill: "z-mid" },
  { name: "lightwalletd stopped 90 s + random kill", zainodStopMs: 90_000, kill: R([3000, 30_000]) },
  { name: "1Click: success + kill right after submit", oneclick: { m: "success" }, kill: "swap" },
  { name: "1Click: status 5xx x8 + random kill", oneclick: { m: "status5xx", n: 8 }, kill: R([3000, 20_000]) },
  { name: "1Click: quote 5xx (no deposit) + kill between fallback batches", oneclick: { m: "quote5xx", n: 100_000 }, kill: "sol-mid", fallback: true },
  { name: "1Click: NO_QUOTE (no deposit)", oneclick: { m: "noquote" }, kill: R([500, 5000]), fallback: true },
  { name: "1Click: REFUNDED + kill right after submit", oneclick: { m: "refunded" }, kill: "swap", fallback: true },
  { name: "1Click: slow (60 s processing) + kill while polling", oneclick: { m: "slow", slowMs: 60_000 }, kill: "swap-poll" },
  { name: "clock 2 h fast + kill between Solana batches", skewMs: 7_200_000, kill: "sol-mid" },
  { name: "clock 2 h slow + kill between Zcash chunks", skewMs: -7_200_000, kill: "z-mid" },
  { name: "database disk full", diskFull: true },
  { name: "two keepers: the first frozen past the lock's stale time, a second takes over, the first wakes", twoKeepers: true },
  { name: "kill the keeper and its devtool child together", kill: "devtool", killGroup: true },
  { name: "kill at a random moment (2)", kill: R([500, 25_000]) },
  { name: "kill between Solana batches (again: round 4's treasury check was polluted by a test suite paying from the same regtest treasury)", kill: "sol-mid" },
  { name: "kill between Zcash chunks (again, after the D8 fee fix)", kill: "z-mid" },
  { name: "1Click: quote 5xx for the whole round (again: in round 17 the fault was lifted before the swap)", oneclick: { m: "quote5xx", n: 100_000 }, kill: "sol-mid", fallback: true },
  { name: "two keepers: the first frozen with a Solana batch signed and in flight, a second takes over, the first wakes", twoKeepers: true, kill: "sol-pending" },
  { name: "two keepers: the first frozen between Solana batches (round 24 again: its freeze was a no-op)", twoKeepers: true, kill: "sol-mid" },
  { name: "two keepers: the first frozen with a Zcash chunk handed to devtool", twoKeepers: true, kill: "z-intent" },
  { name: "two keepers: the first frozen with a Zcash chunk handed to devtool (again, after the D11 fence fix)", twoKeepers: true, kill: "z-intent" },
  { name: "two keepers: the first frozen with a Zcash chunk handed to devtool (third time: in round 33 keeper 2 found the lock fresh)", twoKeepers: true, kill: "z-intent" },
];

let dbFile = MAIN_DB;
function q<T>(sql: string, ...params: (string | number)[]): T {
  let d: Database;
  for (let i = 0; ; i++) {
    try {
      d = new Database(dbFile); // read-write handle used only to read: a readonly one cannot open a WAL file whose -shm is missing (the RAM-disk copy)
      break;
    } catch (e) {
      if (i >= 50) throw e; // a readonly open can fail for a moment while a writer checkpoints the WAL
      Bun.sleepSync(100);
    }
  }
  d.exec("PRAGMA busy_timeout = 5000");
  try {
    return d.query(sql).get(...params) as T;
  } finally {
    d.close();
  }
}
const n = (sql: string, ...p: (string | number)[]) => q<{ n: number }>(sql, ...p).n;
const roundEpoch = (since: string) => q<{ id: string; status: string; swapState: string; attempts: number } | null>("SELECT id, status, swapState, attempts FROM epochs WHERE at > ? ORDER BY at DESC LIMIT 1", since);
const procs = (): string[] => new TextDecoder().decode(Bun.spawnSync(["ps", "-Ao", "pid,args"]).stdout).split("\n");
const devtoolPids = (): number[] => procs().filter((l) => /zcash-devtool wallet -w \S+ pay /.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]));

function triggered(kill: string, since: string, startedMs: number): boolean {
  if (kill.startsWith("t:")) return Date.now() - startedMs >= Number(kill.slice(2));
  const e = roundEpoch(since);
  if (kill === "claim") return !!e && n("SELECT COUNT(*) AS n FROM claim_progress WHERE epochId = ?", e.id) > 0;
  if (kill === "squads") return !!e && n("SELECT COUNT(*) AS n FROM claim_progress WHERE epochId = ? AND mint = ?", e.id, W.mints.S!) > 0;
  if (!e) return false;
  if (kill === "sol-pending") return n("SELECT COUNT(*) AS n FROM payouts WHERE epochId = ? AND kind = 'solana' AND sig IS NOT NULL AND sentAt IS NULL", e.id) > 0;
  if (kill === "sol-mid") return n("SELECT COUNT(*) AS n FROM payouts WHERE epochId = ? AND kind IN ('solana','shielded') AND sentAt IS NOT NULL AND sig NOT LIKE '%intent%' AND (kind = 'solana' OR sig LIKE 'fallback_solana:%')", e.id) > 0
    && n("SELECT COUNT(*) AS n FROM payouts WHERE epochId = ? AND kind IN ('solana','shielded') AND sentAt IS NULL AND sig IS NULL", e.id) > 0;
  if (kill === "swap") return e.swapState !== "none";
  if (kill === "swap-poll") return e.swapState === "submitted" && n("SELECT COUNT(*) AS n FROM near1click_swaps WHERE phase = 'deposited'") > 0;
  if (kill === "z-intent") return n("SELECT COUNT(*) AS n FROM payouts WHERE epochId = ? AND kind = 'shielded' AND sig LIKE 'zcash-intent:%'", e.id) > 0;
  if (kill === "z-mid") return n("SELECT COUNT(*) AS n FROM payouts WHERE epochId = ? AND kind = 'shielded' AND sentAt IS NOT NULL", e.id) > 0
    && n("SELECT COUNT(*) AS n FROM payouts WHERE epochId = ? AND kind = 'shielded' AND sentAt IS NULL", e.id) > 0;
  if (kill === "devtool") return devtoolPids().length > 0;
  throw new Error(`unknown trigger ${kill}`);
}

function envFor(round: Round | null, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PAD_DB_FILE: dbFile, SQUADS_MULTISIG: W.squads.multisig, SOLANA_LOCAL_RPC: PROXY, ...extra };
  if (round?.oneclick) env.FAKE_1CLICK_URL = FAKE;
  return env;
}

function spawnRunner(env: Record<string, string>, skewMs = 0) {
  const args = skewMs ? ["bun", "--preload", "./stress/skew.ts", "stress/epoch-runner.ts"] : ["bun", "stress/epoch-runner.ts"];
  const p = Bun.spawn(args, { env: { ...env, SKEW_MS: String(skewMs) }, stdout: "pipe", stderr: "pipe" });
  const out = (async () => {
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    appendFileSync(LOG, o.split("\n").filter(Boolean).map((l) => `    | ${l}`).join("\n") + "\n" + e.split("\n").filter((l) => l && !/skipped \(/.test(l)).slice(0, 12).map((l) => `    ! ${l.slice(0, 300)}`).join("\n") + "\n");
    return o + e;
  })();
  return { p, out };
}

async function proxyFault(f: Round["rpc"] | null): Promise<void> {
  const qs = f ? `mode=${f.mode}&rate=${f.rate}&delayMs=${f.delayMs ?? 90_000}` : "mode=none";
  await fetch(`${PROXY}/__fault?${qs}`);
}

async function approveAll(): Promise<number> {
  let approved = 0;
  for (const p of await listActiveProposals(direct, msPda)) {
    try {
      await approveProposal(direct, msPda, p.index, owner);
      approved++;
    } catch (e) {
      log("  approve", p.index, "skipped:", (e as Error).message.slice(0, 120));
    }
  }
  return approved;
}

function isDone(since: string): boolean {
  const e = roundEpoch(since);
  return !!e && e.status !== "harvesting" && ["ok", "fallback_solana"].includes(e.status)
    && n("SELECT COUNT(*) AS n FROM payouts WHERE sentAt IS NULL") === 0
    && n("SELECT COUNT(*) AS n FROM epochs WHERE status IN ('harvesting','needs_attention')") === 0;
}

async function sh(cmd: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

// --- the full-disk round: the DB moves to a small RAM disk for one round ---
let ramDev = "";
const RAM = "/Volumes/padchaos";
function ramdiskUp(): void {
  ramDev = new TextDecoder().decode(Bun.spawnSync(["hdiutil", "attach", "-nomount", "ram://65536"]).stdout).trim(); // 32 MiB
  Bun.spawnSync(["diskutil", "erasevolume", "HFS+", "padchaos", ramDev]);
  if (!existsSync(RAM)) throw new Error("RAM disk did not mount");
}
function ramdiskDown(): void {
  if (ramDev) Bun.spawnSync(["hdiutil", "detach", ramDev, "-force"]);
  ramDev = "";
}
function fillDisk(leaveKb: number): void {
  Bun.spawnSync(["dd", "if=/dev/zero", `of=${RAM}/spare`, "bs=1k", `count=${leaveKb}`], { stderr: "ignore" });
  Bun.spawnSync(["dd", "if=/dev/zero", `of=${RAM}/fill`, "bs=64k"], { stderr: "ignore" }); // runs until the disk is full
  rmSync(`${RAM}/spare`, { force: true });
  const free = Number(new TextDecoder().decode(Bun.spawnSync(["df", "-k", RAM]).stdout).trim().split("\n").at(-1)!.split(/\s+/)[3]);
  log("  disk filled; free KiB:", free);
}
function checkpoint(file: string): void {
  const d = new Database(file);
  d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  d.close();
}

async function runRound(i: number, round: Round, prior: string | null): Promise<{ ok: boolean; result: string }> {
  log(`=== round ${i + 1}: ${round.name}`);
  const baseEnv = envFor(round);
  // 1. new fees, 2. the independent pre-epoch snapshot
  const tb = await sh(["bun", "stress/trade-burst.ts", WALLETS, "100", "20", "8"], baseEnv);
  log("  trades:", tb.out.trim().split("\n").at(-1));
  if (round.oneclick) await fetch(`${FAKE}/__mode?m=${round.oneclick.m}&n=${round.oneclick.n ?? 0}&slowMs=${round.oneclick.slowMs ?? 0}`);
  if (round.diskFull) {
    ramdiskUp();
    checkpoint(MAIN_DB);
    copyFileSync(MAIN_DB, `${RAM}/chaos.sqlite`);
    dbFile = `${RAM}/chaos.sqlite`;
  }
  const pre = await sh(["bun", "stress/scale-check.ts", "pre", WALLETS], envFor(round));
  if (pre.code !== 0) throw new Error(`pre failed: ${pre.out.slice(-400)}`);
  const since = new Date(Date.now() - 1000).toISOString();
  let approvedOnce = false;
  let applied = false;
  let killedAt = "not applied";
  let runs = 0;
  const zainod = Number(procs().find((l) => /zainod start/.test(l))?.trim().split(/\s+/)[0] ?? 0);

  while (runs < 40 && !isDone(since)) {
    runs++;
    const stage = approvedOnce || roundEpoch(since)?.status !== "harvesting" && roundEpoch(since) ? "B" : "A";
    const chaos = !applied && (round.phase ?? "B") === stage;
    if (chaos) {
      applied = true;
      if (round.rpc) await proxyFault(round.rpc);
      if (round.zainodStopMs && zainod) {
        process.kill(zainod, "SIGSTOP");
        setTimeout(() => process.kill(zainod, "SIGCONT"), round.zainodStopMs);
        log("  lightwalletd (zainod) stopped for", round.zainodStopMs, "ms");
      }
      if (round.diskFull) fillDisk(64);
      if (round.twoKeepers) {
        killedAt = await twoKeepers(round, since);
        continue;
      }
      const { p, out } = spawnRunner(envFor(round), round.skewMs ?? 0);
      const t0 = Date.now();
      let exited = false;
      p.exited.then(() => (exited = true));
      if (round.kill) {
        while (!exited && !triggered(round.kill, since, t0)) await Bun.sleep(25);
        if (!exited) {
          const kids = round.killGroup ? devtoolPids() : [];
          p.kill("SIGKILL");
          for (const k of kids) process.kill(k, "SIGKILL");
          killedAt = `${round.kill} after ${Date.now() - t0} ms${kids.length ? ` (+${kids.length} devtool)` : ""}`;
        } else killedAt = `run ended before trigger ${round.kill}`;
      }
      await p.exited;
      const o = await out;
      log("  chaos run:", killedAt, "|", o.split("\n").find((l) => /^(epoch |no fees|paused|halted|epoch waiting)/.test(l)) ?? o.split("\n").find((l) => /error|failed/i.test(l))?.slice(0, 200) ?? "");
      if (/epoch waiting/.test(o)) approvedOnce = (await approveAll()) > 0 || approvedOnce;
      await proxyFault(null);
      if (round.diskFull) rmSync(`${RAM}/fill`, { force: true });
      // A fallback round keeps its 1Click fault for the whole round: the fault must meet the swap, which may come in a later run.
      if (round.oneclick && !round.fallback) await fetch(`${FAKE}/__mode?m=success`);
      continue;
    }
    const { p, out } = spawnRunner(envFor(round));
    await p.exited;
    const o = await out;
    const line = o.split("\n").find((l) => /^(epoch |no fees|paused|halted|epoch waiting)/.test(l)) ?? o.split("\n").find((l) => /holds the lock|error|failed/i.test(l))?.slice(0, 160) ?? "";
    log(`  run ${runs}:`, line);
    if (/epoch waiting/.test(o)) approvedOnce = (await approveAll()) > 0 || approvedOnce;
    if (/holds the lock/.test(o)) await Bun.sleep(10_000);
  }
  if (zainod) try { process.kill(zainod, "SIGCONT"); } catch { /* gone */ }
  const e = roundEpoch(since);
  const done = isDone(since);
  const env = envFor(round, { RESULT: join(STRESS_DIR, `chaos-r${i + 1}-result.json`), ...(prior ? { PRIOR: prior } : {}), ...(round.fallback ? { FALLBACK: "1" } : {}) });
  const post = done ? await sh(["bun", "stress/scale-check.ts", "post", WALLETS], env) : { code: 1, out: "epoch not finished" };
  const verdict = /RESULT: PASS/.test(post.out) ? "PASS" : "FAIL";
  const problems = post.out.split("\n").filter((l) => l.startsWith("PROBLEM")).slice(0, 12);
  if (round.diskFull) {
    checkpoint(dbFile);
    copyFileSync(dbFile, MAIN_DB);
    for (const s of ["-wal", "-shm"]) rmSync(MAIN_DB + s, { force: true });
    dbFile = MAIN_DB;
    ramdiskDown();
  }
  const rec = { round: i + 1, name: round.name, killedAt, runs, epoch: e?.id, status: e?.status, attempts: e?.attempts, done, verdict, problems };
  appendFileSync(RESULTS, JSON.stringify(rec) + "\n");
  log(`  => ${verdict} (runs ${runs}, status ${e?.status}, attempts ${e?.attempts})`, problems.join(" | "));
  return { ok: verdict === "PASS", result: env.RESULT! };
}

/** Keeper 1 is frozen (SIGSTOP) between Solana batches, past the lock's stale time; keeper 2 takes the lock and runs; keeper 1 wakes up. */
async function twoKeepers(round: Round, since: string): Promise<string> {
  const k1 = spawnRunner(envFor(round));
  const t0 = Date.now();
  let exited = false;
  k1.p.exited.then(() => (exited = true));
  while (!exited && !triggered(round.kill ?? "sol-mid", since, t0)) await Bun.sleep(25);
  if (exited) return "keeper 1 ended before it could be frozen";
  process.kill(k1.p.pid, "SIGSTOP"); // Bun's Subprocess.kill("SIGSTOP") is a no-op (checked with ps); process.kill works
  log(`  keeper 1 frozen at ${round.kill ?? "sol-mid"}; waiting past the lock's stale time`);
  await Bun.sleep(Number(process.env.EPOCH_LOCK_STALE_MS ?? 90_000) + 5000);
  const lock = q<{ holder: string; acquiredAt: string } | null>("SELECT holder, acquiredAt FROM locks WHERE name = 'epoch'");
  log("  lock before keeper 2:", lock ? `${lock.holder.split(":")[0]} at ${lock.acquiredAt} (${Date.now() - Date.parse(lock.acquiredAt)} ms old)` : "none");
  const k2 = spawnRunner(envFor(round));
  await Bun.sleep(4000);
  process.kill(k1.p.pid, "SIGCONT");
  log("  keeper 2 running, keeper 1 woken");
  await Promise.all([k1.p.exited, k2.p.exited]);
  const [o1, o2] = await Promise.all([k1.out, k2.out]);
  const pick = (o: string) => o.split("\n").find((l) => /taken over|lock|^epoch |no fees|error|failed/i.test(l))?.slice(0, 200) ?? "(no output)";
  log("  keeper 1:", pick(o1));
  log("  keeper 2:", pick(o2));
  return "keeper 1 SIGSTOP between Solana batches, keeper 2 took over";
}

const first = Number(process.argv[2] ?? 1) - 1;
let prior: string | null = process.argv[3] ?? (first > 0 ? join(STRESS_DIR, `chaos-r${first}-result.json`) : null);
for (let i = first; i < ROUNDS.length; i++) {
  try {
    const r = await runRound(i, ROUNDS[i]!, prior);
    prior = r.result;
    if (!r.ok) {
      log("stopping: a round failed; investigate before the next one (its carry chain would be wrong)");
      break;
    }
  } catch (e) {
    log("round crashed:", (e as Error).stack?.slice(0, 600));
    ramdiskDown();
    break;
  }
}
await proxyFault(null);
log("chaos driver finished");
process.exit(0);
