// GET /api/coins, GET /api/coins/:mint and GET /api/stats on REAL pools (the local validator runs the mainnet DBC binary):
// three coins launched through the engine's own builder, trades and a holder sample recorded for some of them, then the
// routes read back. The unit files (market-stats, coins-listing, stats, holder-count) cover the rules; this one covers the
// wiring: real pool views joined with the database numbers, in the order and page the query asks for.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { clearStatsCache, handleRequest } from "../src/api";
import { getConnection } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import * as db from "../src/db";
import { validatorUp } from "./helpers/validator-up";

const live = await validatorUp();
const HOUR = 3_600_000;
const tag = `X${Math.random().toString(36).slice(2, 8)}`; // unique to this run: the search keeps other suites' coins out of every list below
const made: string[] = [];

afterAll(() => {
  // The shared test database must not keep these coins: other suites list coins and read the newest config.
  const d = db.getDb();
  for (const m of made) for (const table of ["coins", "trades", "holder_samples"]) d.query(`DELETE FROM ${table} WHERE mint = $m`).run({ $m: m });
});

async function launch(suffix: string, initialBuyZats: string): Promise<string> {
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
  const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: `${tag} ${suffix}`, symbol: `${tag}${suffix}`, description: "", imageUrl: "", initialBuyZats });
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([creator]);
  const sig = await getConnection().sendRawTransaction(tx.serialize());
  await getConnection().confirmTransaction(sig, "confirmed");
  await confirmLaunch(sig, mint);
  made.push(mint);
  return mint;
}

interface ListedCoin {
  mint: string; stage: string; priceZec: string; marketCapZec: string; curveProgress: number; createdAt: string; graduatedAt: string | null;
  volume24hZats: string; trades24h: number; priceChange24hBps: number | null; holders: number | null;
  rewards: { paidSolanaZec: string; paidShieldedZec: string; epochs: number };
}

async function list(qs: string): Promise<{ status: number; coins: ListedCoin[]; total: number; body: Record<string, unknown> }> {
  const res = await handleRequest(new Request(`http://pad.test/api/coins?${qs}`));
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, coins: (body.coins ?? []) as ListedCoin[], total: body.total as number, body };
}

describe.if(live)("explore routes on real pools", () => {
  let a = "";
  let b = "";
  let c = "";

  test("setup: A (0.2 ZEC first buy, 3 trades and a holder sample), B (0.5 ZEC first buy, 1 trade), C (0.2 ZEC, nothing recorded)", async () => {
    await ensureDbcConfig();
    a = await launch("A", "20000000");
    b = await launch("B", "50000000");
    c = await launch("C", "20000000");
    const row = (m: string) => db.getCoin(m)!;
    expect(row(a).createdAt < row(b).createdAt && row(b).createdAt < row(c).createdAt).toBe(true);
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    // 1% tier: 1,000,000 zats paid for 990,000 whole tokens is a fee-adjusted price of exactly 1 zat per token.
    const buy = (m: string, sig: string, zec: string, tokens: bigint, msAgo: number) =>
      db.insertTrade({ sig: `${tag}-${sig}`, mint: m, side: "buy", wallet: "w", amountToken: (tokens * 10n ** 6n).toString(), amountZec: zec, at: at(msAgo) });
    buy(a, "a1", "1000000", 990_000n, 5 * HOUR);
    buy(a, "a2", "2000000", 1_000_000n, 3 * HOUR);
    buy(a, "a3", "3000000", 1_000_000n, 1 * HOUR);
    buy(a, "a-old", "999999999", 990_000n, 30 * HOUR); // outside the window: in nothing
    buy(b, "b1", "4000000", 3_960_000n, 2 * HOUR);
    db.insertHolderSample(a, at(HOUR), [{ wallet: "h1", balance: 1n }, { wallet: "h2", balance: 1n }, { wallet: "h3", balance: 1n }]);
    clearStatsCache();
  }, 240_000);

  test("every coin carries the new fields; the numbers are the database's, the prices the pool's", async () => {
    const r = await list(`q=${tag}`);
    expect(r.status).toBe(200);
    expect(r.total).toBe(3);
    const by = new Map(r.coins.map((x) => [x.mint, x]));
    const A = by.get(a)!;
    const B = by.get(b)!;
    const C = by.get(c)!;
    expect([A.volume24hZats, A.trades24h]).toEqual(["6000000", 3]);
    expect([B.volume24hZats, B.trades24h]).toEqual(["4000000", 1]);
    expect([C.volume24hZats, C.trades24h, C.priceChange24hBps]).toEqual(["0", 0, null]);
    // First price 1 zat per token for A and 1 zat for B (4,000,000 zats paid for 3,960,000 tokens at 1%): change = pool price / 1 - 1.
    for (const x of [A, B]) {
      const expected = Math.round((Number(x.priceZec) / 1 - 1) * 10_000);
      expect(Math.abs((x.priceChange24hBps as number) - expected)).toBeLessThanOrEqual(1);
      expect(x.priceChange24hBps).toBeLessThan(0); // a fresh curve starts below 1 zat per token
    }
    for (const x of r.coins) {
      expect([x.stage, x.graduatedAt]).toEqual(["curve", null]);
      expect(x.rewards).toEqual({ paidSolanaZec: "0", paidShieldedZec: "0", epochs: 0 });
      expect(typeof x.priceZec).toBe("string");
    }
  });

  test("holders: the keeper's sample when there is one, never a wait for the chain otherwise, then the on-chain count", async () => {
    expect((await list(`q=${tag}`)).coins.find((x) => x.mint === a)!.holders).toBe(3); // the sample, at once
    // B and C have no sample: the first answers may be null while the background read runs; it lands within seconds.
    let counts: (number | null)[] = [];
    for (let i = 0; i < 40; i++) {
      const r = (await list(`q=${tag}`)).coins;
      counts = [r.find((x) => x.mint === b)!.holders, r.find((x) => x.mint === c)!.holders];
      if (counts.every((n) => n !== null)) break;
      await Bun.sleep(250);
    }
    expect(counts).toEqual([1, 1]); // the creator is the only holder of each; the pool's own vault is not a holder
  }, 30_000);

  test("sort: new, volume, mcap and progress each give their own order", async () => {
    const order = async (sort: string) => (await list(`q=${tag}&sort=${sort}`)).coins.map((x) => x.mint);
    expect(await order("new")).toEqual([c, b, a]);
    expect(await order("volume")).toEqual([a, b, c]);
    // B's bigger first buy put it highest on the curve; A and C bought the same and tie, so the newer (C) leads.
    expect(await order("mcap")).toEqual([b, c, a]);
    expect(await order("progress")).toEqual([b, c, a]);
  });

  test("stage, search and paging", async () => {
    expect((await list(`q=${tag}&stage=graduated`)).total).toBe(0);
    expect((await list(`q=${tag}&stage=curve`)).total).toBe(3);
    expect((await list(`q=${a.slice(0, 8)}`)).coins.map((x) => x.mint)).toEqual([a]); // a mint prefix
    expect((await list(`q=${tag.toLowerCase()}a`)).coins.map((x) => x.mint)).toEqual([a]); // a symbol, any case
    const page = await list(`q=${tag}&sort=volume&limit=1&offset=1`);
    expect(page.coins.map((x) => x.mint)).toEqual([b]);
    expect(page.total).toBe(3);
    expect((await list(`q=${tag}&offset=3`))).toMatchObject({ coins: [], total: 3 });
    expect((await list(`q=${tag}%27%3B%20DROP%20TABLE%20coins%3B--`)).total).toBe(0);
  });

  test("the old ways still work: no parameters, and all=1 beside the new ones", async () => {
    const plain = await list("");
    expect(plain.status).toBe(200);
    expect(plain.coins.length).toBeGreaterThanOrEqual(3);
    expect(plain.coins.length).toBeLessThanOrEqual(100);
    expect(plain.total).toBeGreaterThanOrEqual(plain.coins.length);
    const all = await list(`all=1&q=${tag}`);
    expect(all.coins.map((x) => x.mint).sort()).toEqual([a, b, c].sort());
  });

  test("the coin page has the same numbers as the list, and a holder count that is a number", async () => {
    const detail = async (m: string) => (await (await handleRequest(new Request(`http://pad.test/api/coins/${m}`))).json()) as ListedCoin & { recentTrades: unknown[] };
    const listed = new Map((await list(`q=${tag}`)).coins.map((x) => [x.mint, x]));
    for (const m of [a, b, c]) {
      const d = await detail(m);
      const l = listed.get(m)!;
      expect([d.volume24hZats, d.trades24h, d.graduatedAt]).toEqual([l.volume24hZats, l.trades24h, l.graduatedAt]);
      expect(typeof d.holders).toBe("number");
    }
    const dA = await detail(a);
    expect(dA.holders).toBe(3);
    expect(dA.recentTrades.length).toBe(4); // the page lists every recorded trade (the 30-hour-old one too); the 24-hour numbers do not
    expect(dA.trades24h).toBe(3);
  });

  test("a coin whose migration the pad has recorded is graduated, with the time it recorded; it sorts after the curve coins by progress", async () => {
    clearStatsCache();
    const before = ((await (await handleRequest(new Request("http://pad.test/api/stats?all=1"))).json()) as { graduated: number }).graduated;
    db.markCoinMigrated(c, Keypair.generate().publicKey.toBase58(), null); // what the keeper does once it has seen the move (the DAMM v2 pool itself is not needed to read the record)
    const recorded = db.getCoin(c)!.migratedAt!;
    const graduated = await list(`q=${tag}&stage=graduated`);
    expect(graduated.coins.map((x) => [x.mint, x.stage, x.graduatedAt])).toEqual([[c, "graduated", recorded]]);
    expect((await list(`q=${tag}&stage=curve`)).coins.map((x) => x.mint).sort()).toEqual([a, b].sort());
    expect((await list(`q=${tag}&sort=progress`)).coins.map((x) => x.mint)).toEqual([b, a, c]); // curve coins nearest graduation first, then the graduated one
    clearStatsCache();
    const after = ((await (await handleRequest(new Request("http://pad.test/api/stats?all=1"))).json()) as { graduated: number }).graduated;
    expect(after - before).toBe(1);
    const detail = (await (await handleRequest(new Request(`http://pad.test/api/coins/${c}`))).json()) as { stage: string; graduatedAt: string };
    expect([detail.stage, detail.graduatedAt]).toEqual(["graduated", recorded]);
  });

  test("stats: the board's counts and volume, from the same trades", async () => {
    clearStatsCache();
    const res = await handleRequest(new Request("http://pad.test/api/stats?all=1"));
    const s = (await res.json()) as { coins: number; graduated: number; volume24hZats: string; paidSolanaZats: string; paidShieldedZats: string; optIns: number };
    expect(res.status).toBe(200);
    expect(s.coins).toBeGreaterThanOrEqual(3);
    expect(BigInt(s.volume24hZats)).toBeGreaterThanOrEqual(10_000_000n);
  });
});

describe("a bad parameter costs the RPC nothing", () => {
  test("every refusal is answered before any RPC call, even with a coin whose pool view is not cached", async () => {
    // A launched coin nobody has read yet: its pool view is not in the 3 s cache, so listing the coins would have to ask the chain.
    const fresh = Keypair.generate().publicKey.toBase58();
    db.upsertCoin({ mint: fresh, name: "Cold", symbol: "COLD", imageUrl: "", description: "", creator: fresh, createdAt: new Date().toISOString(), feeBps: 100, poolId: Keypair.generate().publicKey.toBase58(), mintDecimals: 6, status: "launched" });
    // Every Connection method funnels into _rpcRequest, so one stub on the engine's own connection counts all of them.
    const conn = getConnection() as unknown as { _rpcRequest: (...a: unknown[]) => Promise<unknown> };
    const real = conn._rpcRequest;
    const realError = console.error;
    let calls = 0;
    conn._rpcRequest = async () => { calls++; throw new Error("no RPC in this test"); };
    try {
      for (const qs of ["sort=bogus", "stage=x", "limit=0", "offset=-1", "q=%00", "limit=1&limit=2"]) {
        const res = await handleRequest(new Request(`http://pad.test/api/coins?${qs}`));
        expect(res.status).toBe(400);
      }
      expect(calls).toBe(0);
      // The control: a valid request does ask the chain for that coin, and the stub proves the count would have seen it. Since v2.8.1 the list still
      // answers 200 from the database when that read fails (it answered a bare 500 before).
      console.error = () => {};
      const valid = await handleRequest(new Request("http://pad.test/api/coins?sort=new"));
      expect(valid.status).toBe(200);
      expect(calls).toBeGreaterThan(0);
    } finally {
      console.error = realError;
      conn._rpcRequest = real;
      db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: fresh });
    }
  });
});
