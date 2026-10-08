// S4-02 (audit/S4-DIFFERENTIAL-REVIEW.md): a holder sample whose chain reads failed is NOT a taken sample (src/epoch/snapshots.ts). Before, a pass whose
// reads were all answered 429 still counted as taken: no row was stored, the keeper's chain backoff never saw the error, and on mainnet (3 of 6 samples wanted
// per window) the coin was not claimed that epoch with nothing said. Now an instant is spent for a coin only when the coin was read; a pass that read nothing
// because the chain could not be read spends nothing and throws, so the keeper backs off and the same instants are due at its next try; once the window has
// ended the keeper stops waiting for samples (the epoch must run) and a coin short of the claim gate's minimum raises a stored alert. The reader is a stand-in
// that throws what the RPC guard throws; the shared test DB is used in its own stretch of the year 2097, with every other launched coin set aside meanwhile.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import * as db from "../src/db";
import { claimRemainingCoins, type ClaimDeps } from "../src/epoch/engine";
import { SAMPLES_SHORT_ALERT, ensurePlan, loadPlan, takeDueSamples, takeSamplesNow, type HolderReader } from "../src/epoch/snapshots";
import { ChainUnavailableError } from "../src/rpcGuard";
import { SCHEDULER_NOOP_META, keeperTick, newSchedulerState, type SchedulerDeps } from "../src/scheduler";
import { validatorUp } from "./helpers/validator-up";

const HOUR = 3_600_000;
const T0 = Date.parse("2097-03-01T00:00:00Z");
const key = () => Keypair.generate().publicKey.toBase58();
const holder = (balance: bigint) => ({ wallet: key(), balance });
const down = () => new ChainUnavailableError("rate_limited", "HTTP 429 Too Many Requests: max usage reached");
const iso = (ms: number) => new Date(ms).toISOString();
const rows = (mint: string, from: number, to: number) => db.listHolderSamples(mint, iso(from), iso(to)).length;
const firstMs: (min: number, max: number) => number = (min) => min; // the first millisecond of every slice: instants at T0, T0 + 1 h, ...

const mine: string[] = [];
let aside: string[] = [];
const setStatus = (mints: string[], status: "pending" | "launched") => {
  for (const m of mints) db.getDb().query("UPDATE coins SET status = $s WHERE mint = $m").run({ $s: status, $m: m });
};

/** A launched coin for this test; every earlier one of this file goes back to pending, so a pass reads exactly the coins the test made. */
function launch(): string {
  setStatus(mine, "pending");
  const mint = key();
  mine.push(mint);
  db.upsertCoin({ mint, name: "Retry", symbol: "RT", imageUrl: "", description: "", creator: key(), createdAt: iso(T0), feeBps: 100, poolId: key(), mintDecimals: 6, status: "launched", configId: null });
  return mint;
}

beforeAll(() => {
  aside = db.listCoins().filter((c) => c.status === "launched").map((c) => c.mint);
  setStatus(aside, "pending");
});
afterEach(() => {
  (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = original;
  const d = db.getDb();
  d.query("DELETE FROM meta WHERE key IN ('snapshot_plan', ?)").run(SCHEDULER_NOOP_META);
  d.query("DELETE FROM alerts WHERE kind = ?").run(SAMPLES_SHORT_ALERT);
  for (const m of mine) d.query("DELETE FROM holder_samples WHERE mint = ?").run(m);
});
afterAll(() => {
  for (const m of mine) db.getDb().query("DELETE FROM coins WHERE mint = ?").run(m);
  setStatus(aside, "launched");
});
const original = config.epoch.snapshots.minWindowSamples;
const openAlerts = (mint: string) => db.listOpenAlerts().filter((a) => a.kind === SAMPLES_SHORT_ALERT && a.epochId === mint);

describe("a failed read is not a taken sample", () => {
  test("2 of the 6 first attempts fail: each retried after the failure, so all 6 instants end as real stored samples", async () => {
    const mint = launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    let attempts = 0;
    const reader: HolderReader = async () => {
      attempts++;
      if (attempts === 2 || attempts === 4) throw down();
      return [holder(10n)];
    };
    for (let i = 0; i < 6; i++) {
      const at = T0 + i * HOUR + 1_000;
      try {
        await takeDueSamples(at, loadPlan()!, reader);
      } catch (err) {
        expect(err).toBeInstanceOf(ChainUnavailableError);
        expect(loadPlan()!.taken).toBe(i); // the failed instant is still due
        await takeDueSamples(at + 30_000, loadPlan()!, reader); // the keeper's retry after its backoff
      }
    }
    expect(attempts).toBe(8); // 6 instants and the 2 retries
    expect(rows(mint, T0, T0 + 6 * HOUR)).toBe(6);
    expect(loadPlan()!.taken).toBe(6);
  });

  test("every attempt fails: 0 stored, the counter does not move however often it is tried, and the error reaches the caller; one answer later spends the instants once", async () => {
    const mint = launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    const throttled: HolderReader = async () => {
      throw down();
    };
    for (let i = 0; i < 4; i++) {
      await expect(takeDueSamples(T0 + 2 * HOUR + 1_000 + i * 60_000, loadPlan()!, throttled)).rejects.toBeInstanceOf(ChainUnavailableError);
      expect(loadPlan()!.taken).toBe(0);
      expect(loadPlan()!.owed ?? {}).toEqual({});
    }
    expect(rows(mint, T0, T0 + 6 * HOUR)).toBe(0);
    const consumed = await takeDueSamples(T0 + 2 * HOUR + 400_000, loadPlan()!, async () => [holder(5n)]);
    expect(consumed).toBe(3); // the instants at 0, 1 and 2 h were all still due: one observation, stored once
    expect(rows(mint, T0, T0 + 6 * HOUR)).toBe(1);
    expect(loadPlan()!.taken).toBe(3);
  });

  test("some coins read and some not: the instant is spent only for the ones read; the others are retried alone", async () => {
    const readCoin = launch();
    const failedCoin = launch(); // `launch` set the first one aside: both must be launched now
    setStatus([readCoin], "launched");
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    let chainUp = false;
    const calls: string[] = [];
    const reader: HolderReader = async (mint) => {
      calls.push(mint);
      if (mint === failedCoin && !chainUp) throw down();
      return [holder(7n)];
    };
    await expect(takeDueSamples(T0 + 1_000, loadPlan()!, reader)).rejects.toBeInstanceOf(ChainUnavailableError); // the keeper hears of it and backs off
    expect(loadPlan()).toMatchObject({ taken: 1, owed: { [failedCoin]: 1 } });
    expect([rows(readCoin, T0, T0 + HOUR), rows(failedCoin, T0, T0 + HOUR)]).toEqual([1, 0]);

    chainUp = true;
    calls.length = 0;
    expect(await takeDueSamples(T0 + 31_000, loadPlan()!, reader)).toBe(0); // no new instant: only the coin that owes one is read
    expect(calls).toEqual([failedCoin]);
    expect([rows(readCoin, T0, T0 + HOUR), rows(failedCoin, T0, T0 + HOUR)]).toEqual([1, 1]);
    expect(loadPlan()).toMatchObject({ taken: 1, owed: {} });
  });

  test("what a coin owes and the next instant that falls due are one observation of it, not two", async () => {
    const readCoin = launch();
    const failedCoin = launch();
    setStatus([readCoin], "launched");
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    let chainUp = false;
    const reader: HolderReader = async (mint) => {
      if (mint === failedCoin && !chainUp) throw down();
      return [holder(7n)];
    };
    await expect(takeDueSamples(T0 + 1_000, loadPlan()!, reader)).rejects.toBeInstanceOf(ChainUnavailableError);
    chainUp = true;
    expect(await takeDueSamples(T0 + HOUR + 1_000, loadPlan()!, reader)).toBe(1); // the instant at 1 h, and the failed coin's debt from the one at 0
    expect([rows(readCoin, T0, T0 + 2 * HOUR), rows(failedCoin, T0, T0 + 2 * HOUR)]).toEqual([2, 1]);
    expect(loadPlan()).toMatchObject({ taken: 2, owed: {} });
  });

  test("a coin that fails for a reason of its own is skipped and its instant spent, as before; only a chain failure is retried", async () => {
    const mint = launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    const originalError = console.error;
    console.error = () => undefined; // the skipped coin is logged
    try {
      const consumed = await takeDueSamples(T0 + 1_000, loadPlan()!, async () => {
        throw new Error("could not decode a token account");
      });
      expect(consumed).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(loadPlan()).toMatchObject({ taken: 1, owed: {} });
    expect(rows(mint, T0, T0 + HOUR)).toBe(0);
  });

  test("a wrapper that kept only the guard's message still counts as the chain being unreadable", async () => {
    launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    const wrapped: HolderReader = async () => {
      throw new Error("failed to get info about account X: ChainUnavailableError: chain unavailable (timeout): no answer within 20000 ms");
    };
    await expect(takeDueSamples(T0 + 1_000, loadPlan()!, wrapped)).rejects.toThrow(/chain unavailable/);
    expect(loadPlan()!.taken).toBe(0);
  });

  test("takeSamplesNow stores the coins it could read, then throws the chain failure: a caller must not count that as a whole sample", async () => {
    const readCoin = launch();
    const failedCoin = launch();
    setStatus([readCoin], "launched");
    const reader: HolderReader = async (mint) => {
      if (mint === failedCoin) throw down();
      return [holder(3n)];
    };
    await expect(takeSamplesNow(T0 + 5_000, reader)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect([rows(readCoin, T0, T0 + HOUR), rows(failedCoin, T0, T0 + HOUR)]).toEqual([1, 0]);
    expect(await takeSamplesNow(T0 + 6_000, async () => [holder(3n)])).toBe(2);
  });
});

describe("the bound: the window", () => {
  const minThree = () => ((config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 3);

  test("once the window has ended a failing pass no longer holds the keeper back (the epoch must run), spends nothing, and a coin short of the gate's minimum raises an alert", async () => {
    minThree();
    const mint = launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    const failing: HolderReader = async () => {
      throw down();
    };
    const afterEnd = T0 + 6 * HOUR + 5_000;
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await takeDueSamples(afterEnd, loadPlan()!, failing)).toBe(0); // returns, does not throw
    } finally {
      console.error = originalError;
    }
    expect(loadPlan()!.taken).toBe(0);
    expect(rows(mint, T0, afterEnd)).toBe(0);
    const alerts = openAlerts(mint);
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.message).toContain("0 in the window");
    expect(alerts[0]!.message).toContain("3 wanted");
    expect(lines.filter((l) => l.startsWith("ALERT holder samples of"))).toHaveLength(1);
    await takeDueSamples(afterEnd + 60_000, loadPlan()!, failing); // tried again: still one alert, not two
    expect(openAlerts(mint).length).toBe(1);
    await takeDueSamples(afterEnd + 120_000, loadPlan()!, async () => [holder(1n)]);
    expect(openAlerts(mint).length).toBe(0); // its next sample resolves it
    expect(rows(mint, T0, afterEnd + 200_000)).toBe(1);
  });

  test("a coin that already holds the minimum is not alerted: its claim is not at risk", async () => {
    minThree();
    const mint = launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    for (const h of [1, 2, 3]) db.insertHolderSample(mint, iso(T0 + h * HOUR), [holder(1n)]);
    await takeDueSamples(T0 + 6 * HOUR + 5_000, loadPlan()!, async () => {
      throw down();
    });
    expect(openAlerts(mint)).toEqual([]);
  });

  test("on local and devnet (no samples required) a failed window raises no alert", async () => {
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0;
    const mint = launch();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    await takeDueSamples(T0 + 6 * HOUR + 5_000, loadPlan()!, async () => {
      throw down();
    });
    expect(openAlerts(mint)).toEqual([]);
  });
});

describe("the keeper hears of it", () => {
  const cadence = { epochEveryMs: 48 * HOUR, shieldedEveryMs: 7 * 24 * HOUR, tickMs: 60_000, resumeEveryMs: 15 * 60_000, firstEpochAt: null };

  test("a sample round that is answered 429 starts the keeper's backoff (one line) and spends nothing; after the probe answers, the same instants are taken", async () => {
    const mint = launch();
    db.setMeta(SCHEDULER_NOOP_META, iso(T0)); // the cycle starts at T0, its epoch is two days off: this run only samples
    const clock = { now: T0 + 30 * HOUR };
    let chainUp = false;
    const logs: Record<string, unknown>[] = [];
    const deps: SchedulerDeps = {
      nowMs: () => clock.now,
      runEpoch: async () => ({ epoch: null }),
      takeDueSamples: (nowMs, plan) => takeDueSamples(nowMs, plan, async () => (chainUp ? [holder(9n)] : Promise.reject(down()))),
      probeChain: async () => {
        if (!chainUp) throw down();
      },
      log: (e) => logs.push(e),
    };
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(state.chainDown).not.toBeNull();
    expect(logs.map((l) => l.event)).toEqual(["chain_unavailable"]); // the swallow in takeSamplesNow used to hide this
    expect(loadPlan()!.taken).toBe(0);
    expect(rows(mint, T0, T0 + 48 * HOUR)).toBe(0);

    clock.now += 10_000; // still inside the backoff: nothing is tried
    await keeperTick(deps, state, cadence);
    expect(loadPlan()!.taken).toBe(0);

    chainUp = true;
    clock.now += 30_000; // past the backoff: one probe, it answers, the round runs
    await keeperTick(deps, state, cadence);
    expect(state.chainDown).toBeNull();
    expect(logs.map((l) => l.event)).toContain("chain_available");
    expect(loadPlan()!.taken).toBeGreaterThanOrEqual(3); // the instants at 0 to 24 h were all still due
    expect(rows(mint, T0, T0 + 48 * HOUR)).toBe(1);
  });
});

describe.if(await validatorUp())("the claim gate after a sampling outage (live validator: the claim step reads the chain)", () => {
  const holderWallet = key();

  /** A launched coin and a draft epoch at the end of a 6-hour window whose samples the test takes itself. */
  function setup() {
    const mint = launch();
    const epochId = `epoch-retry-${crypto.randomUUID()}`;
    db.upsertEpoch({ id: epochId, at: iso(T0 + 6 * HOUR), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
    const claimed: string[] = [];
    const deps: ClaimDeps = {
      claimCoin: async (_e, coin) => (coin.mint === mint ? (claimed.push(coin.mint), 500n) : 0n),
      currentHolders: async () => [{ wallet: holderWallet, balance: 100n }],
    };
    return { mint, epochId, claimed, deps, cleanup: () => db.deleteDraftEpoch(epochId) };
  }

  test("every sample of the window failed: the coin is not claimed (never on fewer samples than the minimum); with 3 real samples it is", async () => {
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 3;
    const s = setup();
    ensurePlan(T0, T0 + 6 * HOUR, 6, firstMs);
    const failing: HolderReader = async () => {
      throw down();
    };
    for (let i = 0; i < 3; i++) await expect(takeDueSamples(T0 + i * HOUR + 1_000, loadPlan()!, failing)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(rows(s.mint, T0, T0 + 6 * HOUR)).toBe(0);
    await claimRemainingCoins(s.epochId, s.deps);
    expect(s.claimed).toEqual([]);
    expect(db.listEpochCoinHarvests(s.epochId).some((h) => h.mint === s.mint)).toBe(false); // left for a later window, not recorded as done

    const reader: HolderReader = async () => [{ wallet: holderWallet, balance: 100n }];
    for (const i of [3, 4, 5]) await takeDueSamples(T0 + i * HOUR + 1_000, loadPlan()!, reader); // the instants at 0 to 3 h were still due at the first: one row, then one each
    expect(rows(s.mint, T0, T0 + 6 * HOUR)).toBe(3);
    await claimRemainingCoins(s.epochId, s.deps);
    expect(s.claimed).toEqual([s.mint]);
    s.cleanup();
  });
});
