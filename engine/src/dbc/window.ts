// The launch window as a fact of a coin and as a live number docs/API.md v2.8. A config carries the DBC base-fee scheduler: a fee that starts
// at 99% in the pool's first second and steps down to the tier's fee (dbc/reviewed.ts REVIEWED_WINDOW). What it charges at any moment is the SDK's own
// `getBaseFeeNumerator` over the config's scheduler fields, the chain's current point and the pool's activation point: the same arithmetic the program
// runs, so `feeNowBps` is the fee a trade landing now pays. Read-only: no signing, no keeper key (INV-17); the API imports it.
//
// The chain's current point is the block time of the newest slot, which can only be at or behind the clock a transaction will land under. So a window
// that reads "closed" here is closed for every transaction sent afterwards, and one that reads "open" may have closed a second or two ago: a countdown
// built on these numbers errs toward waiting, never toward paying the 99%.
import type { PublicKey } from "@solana/web3.js";
import {
  ActivationType, BaseFeeMode, feeNumeratorToBps, getBaseFeeNumerator, getFeeSchedulerMinBaseFeeNumerator, type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import type { CoinRow } from "../db";
import { getDbcClient } from "../solana";

/** What a coin's page and the API say about the window it launched with (contract v2.8). Times are ISO UTC. */
export interface LaunchWindow {
  /** The fee in the pool's first period, in bps. */
  cliffBps: number;
  /** The fee after the window, in bps: the coin's tier. */
  endBps: number;
  periods: number;
  periodSeconds: number;
  /** The pool's activation point: the second the launch transaction landed in. */
  startsAt: string;
  /** startsAt + periods x periodSeconds: from this second on every trade pays `endBps`. */
  endsAt: string;
}

/** A config's base-fee scheduler as the chain stores it. A config's account never changes, so this is read once and kept. */
export interface ConfigSchedule {
  cliffNumerator: BN;
  periods: number;
  periodSeconds: BN;
  reductionFactor: BN;
  mode: BaseFeeMode;
  activationType: ActivationType;
  /** `enable_first_swap_with_min_fee`: the launcher's own first buy, inside the launch transaction, pays the fee after the window. */
  firstSwapAtEndFee: boolean;
}

export function scheduleOfState(state: PoolConfig): ConfigSchedule {
  const b = state.poolFees.baseFee;
  return {
    cliffNumerator: new BN(b.cliffFeeNumerator.toString()),
    periods: b.firstFactor,
    periodSeconds: new BN(b.secondFactor.toString()),
    reductionFactor: new BN(b.thirdFactor.toString()),
    mode: b.baseFeeMode,
    activationType: state.activationType,
    firstSwapAtEndFee: Number(state.enableFirstSwapWithMinFee) !== 0,
  };
}

/** True when the config steps its fee down over time (a flat-fee config, made before the launch window, has no steps) and counts that time in seconds. */
export function hasWindow(s: ConfigSchedule): boolean {
  return s.periods > 0 && !s.periodSeconds.isZero() && !s.reductionFactor.isZero() && s.activationType === ActivationType.Timestamp;
}

/** The fee numerator (out of 1e9) a trade landing at `currentPoint` pays on a pool activated at `activationPoint`. The SDK's own helper; time before the activation counts as 0. */
export function feeNumeratorAt(s: ConfigSchedule, activationPoint: BN, currentPoint: BN): bigint {
  const point = BN.max(currentPoint, activationPoint);
  return BigInt(getBaseFeeNumerator(s.cliffNumerator, s.periods, s.periodSeconds, s.reductionFactor, s.mode, point, activationPoint).toString());
}

/** The same fee in whole bps (rounded: a reviewed config's fees are all whole bps, so nothing is lost). */
export function feeBpsAt(s: ConfigSchedule, activationPoint: BN, currentPoint: BN): number {
  return Math.round(feeNumeratorToBps(new BN(feeNumeratorAt(s, activationPoint, currentPoint).toString())));
}

/** The fee a config charges once its window has closed (the scheduler's minimum; a flat config's only fee), in whole bps: the coin's tier. */
export function endFeeBps(s: ConfigSchedule): number {
  return Math.round(feeNumeratorToBps(getFeeSchedulerMinBaseFeeNumerator(s.cliffNumerator, s.periods, s.reductionFactor, s.mode)));
}

/** The window a pool launched with, or null for a config with no steps. `endBps` is the fee the scheduler ends on, read from the config itself (its minimum). */
export function launchWindowOf(s: ConfigSchedule, activationPoint: BN): LaunchWindow | null {
  if (!hasWindow(s)) return null;
  const startsSec = BigInt(activationPoint.toString());
  const endsSec = startsSec + BigInt(s.periods) * BigInt(s.periodSeconds.toString());
  return {
    cliffBps: Math.round(feeNumeratorToBps(s.cliffNumerator)),
    endBps: endFeeBps(s),
    periods: s.periods,
    periodSeconds: Number(s.periodSeconds.toString()),
    startsAt: new Date(Number(startsSec) * 1000).toISOString(),
    endsAt: new Date(Number(endsSec) * 1000).toISOString(),
  };
}

/** Whole seconds until the window closes at `currentPoint` (unix seconds): 0 once it has, and 0 for a coin that launched with no window. */
export function windowSecondsLeft(w: Pick<LaunchWindow, "endsAt"> | null, currentPoint: BN): number {
  if (!w) return 0;
  const left = Math.floor(Date.parse(w.endsAt) / 1000) - Number(currentPoint.toString());
  return left > 0 ? left : 0;
}

/** A schedule as a coin's row stores it (contract v2.8.1): the big numbers as decimal strings. */
interface StoredSchedule {
  cliffNumerator: string;
  periods: number;
  periodSeconds: string;
  reductionFactor: string;
  mode: number;
  activationType: number;
  firstSwapAtEndFee: boolean;
}

export function scheduleToJson(s: ConfigSchedule): string {
  const stored: StoredSchedule = {
    cliffNumerator: s.cliffNumerator.toString(), periods: s.periods, periodSeconds: s.periodSeconds.toString(), reductionFactor: s.reductionFactor.toString(),
    mode: s.mode, activationType: s.activationType, firstSwapAtEndFee: s.firstSwapAtEndFee,
  };
  return JSON.stringify(stored);
}

const DIGITS = /^[0-9]+$/;
const isDigits = (v: unknown): v is string => typeof v === "string" && DIGITS.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The schedule a coin's row stored, or null when there is none or the text is not one scheduleToJson wrote. Never throws. */
export function scheduleFromJson(text: string | null | undefined): ConfigSchedule | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const s = parsed as Partial<Record<keyof StoredSchedule, unknown>>;
  if (!isDigits(s.cliffNumerator) || !isDigits(s.periodSeconds) || !isDigits(s.reductionFactor)) return null;
  if (!isCount(s.periods) || !isCount(s.mode) || !isCount(s.activationType)) return null;
  return {
    cliffNumerator: new BN(s.cliffNumerator), periods: s.periods, periodSeconds: new BN(s.periodSeconds), reductionFactor: new BN(s.reductionFactor),
    mode: s.mode as BaseFeeMode, activationType: s.activationType as ActivationType, firstSwapAtEndFee: s.firstSwapAtEndFee === true,
  };
}

/** A coin's window facts from its own row (contract v2.8.1): its config's schedule (stored at launch) and its pool's activation point (stored at confirm). null until both are. */
export function storedWindowOf(coin: Pick<CoinRow, "feeSchedule" | "activationPoint">): { schedule: ConfigSchedule; activation: BN } | null {
  const schedule = scheduleFromJson(coin.feeSchedule);
  if (!schedule || !isDigits(coin.activationPoint)) return null;
  return { schedule, activation: new BN(coin.activationPoint) };
}

/**
 * The server's clock is read this many seconds back. The program charges by the chain's clock, which can trail the server's; reading one second back errs toward the
 * higher fee and the longer wait, never toward letting a buyer into a step it did not see (the same second the countdown has always added when the chain was unreadable).
 */
export const CLOCK_MARGIN_SECONDS = 1;

/**
 * The fee a trade pays now and the whole seconds the window has left, from a schedule and an activation point and this server's clock: no RPC call (contract v2.8.1).
 * A flat config charges its one fee; a stepped config that does not count in seconds cannot be read off a clock, so its fee is null.
 */
export function windowNowByClock(s: ConfigSchedule, activation: BN, nowMs: number): { feeNowBps: number | null; windowSecondsLeft: number } {
  if (s.periods === 0 || s.reductionFactor.isZero()) return { feeNowBps: endFeeBps(s), windowSecondsLeft: 0 };
  if (!hasWindow(s)) return { feeNowBps: null, windowSecondsLeft: 0 };
  const second = new BN(Math.floor(nowMs / 1000) - CLOCK_MARGIN_SECONDS);
  return { feeNowBps: feeBpsAt(s, activation, second), windowSecondsLeft: windowSecondsLeft(launchWindowOf(s, activation), second) };
}

const schedules = new Map<string, Promise<ConfigSchedule>>();

/**
 * The scheduler of the config `configId`, read from the chain once and kept for good (a config account is immutable). A failed read is not kept, so
 * the next request asks again.
 */
export function configScheduleOf(configId: PublicKey): Promise<ConfigSchedule> {
  const key = configId.toBase58();
  const hit = schedules.get(key);
  if (hit) return hit;
  const read = getDbcClient().state.getPoolConfig(configId).then((state) => {
    if (!state) throw new Error(`DBC config ${key} not found`);
    return scheduleOfState(state);
  });
  schedules.set(key, read);
  read.catch(() => {
    if (schedules.get(key) === read) schedules.delete(key);
  });
  return read;
}

/** For tests: forget every kept schedule. */
export function clearScheduleCache(): void {
  schedules.clear();
}
