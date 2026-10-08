// S4-05 (audit/S4-DIFFERENTIAL-REVIEW.md): POST /api/coins/launch-tx was public with no limit of its own, and every call that got as far as a transaction left a
// coin row (never pruned) and a metadata file behind whether or not anyone signed, so an unauthenticated loop grew the database, /m and the work of every
// listCoins() scan without bound. Now (src/api/launchLimits.ts, docs/API.md v2.8.2: 10 calls per client address per minute (429 rate_limited with
// retry-after, the same window as uploads), and at most 20 unconfirmed launches per address (429 rate_limited) and 2,000 in all (503 busy), each with
// retry-after. These cases need no chain: a refusal comes before any chain read.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import { CAP_RETRY_AFTER_S, LAUNCHES_PER_MINUTE, MAX_PENDING_PER_IP, MAX_PENDING_TOTAL, PAD_BUILDS_PER_MINUTE, PENDING_COUNTS_FOR_MS, clearLaunchLimits, launchLimiter, reserveLaunch, type LaunchSlot } from "../src/api/launchLimits";
import * as db from "../src/db";

const B = "http://pad.test/api";
const key = () => Keypair.generate().publicKey.toBase58();
const minted: string[] = [];

/** A coin row as a launch leaves it before anyone signs: pending, as old as now. */
function pendingCoin(): string {
  const mint = key();
  minted.push(mint);
  db.upsertCoin({ mint, name: "Cap", symbol: "CAP", imageUrl: "", description: "", creator: key(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
  return mint;
}

beforeEach(clearLaunchLimits); // the limiter is process-wide and the test database is shared: start every case with nothing counted
afterEach(() => {
  clearLaunchLimits();
  for (const m of minted.splice(0)) db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
});

const validBody = () => JSON.stringify({ creator: key(), name: "Cap", symbol: "CAP", description: "", imageUrl: "" });
const launchTx = (ip: string, body: string = validBody()) => handleRequest(new Request(`${B}/coins/launch-tx`, { method: "POST", body, headers: { "content-type": "application/json" } }), { ip });

/** Takes `n` places for `ip` as launches that were built and recorded (each with a real pending row). */
function hold(ip: string, n: number): LaunchSlot[] {
  return Array.from({ length: n }, () => {
    const r = reserveLaunch(ip);
    if (!r.ok) throw new Error(`refused at ${n}`);
    r.slot.built(pendingCoin());
    return r.slot;
  });
}

describe("10 calls per address per minute", () => {
  test("the stated numbers", () => {
    expect([LAUNCHES_PER_MINUTE, MAX_PENDING_PER_IP, MAX_PENDING_TOTAL, CAP_RETRY_AFTER_S]).toEqual([10, 20, 2_000, 600]);
  });

  test("the 11th call in a minute is 429 rate_limited with retry-after, answered before the body is read; other addresses are not affected", async () => {
    for (let i = 0; i < LAUNCHES_PER_MINUTE; i++) {
      const r = await launchTx("203.0.113.10", JSON.stringify({ creator: "nope" }));
      expect(r.status).toBe(400); // past the limiter, refused by validation
    }
    const refused = await launchTx("203.0.113.10", "this is not JSON at all");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    const wait = Number(refused.headers.get("retry-after"));
    expect(Number.isInteger(wait) && wait >= 1 && wait <= 60).toBe(true);
    expect((await launchTx("203.0.113.11", JSON.stringify({ creator: "nope" }))).status).toBe(400);
    launchLimiter.clear();
    expect((await launchTx("203.0.113.10", JSON.stringify({ creator: "nope" }))).status).toBe(400);
  });

  test("a client that sends no address (a test calling the handler, or a proxy that sent none) shares one bucket: it is limited, never exempt", async () => {
    const ask = () => handleRequest(new Request(`${B}/coins/launch-tx`, { method: "POST", body: JSON.stringify({ creator: "nope" }), headers: { "content-type": "application/json" } }));
    for (let i = 0; i < LAUNCHES_PER_MINUTE; i++) expect((await ask()).status).toBe(400);
    expect((await ask()).status).toBe(429);
  });
});

describe("20 unconfirmed launches per address", () => {
  test("an address holding 20 is refused 429 rate_limited with retry-after before any chain read; another address still has its places", async () => {
    hold("203.0.113.20", MAX_PENDING_PER_IP);
    const refused = await launchTx("203.0.113.20");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect(refused.headers.get("retry-after")).toBe(String(CAP_RETRY_AFTER_S));
    expect(reserveLaunch("203.0.113.21").ok).toBe(true);
  });

  test("a bad request never takes a place: validation comes first, so at the cap a malformed body is still the 400 it would be", async () => {
    hold("203.0.113.22", MAX_PENDING_PER_IP);
    expect((await launchTx("203.0.113.22", JSON.stringify({ creator: "nope" }))).status).toBe(400);
  });

  test("a launch counts from the moment its transaction starts to be built: 20 builds in flight fill the address, and one that fails gives its place back", () => {
    const slots = Array.from({ length: MAX_PENDING_PER_IP }, () => {
      const r = reserveLaunch("203.0.113.23");
      if (!r.ok) throw new Error("refused early");
      return r.slot;
    });
    const blocked = reserveLaunch("203.0.113.23");
    expect(blocked).toMatchObject({ ok: false, status: 429, error: "rate_limited", retryAfter: CAP_RETRY_AFTER_S });
    slots[0]!.abandon();
    slots[0]!.abandon(); // idempotent
    expect(reserveLaunch("203.0.113.23").ok).toBe(true);
    expect(reserveLaunch("203.0.113.23").ok).toBe(false);
  });

  test("a launch stops counting when it is confirmed and when the sweep drops it: the rows decide, nothing has to be told", () => {
    const slots = hold("203.0.113.24", MAX_PENDING_PER_IP);
    expect(reserveLaunch("203.0.113.24").ok).toBe(false);
    const [first, second] = minted.slice(-MAX_PENDING_PER_IP, -MAX_PENDING_PER_IP + 2) as [string, string];
    db.markCoinLaunched(first, key());
    expect(reserveLaunch("203.0.113.24").ok).toBe(true); // confirmed: the one place is free again (and now taken)
    expect(reserveLaunch("203.0.113.24").ok).toBe(false);
    expect(db.deleteUnconfirmedCoin(second)).toBe(true); // dropped by the sweep
    expect(reserveLaunch("203.0.113.24").ok).toBe(true);
    expect(slots).toHaveLength(MAX_PENDING_PER_IP);
  });
});

describe("2,000 unconfirmed launches in all", () => {
  test("the pad at its cap answers 503 busy with retry-after, to every address", async () => {
    const spy = spyOn(db, "countPendingCoinsSince").mockReturnValue(MAX_PENDING_TOTAL);
    try {
      const r = await launchTx("203.0.113.30");
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "busy" });
      expect(r.headers.get("retry-after")).toBe(String(CAP_RETRY_AFTER_S));
      expect(reserveLaunch("203.0.113.31")).toMatchObject({ ok: false, status: 503, error: "busy" });
    } finally {
      spy.mockRestore();
    }
  });

  test("builds in flight count toward it: with one place left, the first takes it and the second is refused until the first gives it back", () => {
    const spy = spyOn(db, "countPendingCoinsSince").mockReturnValue(MAX_PENDING_TOTAL - 1);
    try {
      const first = reserveLaunch("203.0.113.32");
      expect(first.ok).toBe(true);
      expect(reserveLaunch("203.0.113.33")).toMatchObject({ ok: false, status: 503, error: "busy" });
      if (first.ok) first.slot.abandon();
      expect(reserveLaunch("203.0.113.33").ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("the real count is the rows still pending: a confirmed launch is not one", () => {
    const before = db.countPendingCoins();
    const m = pendingCoin();
    expect(db.countPendingCoins()).toBe(before + 1);
    db.markCoinLaunched(m, key());
    expect(db.countPendingCoins()).toBe(before);
  });
});

// Audit S6, product decision 4: a prepared launch counts only while its transaction can still land, and the pad builds at most 100 a minute.
describe("a prepared launch counts for 3 minutes; the pad builds 100 a minute", () => {
  test("the stated numbers", () => {
    expect([PAD_BUILDS_PER_MINUTE, PENDING_COUNTS_FOR_MS]).toEqual([100, 180_000]);
  });

  test("an address full of prepared launches has its places back once they are older than 3 minutes, though their rows are still pending", () => {
    const t0 = Date.parse("2097-01-01T00:00:00Z");
    for (let i = 0; i < MAX_PENDING_PER_IP; i++) {
      const r = reserveLaunch("203.0.113.40", t0);
      if (!r.ok) throw new Error(`refused at ${i}`);
      r.slot.built(pendingCoin());
    }
    expect(reserveLaunch("203.0.113.40", t0 + PENDING_COUNTS_FOR_MS - 1).ok).toBe(false);
    expect(reserveLaunch("203.0.113.40", t0 + PENDING_COUNTS_FOR_MS).ok).toBe(true);
  });

  test("the pad-wide count is of rows prepared in the last 3 minutes, not every pending row", () => {
    const old = pendingCoin();
    db.getDb().query("UPDATE coins SET createdAt = $t WHERE mint = $m").run({ $t: new Date(Date.now() - PENDING_COUNTS_FOR_MS - 1_000).toISOString(), $m: old });
    const fresh = pendingCoin();
    const since = new Date(Date.now() - PENDING_COUNTS_FOR_MS).toISOString();
    const n = db.countPendingCoinsSince(since);
    expect(n).toBeGreaterThanOrEqual(1);
    db.getDb().query("UPDATE coins SET createdAt = $t WHERE mint = $m").run({ $t: new Date(Date.now() - PENDING_COUNTS_FOR_MS - 1_000).toISOString(), $m: fresh });
    expect(db.countPendingCoinsSince(since)).toBe(n - 1);
  });

  test("the 101st build in a minute, from any address, is 503 busy with retry-after, and one alert is recorded for the episode", () => {
    const t0 = Date.parse("2097-02-01T00:00:00Z");
    for (let i = 0; i < PAD_BUILDS_PER_MINUTE; i++) {
      const r = reserveLaunch(`203.0.113.${50 + (i % 100)}`, t0 + i);
      if (!r.ok) throw new Error(`refused at ${i}`);
      r.slot.abandon();
    }
    const refused = reserveLaunch("203.0.113.90", t0 + 200);
    expect(refused).toMatchObject({ ok: false, status: 503, error: "busy" });
    if (!refused.ok) expect(refused.retryAfter >= 1 && refused.retryAfter <= 60).toBe(true);
    expect(reserveLaunch("203.0.113.91", t0 + 300).ok).toBe(false);
    const open = db.listOpenAlerts().filter((a) => a.kind === "launch_cap");
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toContain("100 launch transactions in a minute");
    expect(reserveLaunch("203.0.113.92", t0 + 60_000).ok).toBe(true); // the minute passed
    expect(db.listOpenAlerts().filter((a) => a.kind === "launch_cap")).toHaveLength(1); // still open: quiet for less than ten minutes
    expect(reserveLaunch("203.0.113.93", t0 + 300 + 10 * 60_000 + 1).ok).toBe(true);
    expect(db.listOpenAlerts().filter((a) => a.kind === "launch_cap")).toHaveLength(0); // resolved after ten quiet minutes
  });
});
