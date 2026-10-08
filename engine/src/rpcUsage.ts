// What the engine asks of its RPC provider, counted. Every request that leaves this process through the RPC guard (src/rpcGuard.ts) is one call of its
// method, and one failure more when it did not come back as a 2xx. The API and the keeper are separate processes: each counts its own and flushes the counts
// once an hour into the pad database (src/rpcBudget.ts, table rpc_usage), where the keeper adds up the last 24 hours to project the month against the plan.
//
// Counted: a request that was sent, answered or not. A failed one still counts as a call, because the provider's page does not say whether a 429 or a timeout is
// billed, so a failure is taken as spent. Not counted: a call the guard refused before it left (breaker open, no pacing turn), which cost nothing, and websocket
// traffic (the confirmations web3.js waits on), which does not pass the guard.

export const HOUR_MS = 3_600_000;

// Credits per call on a Helius plan. Source: https://www.helius.dev/docs/billing/credits (read 2026-10-06): "All RPC calls except those listed separately" are
// 1 credit, getProgramAccounts is 10. Another provider's plan is another table: change it here and nowhere else.
export const RPC_CREDIT_WEIGHTS: ReadonlyMap<string, number> = new Map([["getProgramAccounts", 10]]);
export const DEFAULT_RPC_CREDITS = 1;

/** One method's counts for one UTC hour. */
export interface RpcUsageRow {
  /** The start of the hour the calls were made in, ISO ("2026-10-06T14:00:00.000Z"): sorts as time does. */
  hourUtc: string;
  method: string;
  calls: number;
  failures: number;
}

export interface RpcUsage {
  /** One request that left this process, and whether it failed. */
  record(method: string, failed: boolean): void;
  /** Everything counted since the last take, oldest hour first; the counter starts again from zero. */
  take(): RpcUsageRow[];
  /** Puts the rows of a take() back (a flush that failed), so the next flush writes them too. */
  restore(rows: readonly RpcUsageRow[]): void;
}

interface Counts {
  calls: number;
  failures: number;
}

export const hourStartIso = (ms: number): string => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();

/** Milliseconds from `nowMs` to the next top of the UTC hour (a full hour exactly on it). */
export const msUntilNextHour = (nowMs: number): number => HOUR_MS - (((nowMs % HOUR_MS) + HOUR_MS) % HOUR_MS);

/** The credits `calls` calls of `method` cost. */
export const creditsOf = (method: string, calls: number): number => calls * (RPC_CREDIT_WEIGHTS.get(method) ?? DEFAULT_RPC_CREDITS);

export const totalCredits = (rows: readonly { method: string; calls: number }[]): number => rows.reduce((sum, r) => sum + creditsOf(r.method, r.calls), 0);

/**
 * The month's credits as the last 24 hours project them: a day's credits times 30. The first day after a start has fewer than 24 hours of rows and so
 * projects low; a burn that threatens the plan is far above any threshold even then.
 */
export const projectMonthlyCredits = (last24Hours: readonly { method: string; calls: number }[]): number => totalCredits(last24Hours) * 30;

/** A counter whose hours come from `now` (UTC wall clock; tests pass a fake). */
export function makeRpcUsage(now: () => number = Date.now): RpcUsage {
  const byHour = new Map<string, Map<string, Counts>>();

  function add(hourUtc: string, method: string, calls: number, failures: number): void {
    const methods = byHour.get(hourUtc) ?? new Map<string, Counts>();
    const counts = methods.get(method) ?? { calls: 0, failures: 0 };
    counts.calls += calls;
    counts.failures += failures;
    methods.set(method, counts);
    byHour.set(hourUtc, methods);
  }

  return {
    record: (method, failed) => add(hourStartIso(now()), method, 1, failed ? 1 : 0),
    take() {
      const rows = [...byHour].flatMap(([hourUtc, methods]) => [...methods].map(([method, c]): RpcUsageRow => ({ hourUtc, method, calls: c.calls, failures: c.failures })));
      byHour.clear();
      return rows.sort((a, b) => (a.hourUtc === b.hourUtc ? a.method.localeCompare(b.method) : a.hourUtc.localeCompare(b.hourUtc)));
    },
    restore(rows) {
      for (const r of rows) add(r.hourUtc, r.method, r.calls, r.failures);
    },
  };
}

const TOP_METHODS = 5;

/**
 * The one line a flush logs: "rpc last hour: 1234 calls, ~2345 credits (top: getProgramAccounts 100, getAccountInfo 800)". The methods are ranked by the
 * credits they cost (the thing that is budgeted) and shown with their calls; the first line after a start covers only the time since the start.
 */
export function describeUsage(rows: readonly RpcUsageRow[]): string {
  const callsBy = new Map<string, number>();
  for (const r of rows) callsBy.set(r.method, (callsBy.get(r.method) ?? 0) + r.calls);
  const methods = [...callsBy].map(([method, calls]) => ({ method, calls }));
  const ranked = [...methods].sort((a, b) => creditsOf(b.method, b.calls) - creditsOf(a.method, a.calls) || b.calls - a.calls || a.method.localeCompare(b.method));
  const calls = methods.reduce((sum, m) => sum + m.calls, 0);
  const top = ranked.slice(0, TOP_METHODS).map((m) => `${m.method} ${m.calls}`).join(", ");
  return `rpc last hour: ${calls} calls, ~${totalCredits(methods)} credits${top ? ` (top: ${top})` : ""}`;
}
