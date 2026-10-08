// The RPC budget (ops/MAINNET-RUNBOOK.md G13). The shared key of the devnet pad ran out in 4 days, so the engine measures its own use and warns before a plan does:
//  - each process (the API and the keeper) writes what its RPC guard counted into the table rpc_usage once an hour, a moment after the top of the UTC hour,
//    and logs one line, "rpc last hour: N calls, ~C credits (top: method n, ...)" (counting and credit weights: src/rpcUsage.ts);
//  - the keeper checks once an hour, when PAD_RPC_MONTHLY_CREDITS is set, whether the month as the last 24 hours project it fits the plan, and raises one stored
//    alert of kind `rpc_budget` when the projection reaches 50% of the credits and another at 80%, each at most once a day.
import * as db from "./db";
import { rpcUsage } from "./rpcGuard";
import { HOUR_MS, describeUsage, hourStartIso, msUntilNextHour, projectMonthlyCredits, type RpcUsage, type RpcUsageRow } from "./rpcUsage";

export type RpcProcess = "api" | "keeper";

export interface FlushDeps {
  usage: RpcUsage;
  processName: RpcProcess;
  save: (processName: RpcProcess, rows: RpcUsageRow[]) => void;
  log: (line: string) => void;
  warn: (line: string) => void;
}

/** Writes what the guard counted since the last flush to rpc_usage and logs the hour's one line. A write that fails puts the counts back for the next flush. Never throws. */
export function flushRpcUsage(d: FlushDeps): void {
  const rows = d.usage.take();
  try {
    if (rows.length > 0) d.save(d.processName, rows);
  } catch (err) {
    d.usage.restore(rows);
    d.warn(`[${d.processName}] rpc usage not saved, kept for the next hour: ${(err as Error)?.message ?? err}`);
    return;
  }
  d.log(`[${d.processName}] ${describeUsage(rows)}`);
}

/** The flush waits this long past the top of the hour, so a timer that fires a little early still finds the hour over. */
const FLUSH_PAST_HOUR_MS = 1_000;

export interface HourlyDeps {
  now: () => number;
  /** Must not throw (flushRpcUsage does not). */
  flush: () => void;
  /** Runs `fn` once after `ms` without holding the process open; returns a function that cancels it. */
  schedule: (fn: () => void, ms: number) => () => void;
}

/** Runs `flush` a moment after the top of every UTC hour. Returns a function that stops the timer and flushes one last time (the hour in progress). */
export function startHourlyFlush(d: HourlyDeps): () => void {
  let cancel: () => void = () => undefined;
  const arm = (): void => {
    cancel = d.schedule(() => {
      d.flush();
      arm();
    }, msUntilNextHour(d.now()) + FLUSH_PAST_HOUR_MS);
  };
  arm();
  return () => {
    cancel();
    d.flush();
  };
}

/** The flush of this process's guard (src/rpcGuard.ts) into the pad database. Call once from the process's script and call the result when it stops. */
export function startRpcUsageFlush(processName: RpcProcess): () => void {
  return startHourlyFlush({
    now: Date.now,
    flush: () => flushRpcUsage({ usage: rpcUsage, processName, save: db.addRpcUsage, log: console.log, warn: console.error }),
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
  });
}

/** The stored alert kind of the budget warnings; its key (the alert's epochId column) is the level, "50" or "80". */
export const RPC_BUDGET_ALERT_KIND = "rpc_budget";
const WARN_AT_PERCENT = [50, 80] as const;
const ALERT_EVERY_MS = 24 * HOUR_MS;

export type BudgetLevel = 0 | 50 | 80;

/** The highest warning level the projection has reached: 0 below 50% of the budget, 50, or 80. Exactly on a level counts as reached. */
export function budgetLevel(projectedCredits: number, monthlyCredits: number): BudgetLevel {
  if (projectedCredits * 100 >= monthlyCredits * 80) return 80;
  return projectedCredits * 100 >= monthlyCredits * 50 ? 50 : 0;
}

export interface BudgetCheck {
  projectedCredits: number;
  level: BudgetLevel;
  /** The text of the alert this check raised; null when the level is 0 or its warning was already raised in the last 24 hours. */
  raised: string | null;
}

const alertedKey = (level: number): string => `rpc_budget_alerted_${level}`;

/** True when this level's warning has not been raised in the last 24 hours (a time in the future, or one that is not a time, counts as long ago). */
function alertDue(level: number, nowMs: number): boolean {
  const last = db.getMeta(alertedKey(level));
  const age = last === null ? Number.NaN : nowMs - Date.parse(last);
  return !(age >= 0 && age < ALERT_EVERY_MS);
}

function describeBudget(level: number, projectedCredits: number, monthlyCredits: number): string {
  const share = Math.round((projectedCredits / monthlyCredits) * 1000) / 10;
  return (
    `rpc budget ${level}%: the last 24 hours cost about ${projectedCredits / 30} credits, which projects to about ${projectedCredits} for the month, ${share}% of the plan's ` +
    `${monthlyCredits} (PAD_RPC_MONTHLY_CREDITS). The rpc_usage table and the hourly "rpc last hour" lines say which calls cost it; above 80% the plan needs the next tier (ops/MAINNET-RUNBOOK.md G13)`
  );
}

/**
 * Projects the month from the last 24 hours of rpc_usage (all processes, credits at the weights of src/rpcUsage.ts, times 30) and raises the warning of the highest
 * level reached, at most once a day per level: a stored `rpc_budget` alert (the level's yesterday one, if still open, is replaced) and an ALERT line. Alerts of levels
 * no longer reached are resolved. Reads the database only, so it works while the chain is down.
 */
export function checkRpcBudget(nowMs: number, monthlyCredits: number): BudgetCheck {
  const projectedCredits = projectMonthlyCredits(db.rpcUsageSince(hourStartIso(nowMs - 24 * HOUR_MS)));
  const level = budgetLevel(projectedCredits, monthlyCredits);
  for (const percent of WARN_AT_PERCENT) if (percent > level) db.resolveAlerts(RPC_BUDGET_ALERT_KIND, String(percent));
  if (level === 0 || !alertDue(level, nowMs)) return { projectedCredits, level, raised: null };
  const detail = describeBudget(level, projectedCredits, monthlyCredits);
  db.setMeta(alertedKey(level), new Date(nowMs).toISOString());
  db.resolveAlerts(RPC_BUDGET_ALERT_KIND, String(level));
  db.recordAlert(RPC_BUDGET_ALERT_KIND, String(level), detail);
  console.error(`ALERT ${detail}`);
  return { projectedCredits, level, raised: detail };
}
