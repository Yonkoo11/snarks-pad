// The keeper loop (plan section 4 "Risks and kill switch", 4b "Economics per daily epoch"): `bun run keeper`
// decides WHEN things run and delegates every money-moving step to runEpoch, which is already resumable at
// every point. This file holds no money logic of its own.
//
// Each tick it:
//   1. takes the holder samples that are due (random times inside the epoch window, src/epoch/snapshots.ts)
//      even while paused: sampling only reads;
//   2. stops there if payouts are paused (PAYOUTS_PAUSED=1 or the pause file) or a stop was requested;
//   3. runs runEpoch when an epoch is due (every PAD_EPOCH_EVERY_HOURS, default 48: Solana ZEC payouts), with
//      the shielded leg only when the last shielded epoch is older than PAD_SHIELDED_EVERY_DAYS (default 7),
//      or when something is unfinished (a draft waiting for an owner approval, a parked epoch) every
//      PAD_RESUME_EVERY_MS (default 15 minutes);
//   4. writes one health line (JSON) to config.paths.keeperHealthLog and the next due time to the DB, where
//      GET /treasury reads it.
// On devnet it also reads the test-money faucet key's balance every few minutes (read-only, so also while paused) and,
// with fewer than FAUCET_LOW_FILLS fills left, logs it and keeps one stored alert open until the key is refilled.
// Every few minutes it also reads its own wallet's SOL (read-only, so also while paused) and, below config.keeperWallet.lowLamports, keeps one
// stored keeper_sol_low alert open until it is topped up: every claim and payout pays its fees and account rent from that wallet.
// Once an hour, when the plan's monthly RPC credits are set (PAD_RPC_MONTHLY_CREDITS), it also projects the month's credits from the rpc_usage table and raises
// the 50% and 80% warnings (src/rpcBudget.ts); that reads the database only, so it runs while the chain is down or payouts are paused.
// A run that throws never kills the loop: it is logged and the next tick tries again (runEpoch counts the
// failure toward parking a stuck epoch). A chain that cannot be read (an RPC 429, a timeout, the RPC guard's open
// breaker, src/rpcGuard.ts) is different: the keeper stops touching it and backs off, 30 s doubling to at most
// 5 minutes, with one cheap probe per try, and logs one line when the chain goes and one when it comes back.
import { appendFileSync } from "node:fs";
import { config } from "./config";
import * as db from "./db";
import type { EpochOutcome } from "./epoch/engine";
import { FAUCET_LOW_FILLS, type FaucetReading } from "./faucet";
import { NEXT_EPOCH_AT_META, SCHEDULER_NOOP_META } from "./ledger";
import { haltReason, payoutsPaused } from "./pause";
import { ensurePlan, type SnapshotPlan } from "./epoch/snapshots";
import { checkRpcBudget } from "./rpcBudget";
import { isChainUnavailable } from "./rpcGuard";
import { redactSecrets } from "./util/redact";

export const SCHEDULER_STARTED_META = "scheduler_started_at";
/** When a due epoch last found nothing to claim: it still counts as this cycle's run, or it would be retried every tick. Defined in ledger.ts, which reads it for the Payouts page. */
export { SCHEDULER_NOOP_META };
/** The stored alert kind that stays open while the devnet faucet key can pay fewer than FAUCET_LOW_FILLS more fills. */
export const FAUCET_ALERT_KIND = "faucet_low";
/** The stored alert kind that stays open while the keeper's own wallet holds less SOL than config.keeperWallet.lowLamports. */
export const KEEPER_SOL_ALERT_KIND = "keeper_sol_low";
const HEARTBEAT_EVERY_MS = 10 * 60_000;
// The alert needs minutes, not ticks: an idle tick stays free of RPC calls and a failing read is logged at most this often.
const FAUCET_CHECK_EVERY_MS = 5 * 60_000;
const KEEPER_SOL_CHECK_EVERY_MS = 10 * 60_000;
const RPC_BUDGET_CHECK_EVERY_MS = 60 * 60_000;
/** The keeper's first wait once the chain stops answering; every failed probe doubles it, up to CHAIN_BACKOFF_MAX_MS. */
export const CHAIN_BACKOFF_FIRST_MS = 30_000;
export const CHAIN_BACKOFF_MAX_MS = 5 * 60_000;

export interface SchedulerDeps {
  nowMs: () => number;
  runEpoch: (opts: { includeShielded: boolean }) => Promise<EpochOutcome>;
  takeDueSamples: (nowMs: number, plan: SnapshotPlan) => Promise<number>;
  /** The faucet key's balance and what it still buys (src/faucet.ts readFaucet); null where there is no faucet. Absent = no faucet watch. */
  readFaucet?: () => Promise<FaucetReading | null>;
  /** The keeper wallet's address and SOL balance (scripts/keeper.ts). Absent = no low-SOL watch. */
  readKeeperSol?: () => Promise<{ address: string; lamports: number }>;
  /** The low-SOL line, in lamports (config.keeperWallet.lowLamports); absent = that default. */
  keeperLowLamports?: number;
  /** One cheap chain read (the current slot), used only while backing off: it decides whether the chain answers again. Absent: taken to answer. */
  probeChain?: () => Promise<unknown>;
  /** The RPC plan's credits a month (PAD_RPC_MONTHLY_CREDITS): the keeper checks the projected month against it once an hour. Absent or 0: no check. */
  rpcMonthlyCredits?: number;
  log: (entry: Record<string, unknown>) => void;
}

/** While the chain cannot be read: since when, the current wait, and when the next probe is due. */
export interface ChainDown {
  sinceMs: number;
  backoffMs: number;
  retryAtMs: number;
}

export interface SchedulerState {
  lastRunAtMs: number;
  lastHeartbeatMs: number;
  wasPaused: boolean;
  lastFaucetCheckMs: number;
  lastKeeperSolCheckMs: number;
  /** When the RPC budget was last checked (0 = not yet: the first tick checks). */
  lastRpcBudgetCheckMs: number;
  /** The fills left the last good faucet read reported; null before the first read, after a failed one, and where there is no faucet. */
  faucetFillsLeft: number | null;
  /** Set while the chain cannot be read (the keeper is backing off); null while it answers. */
  chainDown: ChainDown | null;
}

export const newSchedulerState = (): SchedulerState => ({ lastRunAtMs: 0, lastHeartbeatMs: 0, wasPaused: false, lastFaucetCheckMs: 0, lastKeeperSolCheckMs: 0, lastRpcBudgetCheckMs: 0, faucetFillsLeft: null, chainDown: null });

export type TickAction = "idle" | "paused" | "epoch" | "resume" | "error";

export interface TickSummary {
  action: TickAction;
  nextEpochAt: string;
  outcome?: string;
}

/** The start of the current cycle: the newest epoch (a draft does not count), a run that found nothing, or the keeper's first start. */
function cycleStartMs(nowMs: number): number {
  const candidates = [db.listEpochs()[0]?.at ?? null, db.getMeta(SCHEDULER_NOOP_META)].filter((t): t is string => !!t).map((t) => Date.parse(t));
  if (candidates.length > 0) return Math.max(...candidates);
  const started = db.getMeta(SCHEDULER_STARTED_META);
  if (started) return Date.parse(started);
  db.setMeta(SCHEDULER_STARTED_META, new Date(nowMs).toISOString());
  return nowMs;
}

/** When the next epoch is due. */
export function nextEpochDueMs(cycleStart: number, cadence = config.scheduler): number {
  const hasEpoch = db.listEpochs().length > 0;
  if (!hasEpoch && cadence.firstEpochAt) return Date.parse(cadence.firstEpochAt);
  return cycleStart + cadence.epochEveryMs;
}

/** Whether a new epoch should also run the shielded leg: never one yet, or the last one is a full shielded cadence old. */
export function shieldedDue(nowMs: number, cadence = config.scheduler): boolean {
  const last = db.lastShieldedEpochAt();
  return last === null || nowMs - Date.parse(last) >= cadence.shieldedEveryMs;
}

function unfinishedWork(): boolean {
  return db.findDraftEpoch() !== null || db.findResumableSentEpoch() !== null || db.listParkedEpochs().some((e) => db.epochHasUnsentPayouts(e.id));
}

const describe = (o: EpochOutcome): string => {
  if (o.paused) return `paused: ${o.paused}`;
  if (o.halted) return `halted: ${o.halted.join("; ")}`;
  if (o.awaitingClaims) return `waiting on claims: ${o.awaitingClaims.join("; ")}`;
  return o.epoch ? `epoch ${o.epoch.id} ${o.epoch.status}` : "nothing to claim";
};

interface TickContext {
  deps: SchedulerDeps;
  state: SchedulerState;
  nowMs: number;
  nextEpochAt: string;
  base: Record<string, unknown>;
}

/** Logs the tick (everything but an idle tick, which only logs a heartbeat) and builds its summary. */
function finishTick(c: TickContext, action: TickAction, outcome?: string): TickSummary {
  const heartbeat = c.nowMs - c.state.lastHeartbeatMs >= HEARTBEAT_EVERY_MS;
  if (action !== "idle" || heartbeat) {
    c.deps.log({ ...c.base, event: action, ...(outcome ? { outcome } : {}) });
    c.state.lastHeartbeatMs = c.nowMs;
  }
  db.setMeta("keeper_last_tick", c.base.at as string);
  return { action, nextEpochAt: c.nextEpochAt, ...(outcome ? { outcome } : {}) };
}

/** Takes the holder samples that are due (read-only, so also while paused). A failure is logged, never fatal. */
async function sampleStep(c: TickContext, cycleStart: number, next: number): Promise<void> {
  try {
    if (next > cycleStart) await c.deps.takeDueSamples(c.nowMs, ensurePlan(cycleStart, next, config.epoch.snapshots.count));
  } catch (err) {
    if (isChainUnavailable(err)) throw err; // the tick backs off instead (chainWentDown): one line for the outage, not one per try
    c.deps.log({ ...c.base, event: "sample_error", error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
}

/**
 * Reads the faucet key's balance (at most every FAUCET_CHECK_EVERY_MS). Below FAUCET_LOW_FILLS fills left it logs a `faucet_low`
 * line and an ALERT line on stderr and opens one stored alert, which stays open until the key is refilled. A failed read is logged
 * as `faucet_error`, never fatal.
 */
async function faucetStep(deps: SchedulerDeps, state: SchedulerState, nowMs: number): Promise<void> {
  if (!deps.readFaucet || nowMs - state.lastFaucetCheckMs < FAUCET_CHECK_EVERY_MS) return;
  state.lastFaucetCheckMs = nowMs;
  const at = new Date(nowMs).toISOString();
  try {
    const reading = await deps.readFaucet();
    state.faucetFillsLeft = reading?.fillsLeft ?? null;
    if (!reading) return;
    if (reading.fillsLeft >= FAUCET_LOW_FILLS) {
      db.resolveAlerts(FAUCET_ALERT_KIND, "");
      return;
    }
    const detail = `devnet faucet is running low: ${reading.fillsLeft} test-money fills left when this alert was raised (it fires below ${FAUCET_LOW_FILLS}); the faucet key ${reading.address} held ${(reading.lamports / 1e9).toFixed(4)} SOL. Refill it from faucet.solana.com`;
    if (!db.recordAlert(FAUCET_ALERT_KIND, "", detail)) return;
    console.error(`ALERT ${detail}`);
    deps.log({ at, event: "faucet_low", fillsLeft: reading.fillsLeft, detail });
  } catch (err) {
    state.faucetFillsLeft = null;
    if (isChainUnavailable(err)) throw err; // the tick backs off instead (chainWentDown)
    deps.log({ at, event: "faucet_error", error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
}

/**
 * Reads the keeper wallet's SOL (at most every KEEPER_SOL_CHECK_EVERY_MS). Below the low line it logs a `keeper_sol_low` line and an ALERT line on stderr and
 * opens one stored alert, which stays open until the wallet is topped up. A failed read is logged as `keeper_sol_error`, never fatal.
 */
async function keeperSolStep(deps: SchedulerDeps, state: SchedulerState, nowMs: number): Promise<void> {
  if (!deps.readKeeperSol || nowMs - state.lastKeeperSolCheckMs < KEEPER_SOL_CHECK_EVERY_MS) return;
  state.lastKeeperSolCheckMs = nowMs;
  const low = deps.keeperLowLamports ?? config.keeperWallet.lowLamports;
  const at = new Date(nowMs).toISOString();
  try {
    const { address, lamports } = await deps.readKeeperSol();
    if (lamports >= low) {
      db.resolveAlerts(KEEPER_SOL_ALERT_KIND, "");
      return;
    }
    const detail = `the keeper wallet ${address} holds ${(lamports / 1e9).toFixed(4)} SOL (this alert fires below ${(low / 1e9).toFixed(4)} SOL). Claims and payouts pay fees and account rent from it and fail once it is dry. Send SOL to that address`;
    if (!db.recordAlert(KEEPER_SOL_ALERT_KIND, "", detail)) return;
    console.error(`ALERT ${detail}`);
    deps.log({ at, event: "keeper_sol_low", lamports, detail });
  } catch (err) {
    if (isChainUnavailable(err)) throw err; // the tick backs off instead (chainWentDown)
    deps.log({ at, event: "keeper_sol_error", error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
}

/**
 * Once an hour, when the plan's monthly credits are set: projects the month's RPC credits from rpc_usage and raises the 50% and 80% warnings (src/rpcBudget.ts),
 * logging an `rpc_budget` line when one is raised. A failure is logged as `rpc_budget_error`, never fatal.
 */
function budgetStep(deps: SchedulerDeps, state: SchedulerState, nowMs: number): void {
  if (!deps.rpcMonthlyCredits || nowMs - state.lastRpcBudgetCheckMs < RPC_BUDGET_CHECK_EVERY_MS) return;
  state.lastRpcBudgetCheckMs = nowMs;
  const at = new Date(nowMs).toISOString();
  try {
    const found = checkRpcBudget(nowMs, deps.rpcMonthlyCredits);
    if (found.raised) deps.log({ at, event: "rpc_budget", level: found.level, projectedCredits: found.projectedCredits, monthlyCredits: deps.rpcMonthlyCredits, detail: found.raised });
  } catch (err) {
    deps.log({ at, event: "rpc_budget_error", error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
}

/** Runs the epoch (a due one, or an unfinished one being retried) and reports what happened. */
async function runStep(c: TickContext, due: boolean, cadence: typeof config.scheduler): Promise<TickSummary> {
  c.state.lastRunAtMs = c.nowMs;
  try {
    const outcome = await c.deps.runEpoch({ includeShielded: shieldedDue(c.nowMs, cadence) });
    if (outcome.paused) return finishTick(c, "paused", outcome.paused);
    // A due run that found nothing to claim still ends this cycle; one that is waiting or halted does not.
    if (due && outcome.epoch === null && !outcome.awaitingClaims && !outcome.halted) db.setMeta(SCHEDULER_NOOP_META, new Date(c.nowMs).toISOString());
    return finishTick(c, due ? "epoch" : "resume", describe(outcome));
  } catch (err) {
    if (isChainUnavailable(err)) throw err; // the tick backs off instead (chainWentDown)
    return finishTick(c, "error", String((err as Error)?.message ?? err).slice(0, 300));
  }
}

function tickContext(deps: SchedulerDeps, state: SchedulerState, nowMs: number, nextEpochAt: string): TickContext {
  const base = {
    at: new Date(nowMs).toISOString(), nextEpochAt, openAlerts: db.listOpenAlerts().length, parkedEpochs: db.listParkedEpochs().length,
    ...(state.faucetFillsLeft === null ? {} : { faucetFillsLeft: state.faucetFillsLeft }),
    ...(state.chainDown ? { chainUnavailableSince: new Date(state.chainDown.sinceMs).toISOString() } : {}),
  };
  return { deps, state, nowMs, nextEpochAt, base };
}

function backOff(down: ChainDown, nowMs: number): void {
  down.backoffMs = Math.min(down.backoffMs * 2, CHAIN_BACKOFF_MAX_MS);
  down.retryAtMs = nowMs + down.backoffMs;
}

/**
 * Whether this tick may touch the chain. While it is down the keeper waits out its backoff; then one probe decides: an answer ends the outage (one
 * `chain_available` line), a failure doubles the wait, up to 5 minutes, with no line.
 */
async function chainReady(deps: SchedulerDeps, state: SchedulerState, nowMs: number): Promise<boolean> {
  const down = state.chainDown;
  if (!down) return true;
  if (nowMs < down.retryAtMs) return false;
  try {
    await deps.probeChain?.();
  } catch {
    backOff(down, nowMs);
    return false;
  }
  deps.log({ at: new Date(nowMs).toISOString(), event: "chain_available", downForMs: nowMs - down.sinceMs });
  state.chainDown = null;
  return true;
}

/** A step found the chain unreadable: the keeper starts backing off and logs it once (`chain_unavailable`); the steps wait until a probe answers. */
function chainWentDown(c: TickContext, err: unknown): TickSummary {
  if (c.state.chainDown) backOff(c.state.chainDown, c.nowMs);
  else {
    c.state.chainDown = { sinceMs: c.nowMs, backoffMs: CHAIN_BACKOFF_FIRST_MS, retryAtMs: c.nowMs + CHAIN_BACKOFF_FIRST_MS };
    c.deps.log({ ...c.base, event: "chain_unavailable", retryInMs: CHAIN_BACKOFF_FIRST_MS, error: String((err as Error)?.message ?? err).slice(0, 300) });
    c.state.lastHeartbeatMs = c.nowMs;
  }
  return finishTick(c, "idle", "waiting for the chain");
}

/** The rest of a tick once the faucet has been read: the due samples (also while paused: they only read), the kill switch, then a due or unfinished run. */
async function afterFaucet(c: TickContext, start: number, next: number, cadence: typeof config.scheduler): Promise<TickSummary> {
  await sampleStep(c, start, next);
  const halt = haltReason();
  if (halt) {
    c.state.wasPaused = true;
    return finishTick(c, "paused", payoutsPaused().paused ? `payouts paused (${halt})` : "stop requested");
  }
  if (c.state.wasPaused) {
    c.state.wasPaused = false;
    c.deps.log({ ...c.base, event: "resumed" });
  }
  const due = c.nowMs >= next;
  // Any run is rate-limited to one per resumeEveryMs, so a draft waiting for an owner approval, a halted
  // keeper or a failing RPC is not hammered every tick; the first run after start is immediate.
  const mayRun = c.state.lastRunAtMs === 0 || c.nowMs - c.state.lastRunAtMs >= cadence.resumeEveryMs;
  if (!mayRun || (!due && !unfinishedWork())) return finishTick(c, "idle");
  return runStep(c, due, cadence);
}

/**
 * One pass of the loop. A failed run is reported in the summary and the log; a chain that cannot be read makes the keeper back off (chainReady,
 * chainWentDown) instead of trying every tick.
 */
export async function keeperTick(deps: SchedulerDeps, state: SchedulerState, cadence = config.scheduler): Promise<TickSummary> {
  const nowMs = deps.nowMs();
  const start = cycleStartMs(nowMs);
  const next = nextEpochDueMs(start, cadence);
  const nextEpochAt = new Date(next).toISOString();
  db.setMeta(NEXT_EPOCH_AT_META, nextEpochAt);
  budgetStep(deps, state, nowMs); // the database only: it runs while the chain is down too
  if (!(await chainReady(deps, state, nowMs))) return finishTick(tickContext(deps, state, nowMs, nextEpochAt), "idle", "waiting for the chain");
  try {
    await faucetStep(deps, state, nowMs);
    await keeperSolStep(deps, state, nowMs);
    return await afterFaucet(tickContext(deps, state, nowMs, nextEpochAt), start, next, cadence);
  } catch (err) {
    if (!isChainUnavailable(err)) throw err;
    return chainWentDown(tickContext(deps, state, nowMs, nextEpochAt), err);
  }
}

export interface LoopOptions {
  tickMs: number;
  once: boolean;
  shouldStop: () => boolean;
  /** Resolves after `ms`, or early when the loop is told to stop. */
  sleep: (ms: number) => Promise<void>;
}

/** Ticks until told to stop (or once). Returns the number of ticks run. */
export async function runKeeperLoop(deps: SchedulerDeps, opts: LoopOptions, state = newSchedulerState()): Promise<number> {
  let ticks = 0;
  do {
    await keeperTick(deps, state);
    ticks++;
    if (opts.once || opts.shouldStop()) break;
    await opts.sleep(opts.tickMs);
  } while (!opts.shouldStop());
  return ticks;
}

/** Appends one JSON line to the keeper health log (never fails the loop). */
export function appendHealthLine(entry: Record<string, unknown>, file = config.paths.keeperHealthLog): void {
  try {
    appendFileSync(file, redactSecrets(JSON.stringify(entry)) + "\n"); // an error string in an entry must never carry an RPC key
  } catch (err) {
    console.error("could not write the keeper health log:", (err as Error).message);
  }
}
