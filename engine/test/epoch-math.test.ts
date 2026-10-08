import { describe, expect, test } from "bun:test";
import { applyDustFloor, chunk, proRataSplit } from "../src/epoch/math";

describe("proRataSplit", () => {
  test("sums exactly to total even when it does not divide evenly", () => {
    const holders = [
      { wallet: "a", balance: 1n },
      { wallet: "b", balance: 1n },
      { wallet: "c", balance: 1n },
    ];
    const shares = proRataSplit(100n, holders);
    expect(shares.reduce((acc, s) => acc + s.amount, 0n)).toBe(100n);
    // 100/3 = 33.33; largest-remainder gives two holders 34 and one 33 (order depends on tie-break)
    const amounts = shares.map((s) => s.amount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(amounts).toEqual([33n, 33n, 34n]);
  });

  test("proportional weights sum exactly for many random splits", () => {
    for (let trial = 0; trial < 50; trial++) {
      const n = 1 + Math.floor(Math.random() * 12);
      const holders = Array.from({ length: n }, (_, i) => ({
        wallet: `w${i}`,
        balance: BigInt(1 + Math.floor(Math.random() * 1_000_000)),
      }));
      const total = BigInt(Math.floor(Math.random() * 10_000_000));
      const shares = proRataSplit(total, holders);
      expect(shares.reduce((acc, s) => acc + s.amount, 0n)).toBe(total);
      for (const s of shares) expect(s.amount).toBeGreaterThanOrEqual(0n);
    }
  });

  test("empty holders or zero total balance yields no shares", () => {
    expect(proRataSplit(100n, [])).toEqual([]);
    expect(proRataSplit(100n, [{ wallet: "a", balance: 0n }])).toEqual([]);
  });

  test("zero total distributes zero to everyone", () => {
    const shares = proRataSplit(0n, [
      { wallet: "a", balance: 5n },
      { wallet: "b", balance: 5n },
    ]);
    expect(shares.every((s) => s.amount === 0n)).toBe(true);
  });

  test("single holder gets the whole total", () => {
    const shares = proRataSplit(777n, [{ wallet: "solo", balance: 42n }]);
    expect(shares).toEqual([{ wallet: "solo", amount: 777n }]);
  });

  test("rejects a negative total", () => {
    expect(() => proRataSplit(-1n, [{ wallet: "a", balance: 1n }])).toThrow();
  });
});

describe("applyDustFloor", () => {
  test("splits sends from carries at the floor boundary", () => {
    const shares = [
      { wallet: "big", amount: 10_000n },
      { wallet: "small", amount: 2_000n },
    ];
    const { toSend, toCarry } = applyDustFloor(shares, new Map(), 5_000n);
    expect(toSend).toEqual([{ wallet: "big", amount: 10_000n }]);
    expect(toCarry).toEqual([{ wallet: "small", amount: 2_000n }]);
  });

  test("carry-in accumulates until it clears the floor", () => {
    const shares = [{ wallet: "small", amount: 2_000n }];
    const carryIn = new Map([["small", 3_500n]]);
    const { toSend, toCarry } = applyDustFloor(shares, carryIn, 5_000n);
    expect(toSend).toEqual([{ wallet: "small", amount: 5_500n }]);
    expect(toCarry).toEqual([]);
  });

  test("zero amounts are dropped entirely, not carried", () => {
    const { toSend, toCarry } = applyDustFloor([{ wallet: "z", amount: 0n }], new Map(), 5_000n);
    expect(toSend).toEqual([]);
    expect(toCarry).toEqual([]);
  });
});

describe("chunk", () => {
  test("splits into groups of at most `size`, preserving order", () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunk(items, 10);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunks.flat()).toEqual(items);
  });

  test("rejects a non-positive size", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow();
  });
});
