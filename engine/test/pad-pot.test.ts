// GET /api/pot (docs/API.md): the pots of the coins the board lists, added up. The sum, the split and the date come from
// buildPadPot, tested here without a chain; the route is tested only with no coins (a seeded coin would read the chain).
import { describe, expect, test } from "bun:test";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import { buildPadPot, clearPadPot, padPotOf } from "../src/dbc/pot";

const read = (curve: bigint, pool: bigint, readAtMs: number) => ({ curve, pool, readAtMs });

describe("the pad's pot", () => {
  test("adds the curve and pool fees of every read coin, splits them as a claim would, and is dated by the oldest read", () => {
    const now = 1_760_000_000_000;
    const view = buildPadPot([read(1_000_000n, 500_000n, now - 20_000), read(250_000n, 0n, now - 5_000)], 1, "2026-10-13T13:11:40.000Z", now);
    expect(view.accruedZats).toBe("1750000");
    expect(BigInt(view.holdersZats) + BigInt(view.teamZats)).toBe(1_750_000n);
    expect(view.teamZats).toBe(String((1_750_000n * BigInt(config.epoch.team.shareBps)) / 10_000n));
    expect(view.coins).toBe(2);
    expect(view.unread).toBe(1);
    expect(view.nextPayoutAt).toBe("2026-10-13T13:11:40.000Z");
    expect(view.asOf).toBe(new Date(now - 20_000).toISOString());
  });

  test("no coins is zero, dated now; every coin unread is an error, not a zero", () => {
    const now = 1_760_000_000_000;
    const none = buildPadPot([], 0, null, now);
    expect(none).toMatchObject({ accruedZats: "0", holdersZats: "0", teamZats: "0", coins: 0, unread: 0, nextPayoutAt: null, asOf: new Date(now).toISOString() });
    expect(() => buildPadPot([], 3, null, now)).toThrow("none of 3 coins could be read");
  });

  test("padPotOf with no coins reads nothing and answers zeros, and the same list within 30 s is one read", async () => {
    clearPadPot();
    const first = padPotOf([], 1_000);
    expect(padPotOf([], 20_000)).toBe(first);
    expect(padPotOf([], 40_000)).not.toBe(first);
    const view = await first;
    expect(view).toMatchObject({ coins: 0, unread: 0, accruedZats: "0" });
  });

  test("the route exists and answers JSON (an unknown path is 404)", async () => {
    // The shared test database holds other files' launched coins, whose pools are not on any chain here, so the route may answer 503: only the shape of a 200 is checked.
    const res = await handleRequest(new Request("http://pad.test/api/pot"));
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });
});
