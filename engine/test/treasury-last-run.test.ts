// ledger.ts lastRunOf: what the Payouts page says about the keeper's last due run (larpcheck 2026-10-12 read a quiet keeper as a broken cadence).
import { describe, expect, test } from "bun:test";
import { lastRunOf } from "../src/ledger";

const T_ROUND = "2026-10-07T13:10:54.000Z";
const T_LATER = "2026-10-09T13:11:40.000Z";
const T_EARLIER = "2026-10-05T13:00:00.000Z";

describe("the Payouts page's last run", () => {
  test("a due run that found nothing, newer than the last round, is the last run and says so", () => {
    expect(lastRunOf(T_ROUND, T_LATER)).toEqual({ lastRunAt: T_LATER, lastRunFoundNothing: true });
  });

  test("a no-op older than the last round is not reported: the round is the last run", () => {
    expect(lastRunOf(T_ROUND, T_EARLIER)).toEqual({ lastRunAt: T_ROUND, lastRunFoundNothing: false });
  });

  test("no round yet: a no-op is the last run; nothing at all is null", () => {
    expect(lastRunOf(null, T_LATER)).toEqual({ lastRunAt: T_LATER, lastRunFoundNothing: true });
    expect(lastRunOf(null, null)).toEqual({ lastRunAt: null, lastRunFoundNothing: false });
    expect(lastRunOf(T_ROUND, null)).toEqual({ lastRunAt: T_ROUND, lastRunFoundNothing: false });
  });

  test("an unparsable no-op stamp is ignored", () => {
    expect(lastRunOf(T_ROUND, "not a date")).toEqual({ lastRunAt: T_ROUND, lastRunFoundNothing: false });
  });
});
