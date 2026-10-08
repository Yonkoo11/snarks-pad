// Price and market cap from a Meteora pool's Q64.64 sqrt price. The first case
// is a real local-validator pool (sqrtPrice 13431222321756295 after one 0.2 ZEC
// buy on the 5 ZEC initial-market-cap curve): the market cap must come out near
// the configured 5 ZEC, which is what makes the conversion checkable.
import { describe, expect, test } from "bun:test";
import { priceFromSqrtPrice, decimalRatio } from "../src/dbc/read";

describe("priceFromSqrtPrice", () => {
  test("base is token A: zats per whole token, and the market cap lands at the curve's 5 ZEC initial cap", () => {
    const { priceZec, marketCapZec } = priceFromSqrtPrice(13431222321756295n, true);
    expect(priceZec).toBe("0.530141290272");
    const capZec = Number(marketCapZec) / 1e8;
    expect(capZec).toBeGreaterThan(5);
    expect(capZec).toBeLessThan(5.5);
  });

  test("base is token B: the price is inverted, not reused", () => {
    const a = priceFromSqrtPrice(13431222321756295n, true);
    const b = priceFromSqrtPrice(13431222321756295n, false);
    expect(Number(b.priceZec)).toBeGreaterThan(1e6); // 1 / 5.3e-7 raw, scaled to whole tokens
    expect(b.priceZec).not.toBe(a.priceZec);
  });

  test("zero price is reported as zero, not NaN", () => {
    expect(priceFromSqrtPrice(0n, true)).toEqual({ priceZec: "0", marketCapZec: "0" });
  });
});

describe("decimalRatio", () => {
  test("keeps sub-zat precision as a decimal string", () => {
    expect(decimalRatio(1n, 3n, 4)).toBe("0.3333");
    expect(decimalRatio(6n, 3n, 4)).toBe("2");
  });
});
