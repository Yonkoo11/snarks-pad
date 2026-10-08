// The keeper and a chain it cannot read (contract v2.8.1, src/scheduler.ts): on 2026-10-05 the RPC key's credits ran out and every call was answered 429.
// The keeper backs off, 30 s doubling to at most 5 minutes, with one cheap probe per try, touches nothing else on the chain meanwhile, and logs one line
// when the chain goes and one when it comes back, never a line per try. The real loop runs on a fake clock with a fake sleep: 40 minutes of 10-second
// ticks in a few milliseconds. The shared test DB is used like test/scheduler.test.ts does, in its own stretch of the year 2096.
import { afterEach, describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { ChainUnavailableError } from "../src/rpcGuard";
import { CHAIN_BACKOFF_FIRST_MS, CHAIN_BACKOFF_MAX_MS, SCHEDULER_NOOP_META, newSchedulerState, runKeeperLoop, type SchedulerDeps } from "../src/scheduler";

const T0 = Date.parse("2096-06-01T00:00:00Z");
const MIN = 60_000;
const TICK = 10_000;

afterEach(() => {
  db.getDb().query("DELETE FROM meta WHERE key = ?").run(SCHEDULER_NOOP_META);
});

/** A keeper whose every chain read is answered 429 until `chain.down` turns false; it records when it probed, sampled, read the faucet and ran. */
function keeper(clock: { now: number }, chain: { down: boolean }) {
  const seen = { probes: [] as number[], samples: [] as number[], faucet: [] as number[], runs: [] as number[], logs: [] as Record<string, unknown>[] };
  const capped = () => new ChainUnavailableError("rate_limited", 'HTTP 429 {"error":{"code":-32429,"message":"max usage reached"}}');
  const read = async (list: number[]) => {
    list.push(clock.now);
    if (chain.down) throw capped();
  };
  const deps: SchedulerDeps = {
    nowMs: () => clock.now,
    runEpoch: async () => (await read(seen.runs), { epoch: null }),
    takeDueSamples: async () => (await read(seen.samples), 0),
    readFaucet: async () => (await read(seen.faucet), null),
    probeChain: () => read(seen.probes),
    log: (e) => seen.logs.push(e),
  };
  return { deps, seen };
}

/** Runs the real loop until `untilMs` on the fake clock; the chain answers again from `upAtMs` on. */
function loop(deps: SchedulerDeps, clock: { now: number }, chain: { down: boolean }, upAtMs: number, untilMs: number) {
  return runKeeperLoop(deps, {
    tickMs: TICK,
    once: false,
    shouldStop: () => clock.now >= untilMs,
    sleep: async (ms) => {
      clock.now += ms;
      if (clock.now >= upAtMs) chain.down = false;
    },
  }, newSchedulerState());
}

describe("the keeper backs off from a chain it cannot read", () => {
  test("429 on every read: one line, then one probe after 30 s, 1, 2, 4 and 5 minutes (never longer), nothing else read meanwhile, one line when it answers", async () => {
    db.setMeta(SCHEDULER_NOOP_META, new Date(T0).toISOString()); // the epoch is two days off: this run only samples and reads the faucet
    const start = T0 + 60 * MIN;
    const clock = { now: start };
    const chain = { down: true };
    const { deps, seen } = keeper(clock, chain);
    const ticks = await loop(deps, clock, chain, start + 25 * MIN, start + 40 * MIN);
    expect(ticks).toBe(240); // one every 10 s from 0:00 to 39:50

    const rel = (ms: number[]) => ms.map((t) => (t - start) / 1000);
    expect(rel(seen.probes)).toEqual([30, 90, 210, 450, 750, 1050, 1350, 1650]);
    const gaps = seen.probes.slice(1).map((t, i) => t - seen.probes[i]!);
    expect(gaps).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000]);
    expect([CHAIN_BACKOFF_FIRST_MS, CHAIN_BACKOFF_MAX_MS]).toEqual([30_000, 300_000]);

    // the faucet read that found the chain down at the start, then nothing until a probe answered at 27.5 minutes
    expect(rel(seen.faucet)).toEqual([0, 1650, 1950, 2250]);
    expect(seen.samples.every((t) => t >= start + 1650 * 1000)).toBe(true);
    expect(seen.samples.length).toBe((2390 - 1650) / 10 + 1); // and every tick after it

    const events = seen.logs.map((l) => l.event);
    expect(events.filter((e) => e === "chain_unavailable").length).toBe(1);
    expect(events.filter((e) => e === "chain_available").length).toBe(1);
    expect(events.filter((e) => e === "faucet_error" || e === "sample_error" || e === "error")).toEqual([]); // no line per failed try
    // during the 27.5 minutes down: the one line, then only the heartbeat every 10 minutes (after it, a resume of unfinished work in the shared DB may log too)
    const whileDown = seen.logs.filter((l) => Date.parse(String(l.at)) < start + 1650 * 1000).map((l) => l.event);
    expect(whileDown).toEqual(["chain_unavailable", "idle", "idle"]);
    const down = seen.logs.find((l) => l.event === "chain_unavailable")!;
    expect(down).toMatchObject({ retryInMs: 30_000 });
    expect(String(down.error)).toContain("rate_limited");
    expect(seen.logs.find((l) => l.event === "chain_available")).toMatchObject({ downForMs: 1650 * 1000 });
  });

  test("a run that meets the cap backs off the same way and is not logged as a failed run; the heartbeat says since when the chain is down", async () => {
    db.setMeta(SCHEDULER_NOOP_META, new Date(T0 - 49 * 60 * MIN).toISOString()); // the epoch is due now
    const start = T0;
    const clock = { now: start };
    const chain = { down: true };
    const { deps, seen } = keeper(clock, chain);
    deps.readFaucet = undefined;
    deps.takeDueSamples = async () => 0;
    await loop(deps, clock, chain, start + 60 * MIN, start + 13 * MIN);
    expect(seen.runs).toEqual([start]); // tried once, then only probes
    expect(seen.probes.map((t) => (t - start) / 1000)).toEqual([30, 90, 210, 450, 750]); // 0.5, 1.5, 3.5, 7.5 and 12.5 minutes in
    const events = seen.logs.map((l) => l.event);
    expect(events.filter((e) => e === "error")).toEqual([]);
    expect(events.filter((e) => e === "chain_unavailable").length).toBe(1);
    const heartbeat = seen.logs.find((l) => l.event === "idle");
    expect(heartbeat).toMatchObject({ chainUnavailableSince: new Date(start).toISOString(), outcome: "waiting for the chain" });
  });
});
