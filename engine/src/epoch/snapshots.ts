// Holder snapshots against sniping (audit O-1). A reward weight read at one predictable moment can be bought
// just before it and sold just after it. Instead the keeper takes N samples at random times inside the epoch
// window (one random instant inside each of N equal slices, from the OS CSPRNG), the epoch run adds one more
// at claim time, and a holder's weight is the MINIMUM balance it showed across all of them. A holder that was
// absent from any sample weighs nothing.
//
// Why the minimum and not a time-weighted average: the samples are sparse, so a time-weighted figure needs an
// assumption about what happened between them (an attacker picks the assumption that favors it), and it would
// pay a partial share for a short stay. The minimum needs no assumption: it is the least the holder provably
// held at N instants it could not predict. The price is stated, not hidden: a wallet that buys in the middle
// of a window earns nothing for that window (it is paid in full from the next), and one that sells part of its
// stack is paid on what it kept. Stratifying (one instant per slice) bounds the gap between samples, so the
// shortest stay that is seen by every sample is nearly the whole window, which an attacker's 2% round trip
// cannot pay for.
//
// A sample whose chain reads failed is NOT a taken sample (S4-02). A read that fails because the chain cannot be reached (an RPC 429, a timeout, the RPC
// guard's open breaker: src/rpcGuard.ts) leaves its instant due for that coin and tells the keeper, which backs off and tries again; an instant is
// spent only for the coins that were read. Otherwise an outage that lands on the instants of a window leaves the window under-sampled with nothing
// said, and on mainnet (PAD_SNAPSHOT_MIN_SAMPLES 3 of 6) the coin is not claimed that epoch. The retry is bounded by the window: once it has ended the
// keeper no longer waits for a sample (the epoch must run), and a coin that still holds fewer samples than the claim gate wants raises an alert.
import { randomInt } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import * as db from "../db";
import { recordedExcludedOwners, snapshotHolders, type Holder } from "../holders";
import { isChainUnavailable } from "../rpcGuard";

export type RandomInt = (min: number, max: number) => number;

/**
 * `count` sample times in [startMs, endMs): one uniformly random millisecond inside each of `count` equal slices,
 * ascending. `rand(min, max)` returns an integer in [min, max); the default is the OS CSPRNG (node:crypto).
 */
export function drawSnapshotTimes(startMs: number, endMs: number, count: number, rand: RandomInt = randomInt): number[] {
  const slice = Math.floor((endMs - startMs) / count);
  if (!(count >= 1) || slice < 1) throw new Error(`cannot place ${count} samples in a window of ${endMs - startMs} ms`);
  return Array.from({ length: count }, (_, i) => startMs + i * slice + rand(0, slice));
}

/**
 * The reward weights: per wallet the least balance across every sample, dropping a wallet missing from any
 * sample and every owner in `exclude` (the exclusion set at epoch time, which may be newer than the samples).
 * Pure. No samples means no holders.
 */
export function minimumBalanceHolders(samples: Holder[][], exclude: ReadonlySet<string> = new Set()): Holder[] {
  if (samples.length === 0) return [];
  const least = new Map<string, bigint>();
  const seen = new Map<string, number>();
  for (const sample of samples) {
    for (const h of sample) {
      const prior = least.get(h.wallet);
      least.set(h.wallet, prior === undefined || h.balance < prior ? h.balance : prior);
      seen.set(h.wallet, (seen.get(h.wallet) ?? 0) + 1);
    }
  }
  return [...least.entries()]
    .filter(([wallet, balance]) => seen.get(wallet) === samples.length && balance > 0n && !exclude.has(wallet))
    .map(([wallet, balance]) => ({ wallet, balance }));
}

// ---- the plan: which instants of the current window are still to be sampled ----

export interface SnapshotPlan {
  windowStartMs: number;
  windowEndMs: number;
  /** Planned instants, ascending. */
  times: number[];
  /** How many of `times` (from the front) have been taken. */
  taken: number;
  /** Coins whose last pass could not read them, by mint: how many instants each still owes (S4-02). A coin that owes nothing is absent; plans stored before S4-02 have none. */
  owed?: Record<string, number>;
}

export type HolderReader = (mint: string) => Promise<Holder[]>;

/** The stored alert kind (keyed by mint) raised when a window ends with a coin short of the samples the claim gate wants because its reads kept failing. */
export const SAMPLES_SHORT_ALERT = "holder_samples_short";

const PLAN_META = "snapshot_plan";

export function loadPlan(): SnapshotPlan | null {
  const raw = db.getMeta(PLAN_META);
  return raw ? (JSON.parse(raw) as SnapshotPlan) : null;
}

/** The plan for this window: kept if it is for the same window, drawn fresh otherwise (and persisted, so a restart does not redraw). */
export function ensurePlan(windowStartMs: number, windowEndMs: number, count: number, rand: RandomInt = randomInt): SnapshotPlan {
  const existing = loadPlan();
  if (existing && existing.windowStartMs === windowStartMs && existing.windowEndMs === windowEndMs && existing.times.length === count) return existing;
  const plan: SnapshotPlan = { windowStartMs, windowEndMs, times: drawSnapshotTimes(windowStartMs, windowEndMs, count, rand), taken: 0 };
  db.setMeta(PLAN_META, JSON.stringify(plan));
  return plan;
}

/** What one pass over some coins found. */
interface Pass {
  /** Read and stored. */
  read: string[];
  /** Left unread because the chain could not be read: still owed. */
  unread: string[];
  /** Failed for a reason particular to the coin (logged): not retried, as before. */
  skipped: string[];
  /** The first chain failure of the pass, if any. */
  chainError: unknown;
}

/** Reads each of `mints` and stores its holders at `at`. Never throws: what happened to each coin is in the result. */
async function samplePass(at: string, mints: string[], readHolders: HolderReader): Promise<Pass> {
  const pass: Pass = { read: [], unread: [], skipped: [], chainError: null };
  for (const mint of mints) {
    try {
      db.insertHolderSample(mint, at, await readHolders(mint));
      pass.read.push(mint);
    } catch (err) {
      if (isChainUnavailable(err)) {
        pass.unread.push(mint);
        pass.chainError ??= err;
      } else {
        console.error(`holder sample for ${mint} failed, skipped: ${(err as Error)?.message ?? err}`);
        pass.skipped.push(mint);
      }
    }
  }
  return pass;
}

const launchedMints = (): string[] => db.listCoins().filter((c) => c.status === "launched").map((c) => c.mint);
const pruneOldSamples = (nowMs: number): void => db.pruneHolderSamples(new Date(nowMs - 30 * 24 * 3_600_000).toISOString());

/**
 * Samples every launched coin right now and stores the result at `nowMs`; returns how many were stored. A coin that fails for a reason of its own is
 * skipped (logged). When the chain cannot be read the coins that were read are still stored, then the chain failure is thrown: the caller must not count
 * the sample as taken.
 */
export async function takeSamplesNow(nowMs: number, readHolders: HolderReader = snapshotOne): Promise<number> {
  const pass = await samplePass(new Date(nowMs).toISOString(), launchedMints(), readHolders);
  pruneOldSamples(nowMs);
  if (pass.chainError) throw pass.chainError;
  return pass.read.length;
}

/**
 * Takes the samples that are due at `nowMs`, and retries what an earlier pass could not read. Several instants due at once (the keeper was down) are
 * one observation at `nowMs`, stored once per coin: duplicates would only inflate the count the gate (minWindowSamples) reads. An instant is spent for a
 * coin only when the coin was read (or failed for a reason of its own); a pass that read nothing because the chain could not be read spends nothing,
 * stores nothing and throws, so the keeper backs off and the same instants are due at its next try (S4-02). The throw stops once the window has ended
 * (`plan.windowEndMs`): the epoch must go ahead, and the claim gate decides what a short window earns. Returns the number of instants consumed.
 */
export async function takeDueSamples(nowMs: number, plan: SnapshotPlan, readHolders: HolderReader = snapshotOne): Promise<number> {
  const due = plan.times.slice(plan.taken).filter((t) => t <= nowMs).length;
  const owed = plan.owed ?? {};
  const mints = launchedMints().filter((m) => due + (owed[m] ?? 0) > 0);
  if (due === 0 && mints.length === 0) return 0;
  const pass = await samplePass(new Date(nowMs).toISOString(), mints, readHolders);
  pruneOldSamples(nowMs);
  const nothingRead = pass.read.length + pass.skipped.length === 0 && pass.unread.length > 0;
  if (!nothingRead) {
    const stillOwed = Object.fromEntries(pass.unread.map((m) => [m, due + (owed[m] ?? 0)]));
    db.setMeta(PLAN_META, JSON.stringify({ ...plan, taken: plan.taken + due, owed: stillOwed }));
    for (const mint of pass.read) db.resolveAlerts(SAMPLES_SHORT_ALERT, mint);
  }
  if (pass.chainError && nowMs < plan.windowEndMs) throw pass.chainError;
  if (pass.unread.length > 0) alertShortWindows(pass.unread, plan, nowMs);
  return nothingRead ? 0 : due;
}

/** The window is over and these coins could not be read: the ones now holding fewer samples than the claim gate wants are not claimed this epoch. Said once, where the owner looks. */
function alertShortWindows(mints: string[], plan: SnapshotPlan, nowMs: number): void {
  const wanted = config.epoch.snapshots.minWindowSamples;
  for (const mint of mints) {
    const held = db.listHolderSamples(mint, new Date(plan.windowStartMs).toISOString(), new Date(nowMs).toISOString()).length;
    if (held >= wanted) continue;
    const detail = `holder samples of ${mint} could not be read (the chain did not answer): ${held} in the window that ended ${new Date(plan.windowEndMs).toISOString()}, ${wanted} wanted, so its fees are not claimed this epoch and wait in the pool for a later window; resolved by its next sample`;
    if (db.recordAlert(SAMPLES_SHORT_ALERT, mint, detail)) console.error(`ALERT ${detail}`);
  }
}

function snapshotOne(mint: string): Promise<Holder[]> {
  return snapshotHolders({ mint: new PublicKey(mint), excludeOwners: recordedExcludedOwners(), minBalance: config.epoch.minHolderBalanceRaw });
}

export { snapshotOne as readCurrentHolders };
