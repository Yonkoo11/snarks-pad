// dbc/tradeIndex.ts: the API's sweep that fills the trades tape from each board coin's pool signatures, oldest first, with a cursor per pool so a backlog
// continues across rounds and nothing is skipped. Written 2026-10-12 after mainnet trades made through terminals never reached the tape.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import { TradeError } from "../src/dbc/trade";
import { indexTrades, tradeCursorKey, type SignatureInfo, type SignatureQuery, type TradeIndexLook } from "../src/dbc/tradeIndex";
import { ChainUnavailableError } from "../src/rpcGuard";

const made: string[] = [];
const pools: string[] = [];
afterAll(() => {
  for (const m of made) db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
  for (const p of pools) db.deleteMeta(tradeCursorKey(p));
});
const fresh = (): string => { const k = Keypair.generate().publicKey.toBase58(); pools.push(k); return k; };

function coin(symbol: string, opts: { status?: "pending" | "launched"; poolId?: string | null; dammPool?: string } = {}): db.CoinRow {
  const mint = Keypair.generate().publicKey.toBase58();
  made.push(mint);
  db.upsertCoin({
    mint, name: symbol, symbol, imageUrl: "", description: "", creator: Keypair.generate().publicKey.toBase58(), createdAt: new Date().toISOString(),
    feeBps: 100, poolId: opts.poolId === undefined ? fresh() : opts.poolId, mintDecimals: 6, status: opts.status ?? "launched",
    configId: Keypair.generate().publicKey.toBase58(), socials: "{}", creatorWallet: null, feeSchedule: null,
  });
  if (opts.dammPool) db.markCoinMigrated(mint, opts.dammPool, null);
  return db.getCoin(mint)!;
}

/** A chain whose pools hold `chain[pool]`, oldest first; `fails` names signatures whose reader throws. Counts every query and record call. */
function fakeLook(chain: Record<string, SignatureInfo[]>, fails: Record<string, Error> = {}) {
  const look = {
    queries: [] as { address: string; q: SignatureQuery }[],
    recorded: [] as string[],
    async signatures(address: string, q: SignatureQuery) {
      look.queries.push({ address, q });
      const all = [...(chain[address] ?? [])].reverse(); // newest first, as the RPC answers
      let from = 0;
      if (q.before) from = all.findIndex((s) => s.signature === q.before) + 1;
      let to = all.length;
      if (q.until) {
        const i = all.findIndex((s) => s.signature === q.until);
        if (i >= 0) to = i;
      }
      return all.slice(from, Math.min(to, from + q.limit));
    },
    async record(sig: string, _mint: string) {
      if (fails[sig]) throw fails[sig];
      look.recorded.push(sig);
    },
  };
  return look as typeof look & TradeIndexLook;
}
const sig = (name: string, err: unknown = null): SignatureInfo => ({ signature: name, err });

describe("the API's trade sweep", () => {
  test("a first round records a pool's trades oldest first, skips failed transactions and non-trades, leaves pending coins alone, and the next round lists only what is newer", async () => {
    const c = coin("IDX1");
    coin("PEND", { status: "pending", poolId: null });
    const pool = c.poolId!;
    const look = fakeLook({ [pool]: [sig("a"), sig("b", { lost: true }), sig("c"), sig("d")] }, { c: new TradeError("not_a_trade") });
    const r1 = await indexTrades(look, { now: 1 });
    expect(look.recorded).toEqual(["a", "d"]);
    expect(r1.recorded).toBe(2);
    expect(r1.looked).toBe(3);
    expect(db.getMeta(tradeCursorKey(pool))).toBe("d");
    expect(look.queries[0]!.q.until).toBeUndefined();
    const r2 = await indexTrades(look, { now: 2 });
    expect(r2.recorded).toBe(0);
    expect(look.queries[look.queries.length - 1]!.q.until).toBe("d");
    expect(look.recorded).toEqual(["a", "d"]);
  });

  test("a round's cap leaves each cursor on the last transaction read; the next round continues from there and the DAMM pool is swept too", async () => {
    const damm = fresh();
    const c = coin("IDX2", { dammPool: damm });
    const look = fakeLook({ [c.poolId!]: [sig("p1"), sig("p2"), sig("p3")], [damm]: [sig("d1"), sig("d2")] });
    // A budget of 2 over two pools: one each (the fair share; until 2026-10-12 the curve pool took both and the DAMM pool waited).
    const r1 = await indexTrades(look, { now: 1, budget: 2 });
    expect(r1.recorded).toBe(2);
    expect(look.recorded).toEqual(["p1", "d1"]);
    expect(db.getMeta(tradeCursorKey(c.poolId!))).toBe("p1");
    expect(db.getMeta(tradeCursorKey(damm))).toBe("d1");
    const r2 = await indexTrades(look, { now: 2, budget: 10 });
    expect(r2.recorded).toBe(3);
    expect(look.recorded).toEqual(["p1", "d1", "p2", "p3", "d2"]);
    expect(db.getMeta(tradeCursorKey(damm))).toBe("d2");
  });

  test("a pool with a long backlog cannot use the whole round: every pool gets a fair share first, and the leftover goes back to the capped pool", async () => {
    // Before 2026-10-12 the first pool took the whole budget every round and the pools after it were never looked at while its backlog lasted.
    // The test database holds other launched coins; a round with nothing new makes their pools sit out the next two minutes, so this round is HOT and COLD only.
    await indexTrades(fakeLook({}), { now: 0 });
    const cold = coin("COLD");
    await Bun.sleep(2);
    const hot = coin("HOT"); // newer, so the sweep looks at it first (listCoins is newest first)
    const chain = { [hot.poolId!]: Array.from({ length: 10 }, (_, i) => sig(`h${i + 1}`)), [cold.poolId!]: [sig("c1"), sig("c2")] };
    const look = fakeLook(chain);
    const r1 = await indexTrades(look, { now: 1, budget: 6 });
    // Pass 1: HOT gets ceil(6/2) = 3, COLD gets ceil(3/1) = 3 but has 2; pass 2: the 1 left goes back to HOT.
    expect(look.recorded).toEqual(["h1", "h2", "h3", "c1", "c2", "h4"]);
    expect(r1.looked).toBe(6);
    expect(db.getMeta(tradeCursorKey(hot.poolId!))).toBe("h4");
    expect(db.getMeta(tradeCursorKey(cold.poolId!))).toBe("c2");
    // Next round: COLD has nothing new and costs one listing; HOT continues from h4 with the rest of the budget.
    const r2 = await indexTrades(look, { now: 2, budget: 6 });
    expect(r2.looked).toBe(6);
    expect(look.recorded.slice(6)).toEqual(["h5", "h6", "h7", "h8", "h9", "h10"]);
  });

  test("a chain outage ends the round with the progress made kept; a pool with nothing new is looked at less often", async () => {
    const c = coin("IDX3");
    const pool = c.poolId!;
    const look = fakeLook({ [pool]: [sig("x1"), sig("x2"), sig("x3")] }, { x2: new ChainUnavailableError("timeout", "rpc down") });
    await expect(indexTrades(look, { now: 1 })).rejects.toThrow("rpc down");
    expect(db.getMeta(tradeCursorKey(pool))).toBe("x1");
    const ok = fakeLook({ [pool]: [sig("x1"), sig("x2"), sig("x3")] });
    expect((await indexTrades(ok, { now: 2 })).recorded).toBe(2);
    expect(ok.recorded).toEqual(["x2", "x3"]);
    // Nothing new now: the pool is skipped for the next two minutes, then looked at again (the test database holds other coins; count this pool only).
    const idle = fakeLook({ [pool]: [sig("x1"), sig("x2"), sig("x3")] });
    const asked = () => idle.queries.filter((q) => q.address === pool).length;
    await indexTrades(idle, { now: 3 });
    expect(asked()).toBe(1);
    await indexTrades(idle, { now: 4 });
    expect(asked()).toBe(1);
    await indexTrades(idle, { now: 4 + 3 * 60_000 });
    expect(asked()).toBe(2);
  });
});
