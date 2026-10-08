// The keeper loop (plan 4/4b): epochs on a cadence, the shielded batch weekly, the kill switch, samples while
// paused, errors that never kill the loop. Fake clock and fake runEpoch; the DB is the shared test DB, so every
// test works in its own stretch of the year 2095 (the cycle start is pinned with the "found nothing" marker).
import { afterEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import * as db from "../src/db";
import type { EpochOutcome } from "../src/epoch/engine";
import { planPayouts } from "../src/epoch/engine";
import { getTreasuryView } from "../src/ledger";
import { clearStopRequest, requestStop } from "../src/pause";
import type { FaucetReading } from "../src/faucet";
import { FAUCET_ALERT_KIND, KEEPER_SOL_ALERT_KIND, SCHEDULER_NOOP_META, keeperTick, newSchedulerState, nextEpochDueMs, runKeeperLoop, shieldedDue, type SchedulerDeps } from "../src/scheduler";
import { devtoolPresent } from "./helpers/validator-up";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2095-03-01T00:00:00Z");
const cadence = { epochEveryMs: 48 * HOUR, shieldedEveryMs: 7 * DAY, tickMs: 60_000, resumeEveryMs: 15 * 60_000, firstEpochAt: null };

function fakeDeps(over: Partial<SchedulerDeps> & { clock: { now: number } }) {
  const calls = { runs: [] as { includeShielded: boolean }[], samples: [] as number[], logs: [] as Record<string, unknown>[] };
  const deps: SchedulerDeps = {
    nowMs: () => over.clock.now,
    runEpoch: async (o) => {
      calls.runs.push(o);
      return { epoch: null };
    },
    takeDueSamples: async (now, plan) => {
      calls.samples.push(plan.times.filter((t) => t <= now).length - plan.taken);
      return 0;
    },
    log: (e) => calls.logs.push(e),
    ...over,
  };
  return { deps, calls };
}

/** What runEpoch does to the DB when it creates an epoch: a row at `now`, with the shielded flag it was asked for. */
function recordEpoch(now: number, includeShielded: boolean): EpochOutcome {
  const id = `epoch-sched-${now}-${crypto.randomUUID().slice(0, 6)}`;
  db.upsertEpoch({ id, at: new Date(now).toISOString(), coinMints: "[]", harvestedZats: "1", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]", includeShielded: includeShielded ? 1 : 0 });
  return { epoch: db.getEpoch(id)! };
}

const pin = (startMs: number) => db.setMeta(SCHEDULER_NOOP_META, new Date(startMs).toISOString());
afterEach(() => {
  delete process.env.PAYOUTS_PAUSED;
  clearStopRequest();
  db.getDb().query("DELETE FROM epochs WHERE id LIKE 'epoch-sched-%'").run();
  db.getDb().query("DELETE FROM payouts WHERE epochId LIKE 'epoch-sched-%'").run();
  db.getDb().query("DELETE FROM meta WHERE key = ?").run(SCHEDULER_NOOP_META);
});

describe("cadence", () => {
  test.if(devtoolPresent())("nothing runs before the epoch is due; the next due time is published for GET /treasury (reads the treasury wallet)", async () => {
    pin(T0);
    const clock = { now: T0 + 47 * HOUR };
    const { deps, calls } = fakeDeps({ clock });
    const r = await keeperTick(deps, newSchedulerState(), cadence);
    expect(r.action).toBe("idle");
    expect(calls.runs).toEqual([]);
    expect(r.nextEpochAt).toBe(new Date(T0 + 48 * HOUR).toISOString());
    expect((await getTreasuryView()).nextEpochAt).toBe(r.nextEpochAt);
  });

  test("due: one run, then the next due time is a cadence after the epoch it made", async () => {
    pin(T0);
    const clock = { now: T0 + 48 * HOUR };
    const { deps, calls } = fakeDeps({ clock, runEpoch: async (o) => { calls.runs.push(o); return recordEpoch(clock.now, o.includeShielded); } });
    const r = await keeperTick(deps, newSchedulerState(), cadence);
    expect(r.action).toBe("epoch");
    expect(calls.runs.length).toBe(1);
    clock.now += 60_000;
    expect((await keeperTick(deps, newSchedulerState(), cadence)).nextEpochAt).toBe(new Date(T0 + 96 * HOUR).toISOString());
  });

  test("an epoch every 2 days; the shielded leg only when the last shielded epoch is a week old", async () => {
    pin(T0);
    const clock = { now: T0 };
    const flags: [number, boolean][] = [];
    const { deps } = fakeDeps({
      clock,
      runEpoch: async (o) => {
        flags.push([Math.round((clock.now - T0) / DAY), o.includeShielded]);
        return recordEpoch(clock.now, o.includeShielded);
      },
    });
    const state = newSchedulerState();
    for (; clock.now <= T0 + 20 * DAY; clock.now += HOUR) await keeperTick(deps, state, { ...cadence, resumeEveryMs: 0 });
    expect(flags).toEqual([[2, true], [4, false], [6, false], [8, false], [10, true], [12, false], [14, false], [16, false], [18, true], [20, false]]);
  });

  test("the first epoch can be pinned to an instant", () => {
    db.getDb().query("DELETE FROM meta WHERE key = ?").run(SCHEDULER_NOOP_META);
    const first = new Date(T0 + 3 * DAY).toISOString();
    const fresh = db.listEpochs().length === 0;
    if (fresh) expect(nextEpochDueMs(T0, { ...cadence, firstEpochAt: first })).toBe(T0 + 3 * DAY);
    else expect(nextEpochDueMs(T0, { ...cadence, firstEpochAt: first })).toBe(T0 + 48 * HOUR); // an epoch exists: the cadence takes over
  });

  test("defaults are plan 4b's: Solana every 2 days, shielded weekly", () => {
    expect(config.scheduler.epochEveryMs).toBe(48 * HOUR);
    expect(config.scheduler.shieldedEveryMs).toBe(7 * DAY);
    expect(shieldedDue(T0, cadence)).toBe(db.lastShieldedEpochAt() === null || T0 - Date.parse(db.lastShieldedEpochAt()!) >= 7 * DAY);
  });
});

describe("kill switch", () => {
  test("paused: no run, but the due samples are still taken; resuming is logged and runs", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    const { deps, calls } = fakeDeps({ clock });
    const state = newSchedulerState();
    process.env.PAYOUTS_PAUSED = "1";
    const r = await keeperTick(deps, state, cadence);
    expect(r.action).toBe("paused");
    expect(calls.runs).toEqual([]);
    expect(calls.samples.length).toBe(1);
    expect(calls.logs.at(-1)).toMatchObject({ event: "paused" });
    delete process.env.PAYOUTS_PAUSED;
    clock.now += 60_000;
    expect((await keeperTick(deps, state, cadence)).action).toBe("epoch");
    expect(calls.logs.some((l) => l.event === "resumed")).toBe(true);
    expect(calls.runs.length).toBe(1);
  });

  test("a stop request halts the tick the same way (graceful shutdown)", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    const { deps, calls } = fakeDeps({ clock });
    requestStop();
    expect((await keeperTick(deps, newSchedulerState(), cadence)).outcome).toBe("stop requested");
    expect(calls.runs).toEqual([]);
  });

  test("a run that comes back paused is reported as paused and does not end the cycle", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    const { deps } = fakeDeps({ clock, runEpoch: async () => ({ epoch: null, paused: "payouts are paused" }) });
    expect((await keeperTick(deps, newSchedulerState(), cadence)).action).toBe("paused");
    expect(db.getMeta(SCHEDULER_NOOP_META)).toBe(new Date(T0).toISOString());
  });
});

describe("failures and waiting", () => {
  test("an error is logged and the loop survives; the retry waits resumeEveryMs", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    let n = 0;
    const { deps, calls } = fakeDeps({ clock, runEpoch: async () => { n++; throw new Error("RPC down"); } });
    const state = newSchedulerState();
    const first = await keeperTick(deps, state, cadence);
    expect(first).toMatchObject({ action: "error", outcome: "RPC down" });
    clock.now += 60_000;
    expect((await keeperTick(deps, state, cadence)).action).toBe("idle"); // too soon
    clock.now += 15 * 60_000;
    expect((await keeperTick(deps, state, cadence)).action).toBe("error");
    expect(n).toBe(2);
    expect(calls.logs.filter((l) => l.event === "error").length).toBe(2);
  });

  test("a due run that finds nothing to claim ends the cycle; one that is waiting for an approval or halted does not", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    let outcome: EpochOutcome = { epoch: null, awaitingClaims: ["trading claim for X (await)"] };
    const { deps } = fakeDeps({ clock, runEpoch: async () => outcome });
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(db.getMeta(SCHEDULER_NOOP_META)).toBe(new Date(T0).toISOString());
    outcome = { epoch: null, halted: ["not isolated"] };
    clock.now += 16 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(db.getMeta(SCHEDULER_NOOP_META)).toBe(new Date(T0).toISOString());
    outcome = { epoch: null };
    clock.now += 16 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(db.getMeta(SCHEDULER_NOOP_META)).toBe(new Date(clock.now).toISOString());
  });

  test("a sampling error does not stop the run", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    const { deps, calls } = fakeDeps({ clock, takeDueSamples: async () => { throw new Error("rpc"); } });
    expect((await keeperTick(deps, newSchedulerState(), cadence)).action).toBe("epoch");
    expect(calls.logs.some((l) => l.event === "sample_error")).toBe(true);
  });
});

describe("the loop", () => {
  test("--once runs one tick; otherwise it ticks until told to stop, and stops without sleeping again", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    const { deps } = fakeDeps({ clock });
    let stop = false;
    let sleeps = 0;
    const opts = { tickMs: 1, once: false, shouldStop: () => stop, sleep: async () => { sleeps++; if (sleeps === 3) stop = true; } };
    expect(await runKeeperLoop(deps, opts, newSchedulerState())).toBe(3);
    expect(await runKeeperLoop(deps, { ...opts, once: true, shouldStop: () => false }, newSchedulerState())).toBe(1);
  });
});

describe("a Solana-only epoch carries opted-in shares for the weekly shielded batch (plan 4b)", () => {
  test("includeShielded=false plans no shielded row and parks the share as carry; the next shielded epoch pays it", () => {
    const solana = Keypair.generate().publicKey.toBase58();
    const shielded = Keypair.generate().publicKey.toBase58();
    const addr = new Map([[shielded, "u1" + "q".repeat(60)]]);
    const first = `epoch-sched-plan-${crypto.randomUUID()}`;
    planPayouts(first, new Map([[solana, 400_000n], [shielded, 700_000n]]), new Set([shielded]), addr, new Set(), false);
    // (every wallet with carry from other tests is planned too, S2-07: look at ours)
    expect(db.getPayouts(first).filter((p) => [solana, shielded].includes(p.wallet)).map((p) => [p.wallet, p.kind])).toEqual([[solana, "solana"]]);
    expect(db.getPayouts(first).some((p) => p.kind === "shielded")).toBe(false);
    expect(db.getCarry(shielded, "shielded")).toBe(700_000n);
    const second = `epoch-sched-plan-${crypto.randomUUID()}`;
    planPayouts(second, new Map([[shielded, 500_000n]]), new Set([shielded]), addr, new Set(), true);
    const row = db.getPayouts(second).find((p) => p.wallet === shielded)!;
    expect(row.kind).toBe("shielded");
    expect(row.amountZats).toBe("1200000"); // the carry plus this epoch's share
    expect(db.getCarry(shielded, "shielded")).toBe(0n);
    db.setCarry(shielded, "shielded", 0n);
  });
});

describe("keeper wallet watch: the keeper warns before it is too dry to claim (devnet 2026-10-06: 21 hours of failed claims and no alert)", () => {
  const address = Keypair.generate().publicKey.toBase58();
  const solAlerts = () => db.listOpenAlerts().filter((a) => a.kind === KEEPER_SOL_ALERT_KIND);
  afterEach(() => {
    db.getDb().query("DELETE FROM alerts WHERE kind = ?").run(KEEPER_SOL_ALERT_KIND);
  });

  test("below the line: one keeper_sol_low line and one stored alert naming the wallet and its SOL; no second alert while it stays low", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let lamports = 867_280; // what the devnet keeper held on 2026-10-07
    const { deps, calls } = fakeDeps({ clock, readKeeperSol: async () => ({ address, lamports }), keeperLowLamports: 50_000_000 });
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(calls.logs.filter((l) => l.event === "keeper_sol_low")).toMatchObject([{ lamports: 867_280 }]);
    expect(solAlerts().length).toBe(1);
    expect(solAlerts()[0]!.message).toContain(address); // where to send SOL
    expect(solAlerts()[0]!.message).toContain("holds 0.0009 SOL");
    lamports = 500_000;
    clock.now += 11 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(calls.logs.filter((l) => l.event === "keeper_sol_low").length).toBe(1);
    expect(solAlerts().length).toBe(1);
  });

  test("exactly the line is not low; a top-up closes the alert, and running low again opens a new one", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let lamports = 50_000_000;
    const { deps, calls } = fakeDeps({ clock, readKeeperSol: async () => ({ address, lamports }), keeperLowLamports: 50_000_000 });
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(solAlerts()).toEqual([]);
    lamports = 1_000;
    clock.now += 11 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(solAlerts().length).toBe(1);
    lamports = 500_000_000;
    clock.now += 11 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(solAlerts()).toEqual([]);
    expect(db.getDb().query("SELECT resolvedAt FROM alerts WHERE kind = ?").get(KEEPER_SOL_ALERT_KIND)).toMatchObject({ resolvedAt: expect.any(String) });
    lamports = 2_000;
    clock.now += 11 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(solAlerts().length).toBe(1);
    expect(calls.logs.filter((l) => l.event === "keeper_sol_low").length).toBe(2);
  });

  test("read at most every 10 minutes; a failed read is logged as keeper_sol_error, raises nothing, and the loop goes on", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let reads = 0;
    let fail = true;
    const { deps, calls } = fakeDeps({ clock, readKeeperSol: async () => { reads++; if (fail) throw new Error("rpc down"); return { address, lamports: 1 }; }, keeperLowLamports: 50_000_000 });
    const state = newSchedulerState();
    expect((await keeperTick(deps, state, cadence)).action).toBe("idle");
    expect(calls.logs.filter((l) => l.event === "keeper_sol_error")).toMatchObject([{ error: "rpc down" }]);
    expect(solAlerts()).toEqual([]);
    fail = false;
    clock.now += 9 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(reads).toBe(1);
    clock.now += 2 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(reads).toBe(2);
    expect(solAlerts().length).toBe(1);
  });
});

describe("faucet watch (devnet): the keeper warns while judges can still get test money", () => {
  const address = Keypair.generate().publicKey.toBase58();
  const reading = (fillsLeft: number): FaucetReading => ({ available: fillsLeft >= 1, fillsLeft, address, lamports: 59_000_000 });
  const faucetAlerts = () => db.listOpenAlerts().filter((a) => a.kind === FAUCET_ALERT_KIND);
  afterEach(() => {
    db.getDb().query("DELETE FROM alerts WHERE kind = ?").run(FAUCET_ALERT_KIND);
  });

  test("fewer than 10 fills left: one faucet_low health line and one stored alert; every line carries the count; no second alert while it stays low", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let fills = 9;
    const { deps, calls } = fakeDeps({ clock, readFaucet: async () => reading(fills) });
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(calls.logs.filter((l) => l.event === "faucet_low")).toMatchObject([{ fillsLeft: 9 }]);
    expect(faucetAlerts().length).toBe(1);
    expect(faucetAlerts()[0]!.message).toContain("9 test-money fills left");
    expect(faucetAlerts()[0]!.message).toContain(address); // where to send the refill
    expect(calls.logs.at(-1)).toMatchObject({ event: "idle", faucetFillsLeft: 9 }); // the heartbeat of the same tick
    expect(calls.logs.at(-1)!.openAlerts).toBeGreaterThanOrEqual(1);

    fills = 3;
    clock.now += 6 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(state.faucetFillsLeft).toBe(3);
    expect(calls.logs.filter((l) => l.event === "faucet_low").length).toBe(1);
    expect(faucetAlerts().length).toBe(1);
  });

  test("exactly 10 fills left is not low: the count is logged, nothing is raised", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    const { deps, calls } = fakeDeps({ clock, readFaucet: async () => reading(10) });
    await keeperTick(deps, newSchedulerState(), cadence);
    expect(calls.logs.some((l) => l.event === "faucet_low")).toBe(false);
    expect(faucetAlerts()).toEqual([]);
    expect(calls.logs.at(-1)).toMatchObject({ faucetFillsLeft: 10 });
  });

  test("a refill closes the alert, and running low again opens a new one", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let fills = 4;
    const { deps, calls } = fakeDeps({ clock, readFaucet: async () => reading(fills) });
    const state = newSchedulerState();
    await keeperTick(deps, state, cadence);
    expect(faucetAlerts().length).toBe(1);
    fills = 60;
    clock.now += 6 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(faucetAlerts()).toEqual([]);
    expect(db.getDb().query("SELECT resolvedAt FROM alerts WHERE kind = ?").get(FAUCET_ALERT_KIND)).toMatchObject({ resolvedAt: expect.any(String) });
    fills = 2;
    clock.now += 6 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(faucetAlerts().length).toBe(1);
    expect(calls.logs.filter((l) => l.event === "faucet_low").length).toBe(2);
  });

  test("a failed read is logged as faucet_error and raises nothing; the loop goes on and the read is tried again after 5 minutes", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let reads = 0;
    let fail = true;
    const { deps, calls } = fakeDeps({ clock, readFaucet: async () => { reads++; if (fail) throw new Error("rpc down"); return reading(50); } });
    const state = newSchedulerState();
    expect((await keeperTick(deps, state, cadence)).action).toBe("idle");
    expect(calls.logs.filter((l) => l.event === "faucet_error")).toMatchObject([{ error: "rpc down" }]);
    expect(faucetAlerts()).toEqual([]);
    expect("faucetFillsLeft" in calls.logs.at(-1)!).toBe(false); // no stale number
    clock.now += 60_000;
    await keeperTick(deps, state, cadence);
    expect(reads).toBe(1);
    fail = false;
    clock.now += 5 * 60_000;
    await keeperTick(deps, state, cadence);
    expect(reads).toBe(2);
    expect(state.faucetFillsLeft).toBe(50);
  });

  test("the balance is read at most every 5 minutes, not every tick", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    let reads = 0;
    const { deps } = fakeDeps({ clock, readFaucet: async () => { reads++; return reading(50); } });
    const state = newSchedulerState();
    for (let minute = 0; minute <= 10; minute++) {
      await keeperTick(deps, state, cadence);
      clock.now += 60_000;
    }
    expect(reads).toBe(3); // minutes 0, 5 and 10
  });

  test("without a faucet (no watch wired, or readFaucet says null) nothing is read, raised or added to the health lines", async () => {
    pin(T0);
    const clock = { now: T0 + HOUR };
    const none = fakeDeps({ clock });
    await keeperTick(none.deps, newSchedulerState(), cadence);
    expect("faucetFillsLeft" in none.calls.logs.at(-1)!).toBe(false);
    const nullReading = fakeDeps({ clock, readFaucet: async () => null });
    await keeperTick(nullReading.deps, newSchedulerState(), cadence);
    expect("faucetFillsLeft" in nullReading.calls.logs.at(-1)!).toBe(false);
    expect(faucetAlerts()).toEqual([]);
  });

  test("a paused keeper still watches the faucet (it only reads)", async () => {
    pin(T0);
    const clock = { now: T0 + 50 * HOUR };
    const { deps, calls } = fakeDeps({ clock, readFaucet: async () => reading(1) });
    process.env.PAYOUTS_PAUSED = "1";
    expect((await keeperTick(deps, newSchedulerState(), cadence)).action).toBe("paused");
    expect(calls.logs.some((l) => l.event === "faucet_low")).toBe(true);
    expect(faucetAlerts().length).toBe(1);
  });
});
