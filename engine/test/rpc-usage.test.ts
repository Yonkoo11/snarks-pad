// RPC call counting (src/rpcUsage.ts): the credit weights, the per-hour per-method counter on a fake clock, the month projection, the hour arithmetic and the
// one line a flush logs. The flush, its timer, the database and the budget check are in test/rpc-budget.test.ts; the guard's own counting in test/rpc-guard.test.ts.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RPC_CREDITS, HOUR_MS, RPC_CREDIT_WEIGHTS, creditsOf, describeUsage, hourStartIso, makeRpcUsage, msUntilNextHour, projectMonthlyCredits, totalCredits,
  type RpcUsageRow,
} from "../src/rpcUsage";

const T0 = Date.parse("2095-03-01T14:20:00Z");

describe("credit weights", () => {
  test("getProgramAccounts costs 10 credits a call; every other method costs 1", () => {
    expect(RPC_CREDIT_WEIGHTS.get("getProgramAccounts")).toBe(10);
    expect(DEFAULT_RPC_CREDITS).toBe(1);
    expect(creditsOf("getProgramAccounts", 3)).toBe(30);
    for (const method of ["getAccountInfo", "getMultipleAccounts", "getSlot", "getLatestBlockhash", "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getBalance", "unknown"]) {
      expect(creditsOf(method, 7)).toBe(7);
    }
  });

  test("a method named like an Object property is an ordinary 1-credit method, not NaN", () => {
    for (const method of ["constructor", "toString", "valueOf", "hasOwnProperty"]) expect(creditsOf(method, 4)).toBe(4);
  });

  test("a total adds each method at its own weight; the month is a day's credits times 30", () => {
    const day = [{ method: "getProgramAccounts", calls: 100 }, { method: "getAccountInfo", calls: 500 }, { method: "getSlot", calls: 0 }];
    expect(totalCredits(day)).toBe(1_500);
    expect(projectMonthlyCredits(day)).toBe(45_000);
    expect(projectMonthlyCredits([])).toBe(0);
  });
});

describe("the counter", () => {
  test("counts calls and failures per UTC hour and method, hours taken from the clock it is given", () => {
    const clock = { now: T0 };
    const usage = makeRpcUsage(() => clock.now);
    usage.record("getSlot", false);
    usage.record("getSlot", true);
    usage.record("getProgramAccounts", false);
    clock.now = T0 + HOUR_MS;
    usage.record("getSlot", false);
    expect(usage.take()).toEqual([
      { hourUtc: "2095-03-01T14:00:00.000Z", method: "getProgramAccounts", calls: 1, failures: 0 },
      { hourUtc: "2095-03-01T14:00:00.000Z", method: "getSlot", calls: 2, failures: 1 },
      { hourUtc: "2095-03-01T15:00:00.000Z", method: "getSlot", calls: 1, failures: 0 },
    ]);
  });

  test("a call a millisecond before the top of the hour belongs to that hour, one on the top to the next", () => {
    const clock = { now: Date.parse("2095-03-01T14:59:59.999Z") };
    const usage = makeRpcUsage(() => clock.now);
    usage.record("getSlot", false);
    clock.now += 1;
    usage.record("getSlot", false);
    expect(usage.take().map((r) => [r.hourUtc, r.calls])).toEqual([["2095-03-01T14:00:00.000Z", 1], ["2095-03-01T15:00:00.000Z", 1]]);
  });

  test("take() empties the counter: the next one starts from zero", () => {
    const usage = makeRpcUsage(() => T0);
    usage.record("getSlot", false);
    expect(usage.take().length).toBe(1);
    expect(usage.take()).toEqual([]);
  });

  test("restore() adds a failed flush's rows back to what was counted while it ran: nothing is lost, nothing counted twice", () => {
    const usage = makeRpcUsage(() => T0);
    usage.record("getSlot", true);
    usage.record("getSlot", false);
    const rows = usage.take();
    usage.record("getSlot", false); // counted while the write was failing
    usage.record("getBalance", false);
    usage.restore(rows);
    expect(usage.take()).toEqual([
      { hourUtc: "2095-03-01T14:00:00.000Z", method: "getBalance", calls: 1, failures: 0 },
      { hourUtc: "2095-03-01T14:00:00.000Z", method: "getSlot", calls: 3, failures: 1 },
    ]);
  });

  test("the default clock is the wall clock: a call now lands in the current UTC hour", () => {
    const usage = makeRpcUsage();
    usage.record("getSlot", false);
    expect(usage.take().map((r) => r.hourUtc)).toEqual([hourStartIso(Date.now())]);
  });
});

describe("hour arithmetic", () => {
  test("hourStartIso rounds down to the top of the UTC hour", () => {
    expect(hourStartIso(T0)).toBe("2095-03-01T14:00:00.000Z");
    expect(hourStartIso(T0 + 39 * 60_000 + 59_999)).toBe("2095-03-01T14:00:00.000Z");
    expect(hourStartIso(T0 + 40 * 60_000)).toBe("2095-03-01T15:00:00.000Z");
  });

  test("msUntilNextHour: 40 minutes from 14:20, a whole hour exactly on the top, one millisecond a millisecond before it", () => {
    expect(msUntilNextHour(T0)).toBe(40 * 60_000);
    expect(msUntilNextHour(Date.parse("2095-03-01T15:00:00.000Z"))).toBe(HOUR_MS);
    expect(msUntilNextHour(Date.parse("2095-03-01T14:59:59.999Z"))).toBe(1);
  });
});

describe("the hour's one line", () => {
  const row = (method: string, calls: number, hourUtc = "2095-03-01T14:00:00.000Z"): RpcUsageRow => ({ hourUtc, method, calls, failures: 0 });

  test("an hour with no calls still has its line", () => {
    expect(describeUsage([])).toBe("rpc last hour: 0 calls, ~0 credits");
  });

  test("calls, credits at the weights, and the methods ranked by the credits they cost, shown with their calls (rows of several hours add up)", () => {
    const rows = [row("getAccountInfo", 500), row("getAccountInfo", 300, "2095-03-01T15:00:00.000Z"), row("getSlot", 700), row("getProgramAccounts", 100)];
    expect(describeUsage(rows)).toBe("rpc last hour: 1600 calls, ~2500 credits (top: getProgramAccounts 100, getAccountInfo 800, getSlot 700)");
  });

  test("only the five costliest methods are named; the totals still cover them all", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((m, i) => row(`m${m}`, 10 + i));
    const line = describeUsage(rows);
    expect(line).toBe("rpc last hour: 91 calls, ~91 credits (top: mg 16, mf 15, me 14, md 13, mc 12)");
  });
});
