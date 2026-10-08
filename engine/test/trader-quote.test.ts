// GET /api/coins/:mint/quote docs/API.md v2.6: the price impact rule (pure), and a hostile pass on the parameters through the
// real fetch handler. Every bad request is a clean 400 naming the field, answered before any chain read, and nothing sent is echoed.
// A good request for a coin whose pool does not exist is 503 chain_unavailable, never a 500. The numbers on real pools are in
// trader-live.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import * as db from "../src/db";
import { priceImpactBps } from "../src/dbc/quote";

/** A price as the engine keeps it: num / den quote raw units per base raw unit. */
const P = (num: bigint, den: bigint = 1n) => ({ num, den });

describe("priceImpactBps", () => {
  test("a buy that pays 5% above the pool's price before it is 500 bps; fee is not in it (the caller passes the fee-free quote side)", () => {
    // spot 1 quote unit per base unit; 1,050 quote units buy 1,000 base units
    expect(priceImpactBps("buy", P(1n), 1050n, 1000n)).toBe(500);
  });

  test("a sell that gets 10% below the pool's price before it is 1000 bps", () => {
    expect(priceImpactBps("sell", P(1n), 900n, 1000n)).toBe(1000);
  });

  test("rounds down, never up", () => {
    expect(priceImpactBps("buy", P(1n), 100019n, 100000n)).toBe(1); // 1.9 bps
    expect(priceImpactBps("buy", P(1n), 100009n, 100000n)).toBe(0); // 0.9 bps
  });

  test("a trade that got a better price than the pool's (rounding at tiny sizes) is 0, never negative", () => {
    expect(priceImpactBps("buy", P(1n), 999n, 1000n)).toBe(0);
    expect(priceImpactBps("sell", P(1n), 1001n, 1000n)).toBe(0);
  });

  test("nothing traded, or no price, is 0 and never throws", () => {
    expect(priceImpactBps("buy", P(1n), 100n, 0n)).toBe(0);
    expect(priceImpactBps("buy", P(1n), 0n, 100n)).toBe(0);
    expect(priceImpactBps("sell", P(0n), 100n, 100n)).toBe(0);
    expect(priceImpactBps("buy", P(1n, 10n ** 10n), 100n, 100n)).toBeGreaterThan(0); // a price far below 1 raw unit still works
    expect(priceImpactBps("buy", P(1n, 0n), 100n, 100n)).toBe(0); // a price with no denominator is no price
  });

  test("exact for u64-sized amounts (no float in the way)", () => {
    const base = 10n ** 15n;
    const spot = P(1n, 10n ** 12n); // 1e-12 quote units per base unit
    const ex = (base * 11n) / 10_000_000_000_000n; // 1.1 x spot x base = 1,100
    expect(priceImpactBps("buy", spot, ex, base)).toBe(1000);
    expect(priceImpactBps("buy", spot, ex + 1n, base)).toBe(1010); // the notional at the pool's price is 1,000 units: one more raw unit is +10 bps
    // 2^63 for 2^64 - 1 at a price of 1 is a hair above half the price: 49.999...% worse, which rounds DOWN to 4999 bps, not up to 5000
    expect(priceImpactBps("sell", P(2n ** 64n, 2n ** 64n), 2n ** 63n, 2n ** 64n - 1n)).toBe(4999);
  });

  test("a price held as a fraction of 2^128, the way the pools store it, gives the same answer as the plain price", () => {
    const sqrt = 13_043_821_027_047_436n; // the 1% config's start price
    const spot = P(sqrt * sqrt, 1n << 128n);
    const base = 10n ** 12n;
    const priceQuotePerBase = Number(sqrt * sqrt) / 2 ** 128;
    const quoteEx = BigInt(Math.floor(priceQuotePerBase * Number(base) * 1.05));
    expect(Math.abs(priceImpactBps("buy", spot, quoteEx, base) - 500)).toBeLessThanOrEqual(1);
  });
});

const B = "http://pad.test/api";
const MINT = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58(); // no such account on any chain

async function call(path: string): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await handleRequest(new Request(B + path));
  const text = await res.text();
  expect(res.status).not.toBe(500); // a hostile request is refused or answered, never a crash
  expect(text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:/);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

beforeAll(() => {
  db.upsertCoin({ mint: MINT, name: "Quote Probe", symbol: "QPRB", imageUrl: "", description: "", creator: MINT, createdAt: new Date().toISOString(), feeBps: 100, poolId: POOL, mintDecimals: 6, status: "launched" });
});
afterAll(() => {
  db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: MINT });
});

const q = (qs: string) => call(`/coins/${MINT}/quote?${qs}`);

describe("GET /coins/:mint/quote: hostile parameters", () => {
  test("side is required and is exactly buy or sell: 400 bad_request field side", async () => {
    for (const qs of ["amount=5", "side=&amount=5", "side=BUY&amount=5", "side=hodl&amount=5", "side=buy%00&amount=5", "side=buy&side=sell&amount=5", "side[]=buy&amount=5", "side=%62uy%20&amount=5"]) {
      const r = await q(qs);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field: "side" });
    }
  });

  test("amount is a positive integer string within u64: 400 bad_amount field amount, whatever the junk", async () => {
    const bad = ["", "0", "00", "-1", "+1", "1.5", "1e9", "0x10", " 5", "5 ", "05", "18446744073709551616", "9".repeat(40), "1".repeat(5000), "NaN", "Infinity", "%00", "5%00", "%E2%82%AC5", "1,000", "5;drop table coins", "constructor"];
    for (const amount of bad) {
      const r = await q(`side=buy&amount=${encodeURIComponent(amount)}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_amount", field: "amount" });
      expect(r.text).not.toContain("drop table");
    }
    expect((await q("side=buy")).body).toEqual({ error: "bad_amount", field: "amount" }); // missing
    expect((await q("side=sell&amount=5&amount=6")).body).toEqual({ error: "bad_request", field: "amount" }); // sent twice
  });

  test("slippageBps is a plain decimal integer 0..5000: 400 bad_request field slippageBps", async () => {
    for (const s of ["-1", "5001", "1.5", "1e2", "abc", "", "0x5", " 5", "+5", "9999999999", "50000000000000"]) {
      const r = await q(`side=buy&amount=5&slippageBps=${encodeURIComponent(s)}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field: "slippageBps" });
    }
    expect((await q("side=buy&amount=5&slippageBps=1&slippageBps=2")).body).toEqual({ error: "bad_request", field: "slippageBps" });
  });

  test("an unknown mint, in any spelling, is 404 unknown_mint, before the parameters are looked at", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    for (const m of [other, "garbage", "..%2F..%2Fetc", "%E0%A4%A", encodeURIComponent("$(id)"), "1".repeat(45), "launch-tx", "confirm"]) {
      const r = await call(`/coins/${m}/quote?side=hodl&amount=junk`);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "unknown_mint" });
    }
  });

  test("a coin that is only pending is not a coin: 404 unknown_mint", async () => {
    const pending = Keypair.generate().publicKey.toBase58();
    db.upsertCoin({ mint: pending, name: "Pend", symbol: "PEND", imageUrl: "", description: "", creator: pending, createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
    expect((await call(`/coins/${pending}/quote?side=buy&amount=5`)).status).toBe(404);
    db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: pending });
  });

  test("a good request for a pool the chain does not have is 503 chain_unavailable, not a 500, and says nothing about the pool", async () => {
    const r = await q("side=buy&amount=100000000&slippageBps=100");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "chain_unavailable" });
    expect(r.text).not.toContain(POOL);
  });

  test("only GET is a route; POST, DELETE and a longer path are not", async () => {
    for (const [method, path] of [["POST", `/coins/${MINT}/quote`], ["DELETE", `/coins/${MINT}/quote`], ["GET", `/coins/${MINT}/quote/extra`], ["GET", `/coins/${MINT}/quotes`]] as const) {
      const res = await handleRequest(new Request(B + path + "?side=buy&amount=5", { method, ...(method === "POST" ? { body: "{}" } : {}) }));
      expect(res.status).toBe(404);
    }
  });
});
