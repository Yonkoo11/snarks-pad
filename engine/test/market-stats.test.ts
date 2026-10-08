// The 24-hour numbers of GET /api/coins and /api/coins/:mint docs/API.md v2.5: volume, trade count and the price
// change, all from the trades table. Run against the test sqlite file; every test uses mints of its own, because other
// test files record trades in the same database.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import { WINDOW_MS, priceChangeBps, windowStatsByMint } from "../src/dbc/marketStats";
import { pricePoints } from "../src/dbc/priceHistory";
import { makeTtlMemo } from "../src/util/memo";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
const HOUR = 3_600_000;

function coin(feeBps = 100): string {
  const mint = Keypair.generate().publicKey.toBase58();
  db.upsertCoin({
    mint, name: "Stat", symbol: "STAT", imageUrl: "", description: "", creator: mint, createdAt: new Date(NOW).toISOString(),
    feeBps, poolId: null, mintDecimals: 6, status: "pending",
  });
  return mint;
}

// Signatures carry the mint, so a second run on the same database file never collides with the first.
let n = 0;
function trade(mint: string, side: "buy" | "sell", amountZec: string, amountToken: string, when: string, sig = `sig-${mint}-${n++}`): void {
  db.insertTrade({ sig, mint, side, wallet: "w", amountToken, amountZec, at: when });
}

describe("windowStatsByMint", () => {
  test("a coin with no trade is absent, and the 24-hour edge is inclusive: 24 h old counts, a millisecond older does not", () => {
    const quiet = coin();
    const m = coin();
    trade(m, "buy", "1000", "5000000", at(WINDOW_MS)); // exactly 24 h
    trade(m, "buy", "7", "5000000", at(WINDOW_MS + 1)); // one millisecond too old
    trade(m, "sell", "300", "5000000", at(HOUR));
    const stats = windowStatsByMint(NOW);
    expect(stats.has(quiet)).toBe(false);
    expect(stats.get(m)).toMatchObject({ volume24hZats: "1300", trades24h: 2 });
  });

  test("volume is an exact integer past 2^53, summed across buys and sells", () => {
    const m = coin();
    trade(m, "buy", "9007199254740993", "5000000", at(HOUR));
    trade(m, "sell", "9007199254740993", "5000000", at(HOUR - 1000));
    trade(m, "buy", "1", "5000000", at(HOUR - 2000));
    expect(windowStatsByMint(NOW).get(m)!.volume24hZats).toBe((2n * 9007199254740993n + 1n).toString());
  });

  test("each coin gets its own numbers", () => {
    const a = coin();
    const b = coin();
    trade(a, "buy", "100", "1000000", at(HOUR));
    trade(b, "buy", "250", "1000000", at(HOUR));
    trade(b, "buy", "250", "1000000", at(HOUR - 1));
    const stats = windowStatsByMint(NOW);
    expect([stats.get(a)!.volume24hZats, stats.get(a)!.trades24h]).toEqual(["100", 1]);
    expect([stats.get(b)!.volume24hZats, stats.get(b)!.trades24h]).toEqual(["500", 2]);
  });

  test("the first price is the price-history point of the earliest trade in the window, fee-adjusted like the chart", () => {
    const m = coin(100);
    // Pool price 2 zats per whole token: buy 1,000,000 zats gross buys 495,000 tokens after the 1% fee.
    trade(m, "buy", "1000000", String(495_000n * 10n ** 6n), at(5 * HOUR));
    trade(m, "sell", "198000", String(100_000n * 10n ** 6n), at(2 * HOUR));
    trade(m, "buy", "1000000", String(100_000n * 10n ** 6n), at(30 * HOUR)); // older than the window: never the first price
    const stats = windowStatsByMint(NOW).get(m)!;
    expect(stats.firstPriceZec).toBe("2");
    const window = db.listTradesForMint(m, 10).filter((t) => t.at >= at(WINDOW_MS)).reverse();
    expect(pricePoints({ feeBps: 100, mintDecimals: 6 }, window)[0]!.priceZec).toBe(stats.firstPriceZec!);
    expect(stats.trades24h).toBe(2);
  });

  test("a trade that moved no ZEC is counted but is never the first price: the next trade is", () => {
    const m = coin(100);
    trade(m, "buy", "0", String(5n * 10n ** 6n), at(5 * HOUR));
    trade(m, "buy", "1000000", String(495_000n * 10n ** 6n), at(4 * HOUR));
    const stats = windowStatsByMint(NOW).get(m)!;
    expect([stats.trades24h, stats.volume24hZats, stats.firstPriceZec]).toEqual([2, "1000000", "2"]);
  });

  test("two trades in the same second: the smaller signature is first, the order the price chart uses", () => {
    const m = coin(100);
    const when = at(HOUR);
    trade(m, "buy", "1000000", String(495_000n * 10n ** 6n), when, `${m}-zzz`); // price 2
    trade(m, "buy", "1000000", String(247_500n * 10n ** 6n), when, `${m}-aaa`); // price 4
    expect(windowStatsByMint(NOW).get(m)!.firstPriceZec).toBe("4");
  });

  test("a row with a non-numeric amount is skipped, never fatal", () => {
    const m = coin();
    trade(m, "buy", "500", "1000000", at(HOUR));
    db.getDb().query("INSERT INTO trades (sig,mint,side,wallet,amountToken,amountZec,at) VALUES ($s,$m,'buy','w','1000000','12abc',$at)").run({ $s: `bad-${m}-${n++}`, $m: m, $at: at(HOUR - 5) });
    db.getDb().query("INSERT INTO trades (sig,mint,side,wallet,amountToken,amountZec,at) VALUES ($s,$m,'buy','w','-3','500',$at)").run({ $s: `bad-${m}-${n++}`, $m: m, $at: at(HOUR - 6) });
    expect(windowStatsByMint(NOW).get(m)).toMatchObject({ volume24hZats: "500", trades24h: 1 });
  });

  test("a trade of a mint with no coin row still counts for volume; it has no price", () => {
    const ghost = Keypair.generate().publicKey.toBase58();
    trade(ghost, "buy", "42", "1000000", at(HOUR));
    expect(windowStatsByMint(NOW).get(ghost)).toEqual({ volume24hZats: "42", trades24h: 1, firstPriceZec: null });
  });
});

describe("priceChangeBps", () => {
  test("doubled is +10000, halved is -5000, unchanged is 0", () => {
    expect(priceChangeBps("2", "4")).toBe(10_000);
    expect(priceChangeBps("2", "1")).toBe(-5_000);
    expect(priceChangeBps("0.375", "0.375")).toBe(0);
  });

  test("decimals up to 12 places are exact: 0.37545974197 -> 0.41300571617 is +10.00%", () => {
    expect(priceChangeBps("0.37545974197", "0.41300571617")).toBe(1_000);
  });

  test("rounds to the nearest basis point, halves away from zero, in both directions", () => {
    expect(priceChangeBps("10000", "10000.5")).toBe(1); // +0.5 bp
    expect(priceChangeBps("10000", "9999.5")).toBe(-1); // -0.5 bp
    expect(priceChangeBps("10000", "10000.4")).toBe(0);
    expect(priceChangeBps("10000", "9999.6")).toBe(0); // -0.4 bp rounds to 0, and it is a plain 0, never -0
    expect(Object.is(priceChangeBps("10000", "9999.6"), -0)).toBe(false);
  });

  test("a rise of a hundred million times is exact", () => {
    expect(priceChangeBps("1", "100000000")).toBe((100_000_000 - 1) * 10_000);
  });

  test("no first price, or a price that is not above zero on either side, is null", () => {
    expect(priceChangeBps(null, "4")).toBeNull();
    expect(priceChangeBps("0", "4")).toBeNull();
    expect(priceChangeBps("2", "0")).toBeNull();
    expect(priceChangeBps("2", "")).toBeNull();
    expect(priceChangeBps("2", "abc")).toBeNull();
    expect(priceChangeBps("2", "-1")).toBeNull();
    expect(priceChangeBps("2", "1e3")).toBeNull();
    expect(priceChangeBps("2", "1.1234567890123")).toBeNull(); // more than 12 decimals is not a price this engine writes
  });
});

describe("makeTtlMemo", () => {
  test("computes once per window, again after it, and clear() forces a new one", () => {
    let t = 1000;
    let runs = 0;
    const memo = makeTtlMemo((now) => ({ runs: ++runs, now }), 500, () => t);
    expect(memo.get()).toEqual({ runs: 1, now: 1000 });
    t = 1499;
    expect(memo.get().runs).toBe(1);
    t = 1500;
    expect(memo.get()).toEqual({ runs: 2, now: 1500 });
    memo.clear();
    expect(memo.get().runs).toBe(3);
  });

  test("a window of 0 computes every call", () => {
    let runs = 0;
    const memo = makeTtlMemo(() => ++runs, 0, () => 7);
    memo.get();
    memo.get();
    expect(runs).toBe(2);
  });

  test("a compute that throws keeps nothing: the next call tries again", () => {
    let runs = 0;
    const memo = makeTtlMemo(() => {
      if (++runs === 1) throw new Error("db busy");
      return runs;
    }, 60_000, () => 1);
    expect(() => memo.get()).toThrow("db busy");
    expect(memo.get()).toBe(2);
  });

  test("a clock that moves backwards ages the kept value out instead of freezing it", () => {
    let t = 10_000;
    let runs = 0;
    const memo = makeTtlMemo(() => ++runs, 500, () => t);
    memo.get();
    t = 5_000;
    memo.get();
    expect(runs).toBe(2);
  });
});
