// The RPC budget (src/rpcBudget.ts, ops/MAINNET-RUNBOOK.md G13): the hourly flush of a process's call counts into rpc_usage and its timer (fake clock, fake stores),
// the table's additive upsert, the month's projection from the last 24 hours, the 50% and 80% warnings (once a day each, resolved when no longer reached) and the
// keeper's hourly check through keeperTick (off while PAD_RPC_MONTHLY_CREDITS is unset). The DB is the shared test DB, used like test/scheduler.test.ts does, in
// its own stretch of the year 2097: every row, alert and meta key a test makes is removed after it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { RPC_BUDGET_ALERT_KIND, budgetLevel, checkRpcBudget, flushRpcUsage, startHourlyFlush, type FlushDeps, type RpcProcess } from "../src/rpcBudget";
import { HOUR_MS, hourStartIso, makeRpcUsage, type RpcUsageRow } from "../src/rpcUsage";
import { SCHEDULER_NOOP_META, keeperTick, newSchedulerState, type SchedulerDeps } from "../src/scheduler";

const T0 = Date.parse("2097-06-01T12:00:00Z");
const hours = (n: number) => n * HOUR_MS;
/** A plan of 3,000 credits a month: 50% is a day of 50 credits (projected 1,500), 80% a day of 80 (2,400). */
const BUDGET = 3_000;

// A raised warning prints an ALERT line, which this file keeps out of its output and reads back where it matters.
const realError = console.error;
const printed: string[] = [];
beforeEach(() => {
  printed.length = 0;
  console.error = (...a: unknown[]) => void printed.push(a.join(" "));
});
afterEach(() => {
  console.error = realError;
  db.getDb().query("DELETE FROM rpc_usage WHERE hour_utc LIKE '2097-%'").run();
  db.getDb().query("DELETE FROM alerts WHERE kind = ?").run(RPC_BUDGET_ALERT_KIND);
  db.getDb().query("DELETE FROM meta WHERE key LIKE 'rpc_budget_alerted_%' OR key = ?").run(SCHEDULER_NOOP_META);
});

const row = (method: string, calls: number, hourUtc = hourStartIso(T0), failures = 0): RpcUsageRow => ({ hourUtc, method, calls, failures });
/** A day of `credits` credits: that many 1-credit calls in the hour of T0, which every check below sees. */
const seedDay = (credits: number, processName: RpcProcess = "api") => db.addRpcUsage(processName, [row("getSlot", credits)]);
const clearUsage = () => db.getDb().query("DELETE FROM rpc_usage WHERE hour_utc LIKE '2097-%'").run();
const budgetAlerts = () => db.listOpenAlerts().filter((a) => a.kind === RPC_BUDGET_ALERT_KIND);

describe("the flush of a process's counts", () => {
  function flushRig() {
    const usage = makeRpcUsage(() => T0);
    const saved: { processName: RpcProcess; rows: RpcUsageRow[] }[] = [];
    const logs: string[] = [];
    const warns: string[] = [];
    const failure: { error: Error | null } = { error: null };
    const deps: FlushDeps = {
      usage,
      processName: "api",
      save: (processName, rows) => {
        if (failure.error) throw failure.error;
        saved.push({ processName, rows });
      },
      log: (line) => logs.push(line),
      warn: (line) => warns.push(line),
    };
    return { usage, deps, saved, logs, warns, failure };
  }

  test("saves what was counted under the process's name, logs the hour's one line, and the next flush finds nothing new", () => {
    const { usage, deps, saved, logs } = flushRig();
    usage.record("getSlot", false);
    usage.record("getSlot", true);
    usage.record("getProgramAccounts", false);
    flushRpcUsage(deps);
    expect(saved.length).toBe(1);
    expect(saved[0]!.processName).toBe("api");
    expect(saved[0]!.rows).toEqual([row("getProgramAccounts", 1), row("getSlot", 2, hourStartIso(T0), 1)]);
    expect(logs).toEqual(["[api] rpc last hour: 3 calls, ~12 credits (top: getProgramAccounts 1, getSlot 2)"]);
    flushRpcUsage(deps);
    expect(saved.length).toBe(1); // nothing to write
    expect(logs.at(-1)).toBe("[api] rpc last hour: 0 calls, ~0 credits"); // but the hour still has its line
  });

  test("a write that fails warns, logs no hourly line and keeps the counts: the next flush writes them with what came after", () => {
    const { usage, deps, saved, logs, warns, failure } = flushRig();
    usage.record("getSlot", false);
    usage.record("getSlot", false);
    failure.error = new Error("database is locked");
    flushRpcUsage(deps);
    expect(saved).toEqual([]);
    expect(logs).toEqual([]);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("[api] rpc usage not saved");
    expect(warns[0]).toContain("database is locked");
    failure.error = null;
    usage.record("getSlot", false);
    flushRpcUsage(deps);
    expect(saved[0]!.rows).toEqual([row("getSlot", 3)]);
    expect(logs).toEqual(["[api] rpc last hour: 3 calls, ~3 credits (top: getSlot 3)"]);
  });
});

describe("the hourly timer", () => {
  function timerRig(startMs: number) {
    const clock = { now: startMs };
    const flushes: number[] = [];
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const stop = startHourlyFlush({
      now: () => clock.now,
      flush: () => flushes.push(clock.now),
      schedule: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    /** Moves the clock to when the newest timer is due (plus `lateMs`) and fires it. */
    const fire = (lateMs = 0) => {
      const timer = timers.at(-1)!;
      clock.now += timer.ms + lateMs;
      timer.fn();
    };
    return { clock, flushes, timers, stop, fire };
  }

  const at = (iso: string) => Date.parse(iso);

  test("the first flush is a second past the next top of the hour, then one every hour, whatever the clock said at the start", () => {
    const { flushes, timers, fire } = timerRig(at("2097-06-01T14:20:00Z"));
    expect(timers.map((t) => t.ms)).toEqual([40 * 60_000 + 1_000]);
    fire();
    fire();
    fire();
    expect(flushes).toEqual([at("2097-06-01T15:00:01Z"), at("2097-06-01T16:00:01Z"), at("2097-06-01T17:00:01Z")]);
    expect(timers.map((t) => t.ms)).toEqual([40 * 60_000 + 1_000, HOUR_MS, HOUR_MS, HOUR_MS]);
  });

  test("a timer that fires late schedules the next one from the clock, so the flushes stay on the hour", () => {
    const { flushes, timers, fire } = timerRig(at("2097-06-01T14:20:00Z"));
    fire(250); // 15:00:01.250
    expect(timers.at(-1)!.ms).toBe(HOUR_MS - 250);
    fire();
    expect(flushes.map((t) => new Date(t).toISOString())).toEqual(["2097-06-01T15:00:01.250Z", "2097-06-01T16:00:01.000Z"]);
  });

  test("stop cancels the waiting timer and flushes the hour in progress once; nothing is scheduled after it", () => {
    const { flushes, timers, stop, clock, fire } = timerRig(at("2097-06-01T14:20:00Z"));
    fire();
    clock.now += 10 * 60_000; // 15:10:01
    stop();
    expect(timers.at(-1)!.cancelled).toBe(true);
    expect(timers.length).toBe(2);
    expect(flushes).toEqual([at("2097-06-01T15:00:01Z"), at("2097-06-01T15:10:01Z")]);
  });
});

describe("rpc_usage", () => {
  test("a flush adds to the hour's rows of its own process and method; processes and methods stay apart; the month's reader adds processes together", () => {
    const hour = hourStartIso(T0);
    db.addRpcUsage("api", [row("getSlot", 5, hour, 1)]);
    db.addRpcUsage("api", [row("getSlot", 3, hour), row("getBalance", 2, hour)]);
    db.addRpcUsage("keeper", [row("getSlot", 10, hour, 2)]);
    expect(db.getDb().query("SELECT process, method, calls, failures FROM rpc_usage WHERE hour_utc = ? ORDER BY process, method").all(hour)).toEqual([
      { process: "api", method: "getBalance", calls: 2, failures: 0 },
      { process: "api", method: "getSlot", calls: 8, failures: 1 },
      { process: "keeper", method: "getSlot", calls: 10, failures: 2 },
    ]);
    expect(db.rpcUsageSince(hour)).toEqual([{ method: "getBalance", calls: 2, failures: 0 }, { method: "getSlot", calls: 18, failures: 3 }]);
  });

  test("a write that fails leaves none of its rows behind, so a flush that put its counts back cannot count them twice", () => {
    const bad = { hourUtc: hourStartIso(T0), method: null as unknown as string, calls: 1, failures: 0 };
    expect(() => db.addRpcUsage("api", [row("getSlot", 5), bad])).toThrow();
    expect(db.rpcUsageSince(hourStartIso(T0))).toEqual([]);
  });

  test("the reader starts at the hour it is given: earlier hours are not counted", () => {
    db.addRpcUsage("api", [row("getSlot", 1, hourStartIso(T0 - hours(3))), row("getSlot", 10, hourStartIso(T0 - hours(2))), row("getSlot", 100, hourStartIso(T0 - hours(1))), row("getSlot", 1000)]);
    expect(db.rpcUsageSince(hourStartIso(T0 - hours(1)))).toEqual([{ method: "getSlot", calls: 1100, failures: 0 }]);
  });
});

describe("the warning levels", () => {
  test("below 50% of the budget is 0, from 50% 50, from 80% 80; exactly on a level counts as reached", () => {
    const levels = [0, 1_499, 1_500, 2_399, 2_400, 3_000, 9_000].map((projected) => budgetLevel(projected, BUDGET));
    expect(levels).toEqual([0, 0, 50, 50, 80, 80, 80]);
  });
});

describe("the keeper's check of the month", () => {
  test("below 50%: nothing is raised or stored", () => {
    seedDay(49);
    expect(checkRpcBudget(T0, BUDGET)).toEqual({ projectedCredits: 1_470, level: 0, raised: null });
    expect(budgetAlerts()).toEqual([]);
  });

  test("the month is the last 24 hours times 30, at the weights, over all processes", () => {
    db.addRpcUsage("api", [row("getProgramAccounts", 2), row("getSlot", 10)]); // 30 credits
    db.addRpcUsage("keeper", [row("getProgramAccounts", 1), row("getSlot", 10)]); // 20 credits
    const found = checkRpcBudget(T0, BUDGET);
    expect(found).toMatchObject({ projectedCredits: 1_500, level: 50 });
  });

  test("hours older than 24 do not count; the hour 24 hours back does", () => {
    db.addRpcUsage("api", [row("getSlot", 100_000, hourStartIso(T0 - hours(25)))]);
    expect(checkRpcBudget(T0, BUDGET)).toMatchObject({ projectedCredits: 0, level: 0 });
    db.addRpcUsage("api", [row("getSlot", 50, hourStartIso(T0 - hours(24)))]);
    expect(checkRpcBudget(T0, BUDGET)).toMatchObject({ projectedCredits: 1_500, level: 50 });
  });

  test("reaching 50%: one stored rpc_budget alert keyed 50 that names the projection and the budget, and an ALERT line", () => {
    seedDay(50);
    const found = checkRpcBudget(T0, BUDGET);
    expect(found).toMatchObject({ projectedCredits: 1_500, level: 50 });
    expect(found.raised).toContain("rpc budget 50%");
    expect(printed).toEqual([`ALERT ${found.raised}`]);
    const [alert, ...rest] = budgetAlerts();
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ kind: "rpc_budget", epochId: "50" });
    expect(alert!.message).toContain("about 1500 for the month");
    expect(alert!.message).toContain("50% of the plan's 3000");
  });

  test("once a day: not again within 24 hours, again from the 24th, still one open alert", () => {
    seedDay(50);
    expect(checkRpcBudget(T0, BUDGET).raised).not.toBeNull();
    expect(checkRpcBudget(T0 + hours(1), BUDGET).raised).toBeNull();
    expect(checkRpcBudget(T0 + hours(24) - 60_000, BUDGET).raised).toBeNull();
    expect(checkRpcBudget(T0 + hours(24), BUDGET).raised).not.toBeNull();
    expect(budgetAlerts().length).toBe(1);
    expect((db.getDb().query("SELECT COUNT(*) AS n FROM alerts WHERE kind = ?").get(RPC_BUDGET_ALERT_KIND) as { n: number }).n).toBe(2); // yesterday's, resolved, and today's
  });

  test("a projection that jumps over 50 to 80% raises only the 80% warning; 50% and 80% are separate warnings with a day each", () => {
    seedDay(80);
    const found = checkRpcBudget(T0, BUDGET);
    expect(found).toMatchObject({ projectedCredits: 2_400, level: 80 });
    expect(budgetAlerts().map((a) => a.epochId)).toEqual(["80"]);
    expect(checkRpcBudget(T0 + hours(1), BUDGET).raised).toBeNull();
  });

  test("50% first and 80% later the same day: both are raised, each once, and both stay open while their level holds", () => {
    seedDay(50);
    checkRpcBudget(T0, BUDGET);
    seedDay(30); // 80 now
    expect(checkRpcBudget(T0 + hours(1), BUDGET)).toMatchObject({ level: 80 });
    expect(budgetAlerts().map((a) => a.epochId)).toEqual(["50", "80"]);
    expect(checkRpcBudget(T0 + hours(2), BUDGET).raised).toBeNull();
  });

  test("a level that is no longer reached is resolved: 80 falling to 55% closes the 80 alert and raises the 50 one; falling below 50% closes everything", () => {
    seedDay(80);
    checkRpcBudget(T0, BUDGET);
    clearUsage();
    seedDay(55);
    expect(checkRpcBudget(T0 + hours(1), BUDGET)).toMatchObject({ level: 50 });
    expect(budgetAlerts().map((a) => a.epochId)).toEqual(["50"]);
    clearUsage();
    seedDay(10);
    expect(checkRpcBudget(T0 + hours(2), BUDGET)).toEqual({ projectedCredits: 300, level: 0, raised: null });
    expect(budgetAlerts()).toEqual([]);
  });
});

describe("the check inside the keeper loop", () => {
  const cadence = { epochEveryMs: 48 * HOUR_MS, shieldedEveryMs: 7 * 24 * HOUR_MS, tickMs: 60_000, resumeEveryMs: 15 * 60_000, firstEpochAt: null };

  /** A keeper whose epoch is two days off (the cycle start is pinned): a tick only reads samples and checks the budget. */
  function keeperRig(clock: { now: number }, over: Partial<SchedulerDeps> = {}) {
    db.setMeta(SCHEDULER_NOOP_META, new Date(T0).toISOString());
    const logs: Record<string, unknown>[] = [];
    const deps: SchedulerDeps = { nowMs: () => clock.now, runEpoch: async () => ({ epoch: null }), takeDueSamples: async () => 0, log: (e) => logs.push(e), ...over };
    return { deps, logs, budgetLogs: () => logs.filter((l) => String(l.event).startsWith("rpc_budget")) };
  }

  test("PAD_RPC_MONTHLY_CREDITS unset: no check, however much was used", async () => {
    seedDay(1_000_000);
    const { deps, budgetLogs } = keeperRig({ now: T0 + 10 * 60_000 });
    await keeperTick(deps, newSchedulerState(), cadence);
    expect(budgetAlerts()).toEqual([]);
    expect(budgetLogs()).toEqual([]);
  });

  test("set: checked on the first tick, logged as rpc_budget with the level, then not again until an hour has passed", async () => {
    seedDay(80);
    const clock = { now: T0 + 10 * 60_000 };
    const { deps, budgetLogs } = keeperRig(clock, { rpcMonthlyCredits: BUDGET });
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(budgetLogs()).toMatchObject([{ event: "rpc_budget", level: 80, projectedCredits: 2_400, monthlyCredits: BUDGET }]);
    expect(budgetAlerts().map((a) => a.epochId)).toEqual(["80"]);

    clearUsage(); // the usage is gone: a check would now resolve the alert
    clock.now += 59 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(budgetAlerts().length).toBe(1); // no check ran yet
    clock.now += 60_000;
    await keeperTick(deps, state, cadence);
    expect(budgetAlerts()).toEqual([]); // the hour is over: it ran, and the level is 0
  });

  test("the check reads the database only: it runs while the keeper is backing off from a chain it cannot read", async () => {
    seedDay(50);
    const clock = { now: T0 + 10 * 60_000 };
    const { deps, budgetLogs } = keeperRig(clock, { rpcMonthlyCredits: BUDGET });
    const state = newSchedulerState();
    state.chainDown = { sinceMs: clock.now - 60_000, backoffMs: 30_000, retryAtMs: clock.now + hours(1) };
    const tick = await keeperTick(deps, state, cadence);
    expect(tick.outcome).toBe("waiting for the chain");
    expect(budgetLogs()).toMatchObject([{ event: "rpc_budget", level: 50 }]);
  });

  test("a check that fails is logged as rpc_budget_error and the tick goes on", async () => {
    const { deps, budgetLogs } = keeperRig({ now: T0 + 10 * 60_000 }, { rpcMonthlyCredits: BUDGET });
    db.getDb().exec("ALTER TABLE rpc_usage RENAME TO rpc_usage_away");
    try {
      const tick = await keeperTick(deps, newSchedulerState(), cadence);
      // "idle" alone, or "resume" when another test file left an unfinished epoch in the shared database (the fast lane, 2026-10-07): either way the tick went on
      expect(["idle", "resume"]).toContain(tick.action);
      expect(budgetLogs()).toMatchObject([{ event: "rpc_budget_error" }]);
      expect(String(budgetLogs()[0]!.error)).toContain("rpc_usage");
    } finally {
      db.getDb().exec("ALTER TABLE rpc_usage_away RENAME TO rpc_usage");
    }
  });
});
