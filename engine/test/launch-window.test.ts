// The launch window as a fact and as a live number (contract v2.8): what a config says, what a trade pays in each second, how long the window has left, and
// what GET /tiers promises before any coin exists. No chain: the scheduler fields are the ones the builder serializes, and the fee at each second is checked
// against hand arithmetic (cliff - period x reduction), never against the helper under test. test/launch-window-live.test.ts reads the same numbers off a chain.
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { ActivationType, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { handleRequest } from "../src/api";
import { buildConfigParams } from "../src/dbc/config";
import { liveFeeOf } from "../src/dbc/liveFee";
import { TIER_MENU_BPS, windowScheduleOf } from "../src/dbc/reviewed";
import { tierWindow, tradeSplit } from "../src/dbc/tiers";
import {
  endFeeBps, feeBpsAt, feeNumeratorAt, hasWindow, launchWindowOf, scheduleFromJson, scheduleOfState, scheduleToJson, storedWindowOf, windowSecondsLeft,
} from "../src/dbc/window";
import type { CoinRow } from "../src/db";

/** A config account as the chain would return it for tier `bps` (only the fields the window reads). `flat` = the config of before the window: a flat fee, no steps. */
function configOf(bps: number, flat = false): PoolConfig {
  const base = buildConfigParams(bps).poolFees.baseFee;
  const baseFee = flat ? { ...base, cliffFeeNumerator: new BN(bps * 100_000), firstFactor: 0, secondFactor: new BN(0), thirdFactor: new BN(0) } : base;
  return { poolFees: { baseFee }, activationType: ActivationType.Timestamp, enableFirstSwapWithMinFee: flat ? 0 : 1 } as unknown as PoolConfig;
}

const ACTIVATION = 1_791_163_393; // a real devnet pool's activation point (F-038)
const at = (second: number) => new BN(ACTIVATION + second);

describe("what a trade pays in each second of the window, by hand: cliff - period x reduction", () => {
  test.each([...TIER_MENU_BPS])("tier %i bps: 99%, then four equal steps down, then the tier's fee from second 5 for good", (bps) => {
    const s = scheduleOfState(configOf(bps));
    const cliff = 990_000_000n;
    const reduction = (cliff - BigInt(bps) * 100_000n) / 5n;
    for (const second of [0, 1, 2, 3, 4, 5, 6, 30, 3600, 86_400]) {
      const period = BigInt(Math.min(second, 5)); // 1 s periods, 5 of them
      expect(feeNumeratorAt(s, new BN(ACTIVATION), at(second))).toBe(cliff - period * reduction);
    }
    expect(feeBpsAt(s, new BN(ACTIVATION), at(0))).toBe(9900);
    expect(feeBpsAt(s, new BN(ACTIVATION), at(5))).toBe(bps);
    expect(endFeeBps(s)).toBe(bps);
  });

  test("the 1% tier, second by second: 99, 79.4, 59.8, 40.2, 20.6, 1", () => {
    const s = scheduleOfState(configOf(100));
    expect([0, 1, 2, 3, 4, 5, 6].map((sec) => feeBpsAt(s, new BN(ACTIVATION), at(sec)))).toEqual([9900, 7940, 5980, 4020, 2060, 100, 100]);
    expect(windowScheduleOf(100).feeByPeriodBps).toEqual([9900, 7940, 5980, 4020, 2060, 100]);
  });

  test("a clock that reads before the activation counts as second 0, never as a fee above the cliff", () => {
    const s = scheduleOfState(configOf(100));
    expect(feeBpsAt(s, new BN(ACTIVATION), at(-3))).toBe(9900);
    expect(feeNumeratorAt(s, new BN(ACTIVATION), new BN(0))).toBe(990_000_000n);
  });

  test("the fee in the first second is 99 times the 1% a trade pays after: the same amount costs 99x as much in the window as after it", () => {
    const amount = 100_000_000n;
    const inWindow = tradeSplit(amount, 100, feeNumeratorAt(scheduleOfState(configOf(100)), new BN(ACTIVATION), at(0)));
    const after = tradeSplit(amount, 100);
    expect([inWindow.fee, after.fee]).toEqual([99_000_000n, 1_000_000n]);
    // the shares of the fee do not move, only its size: Meteora 20%, the pad's claim the rest, split 12.5/87.5
    expect([inWindow.meteora, inWindow.partner, inWindow.holders, inWindow.team]).toEqual([19_800_000n, 79_200_000n, 9_900_000n, 69_300_000n]);
    // on a tier with a creator share the creator's part moves with it too: 2%, a 99,000,000 fee: Meteora 19,800,000, the creator half of the rest, the pad's claim the other half
    const two = tradeSplit(amount, 200, 990_000_000n);
    expect([two.fee, two.meteora, two.creator, two.partner]).toEqual([99_000_000n, 19_800_000n, 39_600_000n, 39_600_000n]);
  });
});

describe("the window as a fact of a coin", () => {
  test("cliff, end, steps, step length, and when it starts and ends (ISO UTC)", () => {
    const w = launchWindowOf(scheduleOfState(configOf(400)), new BN(ACTIVATION))!;
    expect(w).toEqual({
      cliffBps: 9900, endBps: 400, periods: 5, periodSeconds: 1,
      startsAt: new Date(ACTIVATION * 1000).toISOString(), endsAt: new Date((ACTIVATION + 5) * 1000).toISOString(),
    });
  });

  test("seconds left count down 5, 4, 3, 2, 1, 0 and stay 0; the window has ended exactly when the fee has reached the tier's", () => {
    const s = scheduleOfState(configOf(100));
    const w = launchWindowOf(s, new BN(ACTIVATION))!;
    expect([0, 1, 2, 3, 4, 5, 6, 100].map((sec) => windowSecondsLeft(w, at(sec)))).toEqual([5, 4, 3, 2, 1, 0, 0, 0]);
    for (const sec of [0, 1, 2, 3, 4, 5, 6]) expect(windowSecondsLeft(w, at(sec)) === 0).toBe(feeBpsAt(s, new BN(ACTIVATION), at(sec)) === 100);
  });

  test("a config made before the window (a flat fee) has no window: no steps, no countdown, its one fee from the first second", () => {
    const s = scheduleOfState(configOf(200, true));
    expect(hasWindow(s)).toBe(false);
    expect(launchWindowOf(s, new BN(ACTIVATION))).toBeNull();
    expect(windowSecondsLeft(null, at(0))).toBe(0);
    expect([0, 3, 60].map((sec) => feeBpsAt(s, new BN(ACTIVATION), at(sec)))).toEqual([200, 200, 200]);
    expect(endFeeBps(s)).toBe(200);
    expect(s.firstSwapAtEndFee).toBe(false);
  });

  test("a config that counts its steps in slots, not seconds, is not a window the page can count down in seconds", () => {
    const slotCounted = { ...configOf(100), activationType: ActivationType.Slot } as PoolConfig;
    expect(hasWindow(scheduleOfState(slotCounted))).toBe(false);
    expect(launchWindowOf(scheduleOfState(slotCounted), new BN(ACTIVATION))).toBeNull();
  });

  test("the window reads the first-buy exemption off the config", () => {
    expect(scheduleOfState(configOf(100)).firstSwapAtEndFee).toBe(true);
  });
});

describe("the live fee from the coin's own row and the server's clock, with no chain read (contract v2.8.1)", () => {
  const row = (over: Partial<CoinRow>): CoinRow => ({ mint: PublicKey.default.toBase58(), feeBps: 200, configId: "x", feeSchedule: null, activationPoint: null, ...over }) as CoinRow;
  /** What launch (the config's schedule) and confirm (the pool's activation point) store on the row. */
  const stored = (bps: number, flat = false) => ({ feeSchedule: scheduleToJson(scheduleOfState(configOf(bps, flat))), activationPoint: String(ACTIVATION) });
  const wall = (second: number, ms = 0) => (ACTIVATION + second) * 1000 + ms;

  test("a graduated coin has no curve fee to report, and no window", () => {
    expect(liveFeeOf(row(stored(100)), "graduated")).toEqual({ feeNowBps: null, windowSecondsLeft: 0 });
  });

  test("a coin with no recorded config reads as its tier's flat fee, with no window", () => {
    expect(liveFeeOf(row({ configId: null }), "curve")).toEqual({ feeNowBps: 200, windowSecondsLeft: 0 });
  });

  test("1% tier: the server's clock is read one second back, so each step shows a second late and the countdown a second longer, never a lower fee", () => {
    const coin = row({ feeBps: 100, ...stored(100) });
    const seconds = [0, 1, 2, 3, 4, 5, 6, 7]; // wall second k of the window reads as chain second k - 1
    expect(seconds.map((k) => liveFeeOf(coin, "curve", wall(k, 500)).feeNowBps)).toEqual([9900, 9900, 7940, 5980, 4020, 2060, 100, 100]);
    expect(seconds.map((k) => liveFeeOf(coin, "curve", wall(k, 500)).windowSecondsLeft)).toEqual([6, 5, 4, 3, 2, 1, 0, 0]);
    // the window reads closed exactly when the fee has reached the tier's, and two seconds in there are four to go (what the old wall-clock fallback said too)
    for (const k of seconds) expect(liveFeeOf(coin, "curve", wall(k)).windowSecondsLeft === 0).toBe(liveFeeOf(coin, "curve", wall(k)).feeNowBps === 100);
    expect(liveFeeOf(coin, "curve", wall(2)).windowSecondsLeft).toBe(4);
  });

  test("a flat-fee config (a coin from before v2.8) charges its one fee from the first second, with nothing to count down", () => {
    expect(liveFeeOf(row(stored(200, true)), "curve", wall(0))).toEqual({ feeNowBps: 200, windowSecondsLeft: 0 });
  });

  test("until the row holds both facts the fee is not known (null) and nothing counts down; a stored text that is not a schedule is no schedule", () => {
    const none = { feeNowBps: null, windowSecondsLeft: 0 };
    expect(liveFeeOf(row({ feeSchedule: stored(100).feeSchedule }), "curve", wall(2))).toEqual(none);
    expect(liveFeeOf(row({ activationPoint: String(ACTIVATION) }), "curve", wall(2))).toEqual(none);
    for (const bad of ["{not json", "[]", "null", '{"cliffNumerator":"-1","periods":5,"periodSeconds":"1","reductionFactor":"1","mode":0,"activationType":1}', '{"cliffNumerator":"9","periods":1.5,"periodSeconds":"1","reductionFactor":"1","mode":0,"activationType":1}']) {
      expect(scheduleFromJson(bad)).toBeNull();
      expect(liveFeeOf(row({ feeSchedule: bad, activationPoint: String(ACTIVATION) }), "curve", wall(2))).toEqual(none);
    }
    expect(liveFeeOf(row({ ...stored(100), activationPoint: "17911633.5" }), "curve", wall(2))).toEqual(none);
  });

  test("the stored schedule reads back as written, and the window worked out from the row is the one the chain's config and pool give", () => {
    for (const bps of TIER_MENU_BPS) {
      const text = scheduleToJson(scheduleOfState(configOf(bps)));
      expect(scheduleToJson(scheduleFromJson(text)!)).toBe(text);
      const facts = storedWindowOf({ feeSchedule: text, activationPoint: String(ACTIVATION) })!;
      expect(launchWindowOf(facts.schedule, facts.activation)).toEqual(launchWindowOf(scheduleOfState(configOf(bps)), new BN(ACTIVATION)));
    }
  });
});

describe("GET /api/tiers names the window of every tier before any coin has one (contract v2.8)", () => {
  test("each tier carries the reviewed window: 99%, 5 steps of 1 s, the tier's fee after, the launcher's own first buy exempt", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/tiers"));
    expect(res.status).toBe(200);
    const tiers = ((await res.json()) as { tiers: { feeBps: number; launchWindow: Record<string, unknown> }[] }).tiers;
    expect(tiers.map((t) => t.feeBps)).toEqual([...TIER_MENU_BPS]);
    for (const t of tiers) {
      expect(t.launchWindow).toEqual({ ...tierWindow(t.feeBps) });
      expect(t.launchWindow).toMatchObject({ cliffBps: 9900, endBps: t.feeBps, periods: 5, periodSeconds: 1, durationSeconds: 5, firstSwapAtEndFee: true });
      expect((t.launchWindow.feeByPeriodBps as number[]).length).toBe(6);
    }
    expect(tiers[0]!.launchWindow.feeByPeriodBps).toEqual([9900, 7940, 5980, 4020, 2060, 100]);
  });
});
