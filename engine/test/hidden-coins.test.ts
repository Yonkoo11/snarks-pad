// GAP-AUDIT G42: the pad can keep a coin off every list (PAD_HIDDEN_MINTS) without touching the chain. A hidden coin is never listed, `all` included;
// the featured list still works for the rest.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import { isHidden, visibleCoins } from "../src/dbc/visible";
import { boardMints } from "../src/api/traderRoutes";
import { handleRequest } from "../src/api";
import { config } from "../src/config";

const key = () => Keypair.generate().publicKey.toBase58();
const [a, b, c] = [key(), key(), key()];
const coins = [{ mint: a }, { mint: b }, { mint: c }];
const made: string[] = [];
afterAll(() => { for (const m of made) db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: m }); });

describe("hidden coins", () => {
  test("never listed, with or without `all`", () => {
    expect(visibleCoins(coins, false, [], [b]).map((x) => x.mint)).toEqual([a, c]);
    expect(visibleCoins(coins, true, [], [b]).map((x) => x.mint)).toEqual([a, c]);
  });

  test("a featured list still picks from what is not hidden", () => {
    expect(visibleCoins(coins, false, [b, c], [b]).map((x) => x.mint)).toEqual([c]);
  });

  test("the board's featured list is unchanged by hiding: it is the featured list or every coin", () => {
    expect(boardMints(false, [])).toBeNull();
    expect(boardMints(false, [a])).toEqual([a]);
    expect(boardMints(true, [a])).toBeNull();
  });

  test("GET /trades leaves out a hidden coin's trades, `all` included, without listing the visible coins (S5-05)", async () => {
    const [x, y] = [key(), key()];
    const sigs: string[] = [];
    for (const m of [x, y]) {
      made.push(m);
      db.upsertCoin({ mint: m, name: "H", symbol: "H", imageUrl: "", description: "", creator: m, createdAt: new Date().toISOString(), feeBps: 100, poolId: key(), mintDecimals: 6, status: "launched" });
      const sig = key() + key();
      sigs.push(sig);
      db.insertTrade({ sig, mint: m, side: "buy", wallet: key(), amountToken: "1000", amountZec: "10", at: new Date().toISOString() });
    }
    const lists = config.api as { hiddenMints: string[] };
    const before = lists.hiddenMints;
    lists.hiddenMints = [y];
    try {
      const res = await handleRequest(new Request("http://pad.test/api/trades?all=1&limit=50"));
      const mints = ((await res.json()) as { trades: { mint: string }[] }).trades.map((t) => t.mint);
      expect(mints).toContain(x);
      expect(mints).not.toContain(y);
    } finally {
      lists.hiddenMints = before;
      for (const sig of sigs) db.getDb().query("DELETE FROM trades WHERE sig = $s").run({ $s: sig });
    }
  });

  test("isHidden reads the same list", () => {
    expect(isHidden(b, [b])).toBe(true);
    expect(isHidden(a, [b])).toBe(false);
  });
});
