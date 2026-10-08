// The trades tape docs/API.md v2.6: GET /api/trades, GET /api/coins/:mint/trades and the Server-Sent Events stream
// GET /api/events/trades. The rows are read from the test database; the stream is read from the real Response body, and one test
// goes over a real socket (the address limit is by the client address a proxy forwards). No chain needed.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { handleRequest, startApiServer } from "../src/api";
import { clientIp } from "../src/api/common";
import * as db from "../src/db";
import {
  REPLAY_MAX, makeStreamLimiter, makeTradeHub, parseLastEventId, recentTrades, recentTradesOfCoin, streamLimiter, toFeedTrade, tradeEventStream, tradeHub,
} from "../src/tradeFeed";

const key = () => Keypair.generate().publicKey.toBase58();
const made: string[] = [];
let n = 0;

function launched(symbol: string, creator = key()): { mint: string; creator: string } {
  const mint = key();
  db.upsertCoin({ mint, name: symbol, symbol, imageUrl: "", description: "", creator, createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
  db.markCoinLaunched(mint, key());
  made.push(mint);
  return { mint, creator };
}

function trade(mint: string, wallet: string, over: Partial<db.TradeRow> = {}): db.TradeRow {
  const t: db.TradeRow = { sig: `feed-${Date.now()}-${n++}`, mint, side: "buy", wallet, amountToken: "1000000", amountZec: "10000", at: new Date().toISOString(), ...over };
  db.insertTrade(t);
  return t;
}

afterAll(() => {
  for (const m of made) for (const table of ["coins", "trades"]) db.getDb().query(`DELETE FROM ${table} WHERE mint = $m`).run({ $m: m });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads a stream until `until` says enough or `ms` pass; returns what it read as text. */
async function readSome(stream: ReadableStream<Uint8Array>, until: (text: string) => boolean, ms = 1500): Promise<{ text: string; reader: { cancel: () => Promise<void> } }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (!until(text) && Date.now() < deadline) {
    const got = await Promise.race([reader.read(), sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (got === null || got.done) break;
    text += dec.decode(got.value);
  }
  return { text, reader };
}

const events = (text: string) =>
  text.split("\n\n").filter((b) => b.includes("event: trade")).map((b) => ({ id: Number(/^id: (\d+)$/m.exec(b)![1]), data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) as ReturnType<typeof toFeedTrade> }));

describe("recent trades", () => {
  test("a row carries the coin's symbol and a dev tag for the creator's own wallet, nothing else", () => {
    const { mint, creator } = launched("DEVC");
    trade(mint, creator);
    trade(mint, key());
    const rows = recentTradesOfCoin(mint, 10);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.symbol === "DEVC" && r.mint === mint)).toBe(true);
    expect(rows.find((r) => r.wallet === creator)!.tags).toEqual(["dev"]);
    expect(rows.find((r) => r.wallet !== creator)!.tags).toEqual([]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["amountToken", "amountZec", "at", "mint", "side", "sig", "symbol", "tags", "wallet"]);
  });

  test("newest first by time, limited, and one coin's route holds only that coin's trades", () => {
    const a = launched("AAA");
    const b = launched("BBB");
    const base = Date.now() - 100_000;
    const t1 = trade(a.mint, key(), { at: new Date(base + 1000).toISOString() });
    const t2 = trade(b.mint, key(), { at: new Date(base + 3000).toISOString() });
    const t3 = trade(a.mint, key(), { at: new Date(base + 2000).toISOString() });
    expect(recentTradesOfCoin(a.mint, 10).map((r) => r.sig)).toEqual([t3.sig, t1.sig]);
    expect(recentTradesOfCoin(a.mint, 1).map((r) => r.sig)).toEqual([t3.sig]);
    expect(recentTrades(50, [a.mint, b.mint]).map((r) => r.sig)).toEqual([t2.sig, t3.sig, t1.sig]);
  });

  test("the board filter limits the tape to its coins; null lists every launched coin; an empty filter lists nothing", () => {
    const a = launched("FLT1");
    const b = launched("FLT2");
    const ta = trade(a.mint, key());
    const tb = trade(b.mint, key());
    expect(recentTrades(100, [a.mint]).map((r) => r.sig)).toContain(ta.sig);
    expect(recentTrades(100, [a.mint]).map((r) => r.sig)).not.toContain(tb.sig);
    expect(recentTrades(100, null).map((r) => r.sig)).toEqual(expect.arrayContaining([ta.sig, tb.sig]));
    expect(recentTrades(100, [])).toEqual([]);
  });

  test("a trade of a coin that is not launched is never on the tape", () => {
    const mint = key();
    db.upsertCoin({ mint, name: "P", symbol: "PND", imageUrl: "", description: "", creator: key(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
    made.push(mint);
    const t = trade(mint, key());
    expect(recentTrades(100, null).map((r) => r.sig)).not.toContain(t.sig);
    expect(recentTradesOfCoin(mint, 10)).toEqual([]);
  });

  test("a filter built from hostile mint strings is bound as values, never as SQL", () => {
    const a = launched("INJ");
    trade(a.mint, key());
    expect(recentTrades(10, ["x') OR 1=1 --", a.mint]).every((r) => r.mint === a.mint)).toBe(true);
    expect(recentTrades(10, ["' OR '1'='1"])).toEqual([]);
  });
});

describe("the hub", () => {
  test("a subscriber hears only trades recorded after it subscribed, once each, in arrival order", () => {
    const { mint } = launched("HUB1");
    trade(mint, key()); // before
    const heard: number[] = [];
    const sub = makeTradeHub(60_000).subscribe(null, (nn) => heard.push(nn), null);
    expect(heard).toEqual([]);
    sub.close();
    const hub = makeTradeHub(60_000);
    const got: { n: number; sig: string }[] = [];
    const s2 = hub.subscribe(new Set([mint]), (nn, t) => got.push({ n: nn, sig: t.sig }), null);
    const t1 = trade(mint, key());
    const t2 = trade(mint, key());
    hub.poke();
    hub.poke(); // nothing new: nothing sent twice
    expect(got.map((g) => g.sig)).toEqual([t1.sig, t2.sig]);
    expect(got[0]!.n).toBeLessThan(got[1]!.n);
    s2.close();
    trade(mint, key());
    hub.poke();
    expect(got.length).toBe(2);
    expect(hub.listeners()).toBe(0);
  });

  test("a subscriber with a coin filter hears only that coin; one without hears them all", () => {
    const a = launched("HUBA");
    const b = launched("HUBB");
    const hub = makeTradeHub(60_000);
    const onlyA: string[] = [];
    const every: string[] = [];
    const s1 = hub.subscribe(new Set([a.mint]), (_n, t) => onlyA.push(t.mint), null);
    const s2 = hub.subscribe(null, (_n, t) => every.push(t.mint), null);
    trade(a.mint, key());
    trade(b.mint, key());
    hub.poke();
    expect(onlyA).toEqual([a.mint]);
    expect(every.filter((m) => m === a.mint || m === b.mint)).toEqual([a.mint, b.mint]);
    s1.close();
    s2.close();
  });

  test("polls by itself once a second would be too slow for a test: with a short interval a trade recorded elsewhere arrives without a poke", async () => {
    const { mint } = launched("POLL");
    const hub = makeTradeHub(15);
    const got: string[] = [];
    const sub = hub.subscribe(new Set([mint]), (_n, t) => got.push(t.sig), null);
    const t = trade(mint, key());
    await sleep(80);
    expect(got).toEqual([t.sig]);
    sub.close();
  });

  test("Last-Event-ID replays what was missed (oldest first, only the coins asked for), then carries on without repeating", () => {
    const a = launched("RPLA");
    const b = launched("RPLB");
    const hub = makeTradeHub(60_000);
    const keep = hub.subscribe(null, () => {}, null); // someone is listening, as in production
    const first = trade(a.mint, key());
    hub.poke();
    const seen = db.listFeedTradesAfter(0, 1_000_000, [a.mint]).find((r) => r.sig === first.sig)!.n;
    const m1 = trade(a.mint, key());
    const other = trade(b.mint, key());
    const m2 = trade(a.mint, key());
    const got: string[] = [];
    const sub = hub.subscribe(new Set([a.mint]), (_n, t) => got.push(t.sig), seen);
    expect(got).toEqual([m1.sig, m2.sig]); // missed ones, not b's
    const after = trade(a.mint, key());
    hub.poke();
    expect(got).toEqual([m1.sig, m2.sig, after.sig]);
    expect(got).not.toContain(other.sig);
    sub.close();
    keep.close();
  });

  test(`a reconnect after a long gap gets the newest ${REPLAY_MAX} missed trades, still oldest first`, () => {
    const { mint } = launched("GAP");
    const hub = makeTradeHub(60_000);
    const keep = hub.subscribe(null, () => {}, null);
    const sigs: string[] = [];
    for (let i = 0; i < REPLAY_MAX + 20; i++) sigs.push(trade(mint, key()).sig);
    hub.poke();
    const got: string[] = [];
    const sub = hub.subscribe(new Set([mint]), (_n, t) => got.push(t.sig), 0);
    expect(got).toEqual(sigs.slice(-REPLAY_MAX));
    sub.close();
    keep.close();
  });

  test("a last-event-id from the future (a database that was reset) replays nothing", () => {
    const { mint } = launched("FUT");
    const hub = makeTradeHub(60_000);
    const got: string[] = [];
    const sub = hub.subscribe(new Set([mint]), (_n, t) => got.push(t.sig), 9_999_999_999);
    expect(got).toEqual([]);
    sub.close();
  });

  test("a listener that throws is dropped; the others still hear the trade, and the timer stops with the last listener", () => {
    const { mint } = launched("THROW");
    const hub = makeTradeHub(60_000);
    const heard: string[] = [];
    hub.subscribe(new Set([mint]), () => {
      throw new Error("closed");
    }, null);
    const s2 = hub.subscribe(new Set([mint]), (_n, t) => heard.push(t.sig), null);
    const t = trade(mint, key());
    hub.poke();
    expect(heard).toEqual([t.sig]);
    expect(hub.listeners()).toBe(1);
    s2.close();
    expect(hub.listeners()).toBe(0);
  });
});

describe("the stream limiter", () => {
  test("per address and in all; a slot given back is free again; giving it back twice frees one", () => {
    const l = makeStreamLimiter(2, 3);
    const a1 = l.acquire("1.1.1.1")!;
    const a2 = l.acquire("1.1.1.1")!;
    expect(l.acquire("1.1.1.1")).toBeNull(); // 2 per address
    const b1 = l.acquire("2.2.2.2")!;
    expect(l.acquire("3.3.3.3")).toBeNull(); // 3 in all
    expect(l.open()).toBe(3);
    a1();
    a1();
    expect(l.open()).toBe(2);
    expect(l.acquire("1.1.1.1")).not.toBeNull();
    void a2;
    void b1;
  });

  test("clients with no known address share one bucket instead of getting unlimited streams", () => {
    const l = makeStreamLimiter(1, 10);
    expect(l.acquire(null)).not.toBeNull();
    expect(l.acquire(null)).toBeNull();
  });
});

describe("Last-Event-ID and the client address", () => {
  test("only a plain decimal integer is an id", () => {
    expect(parseLastEventId("42")).toBe(42);
    expect(parseLastEventId("0")).toBe(0);
    for (const bad of [null, "", "-1", "1.5", "1e3", "0x10", " 5", "5 ", "abc", "9".repeat(16), "5;6"]) expect(parseLastEventId(bad)).toBeNull();
  });

  test("behind the proxy the client is the LAST forwarded address; the header is believed only from a loopback peer; junk falls back to the peer", () => {
    expect(clientIp("203.0.113.9", "127.0.0.1")).toBe("203.0.113.9");
    expect(clientIp("6.6.6.6, 203.0.113.9", "::1")).toBe("203.0.113.9"); // what the client wrote is first, what the proxy added last
    expect(clientIp("2001:db8::1", "::ffff:127.0.0.1")).toBe("2001:db8:0:0::/64"); // an IPv6 client is counted by its /64 (audit S6, lens 5-4)
    expect(clientIp("203.0.113.9", "198.51.100.7")).toBe("198.51.100.7"); // a direct caller cannot choose its address
    expect(clientIp(null, "198.51.100.7")).toBe("198.51.100.7");
    expect(clientIp("not an ip!", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIp("", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIp("1.2.3.4", null)).toBeNull();
  });
});

describe("the event stream body", () => {
  test("starts with retry, then one `trade` event per recorded trade with its arrival number as id and a FeedTrade as data", async () => {
    const { mint, creator } = launched("STRM");
    let closed = 0;
    const hub = makeTradeHub(60_000);
    const stream = tradeEventStream({ hub, mints: new Set([mint]), lastEventId: null, onClose: () => closed++ });
    const t = trade(mint, creator, { side: "sell" });
    hub.poke();
    const { text, reader } = await readSome(stream, (s) => s.includes("event: trade"));
    expect(text.startsWith("retry: 3000\n\n")).toBe(true);
    const ev = events(text);
    expect(ev.length).toBe(1);
    expect(ev[0]!.data).toMatchObject({ sig: t.sig, mint, symbol: "STRM", side: "sell", wallet: creator, tags: ["dev"], amountZec: "10000" });
    expect(ev[0]!.id).toBeGreaterThan(0);
    await reader.cancel();
    expect(closed).toBe(1);
    expect(hub.listeners()).toBe(0);
  });

  test("a comment goes out every heartbeat so a quiet stream is not mistaken for a dead one", async () => {
    const { mint } = launched("BEAT");
    const stream = tradeEventStream({ hub: makeTradeHub(60_000), mints: new Set([mint]), lastEventId: null, onClose: () => {}, heartbeatMs: 20 });
    const { text, reader } = await readSome(stream, (s) => (s.match(/: keep-alive/g) ?? []).length >= 2);
    expect((text.match(/: keep-alive\n\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
    await reader.cancel();
  });

  test("the server ends a stream after its lifetime and gives the slot back once", async () => {
    const { mint } = launched("LIFE");
    let closed = 0;
    const hub = makeTradeHub(60_000);
    const stream = tradeEventStream({ hub, mints: new Set([mint]), lastEventId: null, onClose: () => closed++, maxLifetimeMs: 40 });
    const reader = stream.getReader();
    let done = false;
    for (let i = 0; i < 20 && !done; i++) done = (await Promise.race([reader.read(), sleep(200).then(() => ({ done: false, value: undefined }))])).done === true;
    expect(done).toBe(true);
    expect(closed).toBe(1);
    expect(hub.listeners()).toBe(0);
  });

  test("a client that never reads is dropped once too many events are queued, and its slot is given back", async () => {
    const { mint } = launched("SLOW");
    let closed = 0;
    const hub = makeTradeHub(60_000);
    tradeEventStream({ hub, mints: new Set([mint]), lastEventId: null, onClose: () => closed++, maxQueued: 3, dropGraceMs: 50 });
    for (let i = 0; i < 12; i++) trade(mint, key());
    hub.poke();
    expect(closed).toBe(0); // not inside the burst: a reading client would have had no turn to drain yet
    await sleep(150);
    expect(closed).toBe(1); // still unread a moment later: gone
    expect(hub.listeners()).toBe(0);
  });

  test("a burst larger than the queue limit in one poll does not drop a client that reads it: the drop waits a moment for the queue to drain (S4 ST-SSE-05)", async () => {
    const { mint } = launched("BURST");
    let closed = 0;
    const hub = makeTradeHub(60_000);
    const stream = tradeEventStream({ hub, mints: new Set([mint]), lastEventId: null, onClose: () => closed++, maxQueued: 3, dropGraceMs: 300 });
    const sigs = Array.from({ length: 12 }, () => trade(mint, key()).sig);
    hub.poke();
    expect(closed).toBe(0);
    const { text, reader } = await readSome(stream, (s) => s.includes(sigs[11]!), 2_000);
    expect(events(text).map((e) => e.data.sig)).toEqual(sigs);
    await sleep(450);
    expect([closed, hub.listeners()]).toEqual([0, 1]);
    await reader.cancel();
    expect(closed).toBe(1);
  });

  test("a reconnecting stream replays the missed trades right after retry", async () => {
    const { mint } = launched("RECON");
    const hub = makeTradeHub(60_000);
    const keep = hub.subscribe(null, () => {}, null);
    const t0 = trade(mint, key());
    hub.poke();
    const id0 = db.listFeedTradesAfter(0, 1_000_000, [mint]).find((r) => r.sig === t0.sig)!.n;
    const t1 = trade(mint, key());
    hub.poke();
    const stream = tradeEventStream({ hub, mints: new Set([mint]), lastEventId: id0, onClose: () => {} });
    const { text, reader } = await readSome(stream, (s) => s.includes(t1.sig));
    expect(events(text).map((e) => e.data.sig)).toEqual([t1.sig]);
    await reader.cancel();
    keep.close();
  });
});

describe("GET /api/trades and GET /api/coins/:mint/trades", () => {
  const get = async (path: string, init?: RequestInit) => {
    const res = await handleRequest(new Request(`http://pad.test/api${path}`, init));
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as { trades?: ReturnType<typeof toFeedTrade>[]; error?: string; field?: string } };
  };

  test("answers the newest trades; limit defaults to 30 and is 1..100; every row is a FeedTrade", async () => {
    const { mint } = launched("ROUTE");
    for (let i = 0; i < 35; i++) trade(mint, key(), { at: new Date(Date.now() - 1000 * (40 - i)).toISOString() });
    const r = await get(`/coins/${mint}/trades`);
    expect(r.status).toBe(200);
    expect(r.body.trades!.length).toBe(30);
    expect((await get(`/coins/${mint}/trades?limit=3`)).body.trades!.length).toBe(3);
    expect((await get(`/coins/${mint}/trades?limit=100`)).body.trades!.length).toBe(35);
    const sorted = [...r.body.trades!].sort((a, b) => (a.at < b.at ? 1 : -1));
    expect(r.body.trades!.map((t) => t.sig)).toEqual(sorted.map((t) => t.sig));
    const all = await get("/trades?all=1&limit=5");
    expect(all.status).toBe(200);
    expect(all.body.trades!.length).toBe(5);
  });

  test("a bad limit is 400 bad_request field limit; an unknown mint is 404; neither echoes what was sent", async () => {
    const { mint } = launched("BADLIM");
    for (const l of ["0", "101", "-1", "1.5", "abc", "", "1e2", "9999999999"]) {
      const r = await get(`/coins/${mint}/trades?limit=${l}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field: "limit" });
      expect((await get(`/trades?limit=${l}`)).status).toBe(400);
    }
    expect((await get(`/coins/${mint}/trades?limit=5&limit=6`)).status).toBe(400);
    for (const m of [key(), "garbage", "%E0%A4%A", "launch-tx"]) expect((await get(`/coins/${m}/trades`)).body).toEqual({ error: "unknown_mint" });
  });

  test("the board filter is the featured list, like GET /coins: all=1 lifts it", async () => {
    // The route reads config.api.featuredMints (unset here): with none set every launched coin is listed either way.
    const { mint } = launched("BOARD");
    const sig = trade(mint, key()).sig;
    expect((await get("/trades?limit=100")).body.trades!.map((t) => t.sig)).toContain(sig);
    expect((await get("/trades?all=1&limit=100")).body.trades!.map((t) => t.sig)).toContain(sig);
  });
});

describe("GET /api/events/trades", () => {
  const open = (qs = "", headers: Record<string, string> = {}, ip: string | null = "198.18.0.1", keepOpen?: () => void) =>
    handleRequest(new Request(`http://pad.test/api/events/trades${qs}`, { headers }), { ip, keepOpen });

  test("an event stream with the headers a browser and a reverse proxy need, and the idle timeout switched off for it", async () => {
    let kept = 0;
    const res = await open("", {}, "198.18.0.2", () => kept++);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-pad-mode")).toBeTruthy();
    expect(kept).toBe(1);
    await res.body!.cancel();
  });

  test("a trade recorded after the stream opened arrives on it, for the coin asked for only", async () => {
    const a = launched("SSEA");
    const b = launched("SSEB");
    const res = await open(`?mint=${a.mint}`, {}, "198.18.0.3");
    trade(b.mint, key());
    const want = trade(a.mint, key());
    tradeHub.poke();
    const { text, reader } = await readSome(res.body!, (s) => s.includes(want.sig));
    expect(events(text).map((e) => e.data.sig)).toEqual([want.sig]);
    await reader.cancel();
  });

  test("Last-Event-ID in the request replays; a header that is not an integer is ignored", async () => {
    const { mint } = launched("SSEL");
    const keep = open(`?mint=${mint}`, {}, "198.18.0.4");
    const t1 = trade(mint, key());
    tradeHub.poke();
    const id1 = db.listFeedTradesAfter(0, 1_000_000, [mint]).find((r) => r.sig === t1.sig)!.n;
    const t2 = trade(mint, key());
    tradeHub.poke();
    const re = await open(`?mint=${mint}`, { "last-event-id": String(id1) }, "198.18.0.5");
    const { text, reader } = await readSome(re.body!, (s) => s.includes(t2.sig));
    expect(events(text).map((e) => e.data.sig)).toEqual([t2.sig]);
    await reader.cancel();
    const junk = await open(`?mint=${mint}`, { "last-event-id": "1; DROP" }, "198.18.0.6");
    const j = await readSome(junk.body!, () => false, 100);
    expect(events(j.text)).toEqual([]);
    await j.reader.cancel();
    await (await keep).body!.cancel();
  });

  test("the fifth stream from one address is 429 rate_limited with retry-after; another address is fine; a slot given back is free again", async () => {
    const ip = "198.18.0.77";
    const opened = [];
    for (let i = 0; i < 4; i++) opened.push(await open("", {}, ip));
    expect(opened.every((r) => r.status === 200)).toBe(true);
    const fifth = await open("", {}, ip);
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("retry-after")).toBe("5");
    expect(await fifth.json()).toEqual({ error: "rate_limited" });
    const other = await open("", {}, "198.18.0.78");
    expect(other.status).toBe(200);
    await other.body!.cancel();
    await opened[0]!.body!.cancel();
    const again = await open("", {}, ip);
    expect(again.status).toBe(200);
    for (const r of [...opened.slice(1), again]) await r.body!.cancel();
    expect(streamLimiter.open()).toBeGreaterThanOrEqual(0);
  });

  test("an unknown mint is 404 and takes no slot; so is a mint that is not a key", async () => {
    const before = streamLimiter.open();
    for (const m of [key(), "garbage", "%E0%A4%A"]) {
      const res = await open(`?mint=${m}`, {}, "198.18.0.90");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_mint" });
    }
    expect(streamLimiter.open()).toBe(before);
    const twice = await open("?mint=a&mint=b", {}, "198.18.0.90");
    expect(twice.status).toBe(400);
  });

  test("only GET opens a stream", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/events/trades", { method: "POST", body: "{}" }), { ip: "198.18.0.91" });
    expect(res.status).toBe(404);
  });
});

describe("over a real socket", () => {
  test("behind the proxy the limit is by the forwarded address, a trade recorded through the API's own hub arrives, and a closed connection gives its slot back", async () => {
    const server = startApiServer(0);
    try {
      const base = `http://127.0.0.1:${server.port}/api`;
      const { mint } = launched("SOCK");
      const baseline = streamLimiter.open();
      const streams: Response[] = [];
      const ctl = new AbortController();
      for (let i = 0; i < 4; i++) streams.push(await fetch(`${base}/events/trades?mint=${mint}`, { headers: { "x-forwarded-for": "203.0.113.50" }, signal: ctl.signal }));
      expect(streams.map((s) => s.status)).toEqual([200, 200, 200, 200]);
      expect(streams[0]!.headers.get("content-type")).toContain("text/event-stream");
      const refused = await fetch(`${base}/events/trades?mint=${mint}`, { headers: { "x-forwarded-for": "203.0.113.50" } });
      expect(refused.status).toBe(429);
      const elsewhere = await fetch(`${base}/events/trades?mint=${mint}`, { headers: { "x-forwarded-for": "203.0.113.51" }, signal: ctl.signal });
      expect(elsewhere.status).toBe(200);
      expect(streamLimiter.open()).toBe(baseline + 5);

      const want = trade(mint, key());
      const { text, reader } = await readSome(streams[1]!.body!, (s) => s.includes(want.sig), 3000); // the 1 s poll finds it
      expect(events(text).map((e) => e.data.sig)).toEqual([want.sig]);
      await reader.cancel().catch(() => {});

      ctl.abort();
      for (let i = 0; i < 50 && streamLimiter.open() > baseline; i++) await sleep(40);
      expect(streamLimiter.open()).toBe(baseline);
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
