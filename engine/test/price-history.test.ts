// The price chart's data: one fee-adjusted point per recorded trade, oldest first, served without any chain read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import * as db from "../src/db";
import { MAX_PRICE_POINTS, pricePoints } from "../src/dbc/priceHistory";

const coin = { feeBps: 100, mintDecimals: 6 };
const trade = (side: "buy" | "sell", amountZec: string, amountToken: string, at: string, sig = `${side}${at}${amountZec}`): db.TradeRow => ({
  sig, mint: "m", side, wallet: "w", amountToken, amountZec, at,
});

describe("pricePoints", () => {
  test("a buy is priced net of the pool fee, a sell grossed up by it: both land on the same price", () => {
    // Pool price 2 zats per whole token. Buy 1,000,000 zats gross: 1% fee = 10,000, net 990,000 -> 495,000 whole tokens.
    const buy = trade("buy", "1000000", String(495_000n * 10n ** 6n), "2026-10-01T00:00:00Z");
    // Sell 100,000 whole tokens: gross 200,000, fee 2,000, net 198,000.
    const sell = trade("sell", "198000", String(100_000n * 10n ** 6n), "2026-10-01T00:01:00Z");
    expect(pricePoints(coin, [buy, sell]).map((p) => p.priceZec)).toEqual(["2", "2"]);
  });

  test("sub-zat prices keep their decimals (a memecoin trades far below 1 zat per token)", () => {
    const buy = trade("buy", "1000000", String(2_640_000n * 10n ** 6n), "2026-10-01T00:00:00Z");
    const [p] = pricePoints(coin, [buy]);
    expect(Number(p!.priceZec)).toBeCloseTo(0.375, 3);
  });

  test("a trade that moved no tokens or no ZEC is skipped, never drawn as 0", () => {
    const pts = pricePoints(coin, [trade("buy", "0", "5", "2026-10-01T00:00:00Z"), trade("sell", "5", "0", "2026-10-01T00:01:00Z"), trade("buy", "1000000", "1000000", "2026-10-01T00:02:00Z")]);
    expect(pts.length).toBe(1);
  });

  test("a different token decimals changes the scale, not the meaning", () => {
    const buy = trade("buy", "1000000", String(495_000n * 10n ** 9n), "2026-10-01T00:00:00Z");
    expect(pricePoints({ feeBps: 100, mintDecimals: 9 }, [buy])[0]!.priceZec).toBe("2");
  });
});

describe("GET /api/coins/:mint/price-history", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  beforeAll(() => {
    db.upsertCoin({ mint, name: "Chart", symbol: "CHT", imageUrl: "", description: "", creator: Keypair.generate().publicKey.toBase58(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
    db.markCoinLaunched(mint, Keypair.generate().publicKey.toBase58());
  });
  afterAll(() => db.upsertCoin({ ...db.getCoin(mint)!, status: "pending" }));
  const get = async (m: string) => handleRequest(new Request(`http://x/api/coins/${m}/price-history`));

  test("a launched coin with no trades answers an empty list, not an error", async () => {
    const res = await get(mint);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ points: [] });
  });

  test("points come back oldest first and capped to the newest MAX_PRICE_POINTS", async () => {
    const total = MAX_PRICE_POINTS + 25;
    for (let i = 0; i < total; i++) {
      db.insertTrade({ sig: `sig-${mint}-${i}`, mint, side: "buy", wallet: "w", amountToken: String((1_000 + i) * 10 ** 6), amountZec: "1000000", at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() });
    }
    const body = (await (await get(mint)).json()) as { points: { at: string; priceZec: string }[] };
    expect(body.points.length).toBe(MAX_PRICE_POINTS);
    const times = body.points.map((p) => p.at);
    expect([...times].sort()).toEqual(times); // ascending
    expect(times[times.length - 1]).toBe(new Date(Date.UTC(2026, 9, 1, 0, 0, total - 1)).toISOString()); // the newest is kept
    expect(times[0]).toBe(new Date(Date.UTC(2026, 9, 1, 0, 0, 25)).toISOString()); // the oldest 25 were dropped
  });

  test("an unknown or malformed mint is a 404 unknown_mint", async () => {
    expect((await get(Keypair.generate().publicKey.toBase58())).status).toBe(404);
    expect((await get("launch-tx")).status).toBe(404);
    expect(await (await get("not-a-key")).json()).toEqual({ error: "unknown_mint" });
  });
});
