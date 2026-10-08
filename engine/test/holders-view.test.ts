// GET /api/coins/:mint/holders docs/API.md v2.6: the book of holders (the newer of the keeper's sample and a background
// on-chain read, never a read inside a request), and the ranked page built from it (tags, shares, totals). No chain needed: the
// book takes its sources as arguments. The route's own parameter handling is in trader-hostile.test.ts; real pools in trader-live.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BOOK_ROWS, HOLDER_BOOK_RETRY_MS, HOLDER_BOOK_SAMPLE_REUSE_MS, HOLDER_BOOK_TTL_MS, MAX_BOOK_READS, makeBook, makeHolderBooks, type BookRow,
} from "../src/dbc/holderBook";
import { buildHoldersView, pctOf } from "../src/dbc/holdersView";
import type { PoolHolding } from "../src/dbc/poolVaults";

const row = (wallet: string, balance: bigint): BookRow => ({ wallet, balance });
const iso = (ms: number) => new Date(ms).toISOString();

describe("makeBook", () => {
  test("largest first, ties by wallet, the exact count, the creator's balance", () => {
    const b = makeBook([row("b", 5n), row("a", 5n), row("c", 9n), row("d", 1n)], iso(1), "chain", "d");
    expect(b.rows.map((r) => r.wallet)).toEqual(["c", "a", "b", "d"]);
    expect([b.count, b.creatorBalance, b.source, b.asOf]).toEqual([4, 1n, "chain", iso(1)]);
  });

  test("keeps the BOOK_ROWS largest, counts them all, and takes the creator's balance from the whole list even when it is below the cut", () => {
    const all = Array.from({ length: BOOK_ROWS + 200 }, (_, i) => row(`w${String(i).padStart(5, "0")}`, BigInt(10_000 - i)));
    const creator = all[all.length - 1]!.wallet; // the smallest of 1,200
    const b = makeBook(all, iso(1), "keeper_sample", creator);
    expect(b.rows.length).toBe(BOOK_ROWS);
    expect(b.count).toBe(BOOK_ROWS + 200);
    expect(b.rows.some((r) => r.wallet === creator)).toBe(false);
    expect(b.creatorBalance).toBe(BigInt(10_000 - (BOOK_ROWS + 199)));
  });

  test("a creator that holds nothing is 0; no creator is 0; the input list is not reordered", () => {
    const all = [row("b", 2n), row("a", 3n)];
    expect(makeBook(all, iso(1), "chain", "nobody").creatorBalance).toBe(0n);
    expect(makeBook(all, iso(1), "chain", null).creatorBalance).toBe(0n);
    expect(all.map((r) => r.wallet)).toEqual(["b", "a"]);
  });
});

describe("makeHolderBooks", () => {
  let t = 1_000_000;
  let reads: string[] = [];
  let samples: Record<string, { takenAt: string; holders: BookRow[] } | null> = {};
  let release: Record<string, (rows: BookRow[]) => void> = {};
  let failWith: Error | null = null;
  let sampleLookups = 0;
  const books = () =>
    makeHolderBooks({
      now: () => t,
      sample: (mint) => (sampleLookups++, samples[mint] ?? null),
      creatorOf: () => "creator",
      read: (mint) => {
        reads.push(mint);
        if (failWith) return Promise.reject(failWith);
        return new Promise<BookRow[]>((resolve) => (release[mint] = resolve));
      },
    });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    t = 1_000_000;
    reads = [];
    samples = {};
    release = {};
    failWith = null;
    sampleLookups = 0;
    spyOn(console, "error").mockImplementation(() => {});
  });

  test("with a keeper sample the book is there at once, and a background read starts; when it lands the newer chain book wins", async () => {
    samples.m = { takenAt: iso(t - 3_600_000), holders: [row("h1", 10n)] };
    const b = books();
    expect(b.known("m")?.source).toBe("keeper_sample");
    expect(b.known("m")?.asOf).toBe(iso(t - 3_600_000));
    expect(reads).toEqual(["m"]); // one read, started by the first look
    expect(b.known("m")?.source).toBe("keeper_sample"); // still pending: the sample is served
    release.m!([row("h1", 10n), row("h2", 20n)]);
    await settle();
    const now = b.known("m")!;
    expect([now.source, now.count, now.rows[0]!.wallet]).toEqual(["chain", 2, "h2"]);
    expect(reads).toEqual(["m"]); // inside the window: no second read
  });

  test("a sample that is newer than the last on-chain read is served instead of it", async () => {
    const b = books();
    const first = b.get("m");
    release.m!([row("h1", 1n)]);
    expect((await first).source).toBe("chain");
    t += 5_000;
    samples.m = { takenAt: iso(t + 1_000), holders: [row("h9", 9n)] };
    t += HOLDER_BOOK_SAMPLE_REUSE_MS; // the database lookup is reused this long
    expect(b.known("m")?.source).toBe("keeper_sample");
  });

  test("the first request for a coin with neither waits for the first on-chain read; the second is served from memory", async () => {
    const b = books();
    let done = false;
    const first = b.get("m").then((x) => ((done = true), x));
    await settle();
    expect(done).toBe(false);
    release.m!([row("h1", 7n)]);
    expect((await first).rows[0]!.balance).toBe(7n);
    expect((await b.get("m")).count).toBe(1);
    expect(reads).toEqual(["m"]);
  });

  test("a window passed starts one new read in the background and the last book is served meanwhile; never two at once", async () => {
    const b = books();
    const first = b.get("m");
    release.m!([row("h1", 1n)]);
    await first;
    t += HOLDER_BOOK_TTL_MS - 1;
    b.known("m");
    expect(reads.length).toBe(1);
    t += 2;
    expect(b.known("m")?.count).toBe(1); // the old book, while
    expect(b.known("m")?.count).toBe(1);
    expect(reads.length).toBe(2); // exactly one more
    release.m!([row("h1", 1n), row("h2", 2n)]);
    await settle();
    expect(b.known("m")?.count).toBe(2);
  });

  test("a failed read is not tried again at once but after HOLDER_BOOK_RETRY_MS, get() rejects for a coin with nothing, and the error is logged", async () => {
    failWith = new Error("rpc down");
    const b = books();
    await expect(b.get("m")).rejects.toThrow("rpc down");
    expect(b.known("m")).toBeNull();
    expect(reads.length).toBe(1);
    t += HOLDER_BOOK_RETRY_MS - 1;
    b.known("m");
    expect(reads.length).toBe(1);
    t += 2;
    b.known("m");
    expect(reads.length).toBe(2);
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("a failed refresh keeps serving the last good book", async () => {
    const b = books();
    const first = b.get("m");
    release.m!([row("h1", 3n)]);
    await first;
    failWith = new Error("rpc down");
    t += HOLDER_BOOK_TTL_MS + 1;
    expect(b.known("m")?.count).toBe(1);
    await settle();
    expect(b.known("m")?.count).toBe(1);
  });

  test(`at most ${MAX_BOOK_READS} background reads run at once; a read that hangs past its window stops counting`, async () => {
    for (const m of ["c1", "c2", "c3", "c4", "c5", "c6"]) samples[m] = { takenAt: iso(t), holders: [] };
    const b = books();
    for (const m of ["c1", "c2", "c3", "c4", "c5", "c6"]) b.known(m);
    expect(reads).toEqual(["c1", "c2", "c3", "c4"]);
    t += HOLDER_BOOK_TTL_MS + 1; // c1..c4 hung past their window
    b.known("c5");
    expect(reads.includes("c5")).toBe(true);
  });

  test("the database lookup of a sample is reused for HOLDER_BOOK_SAMPLE_REUSE_MS, so a hot route does not parse a large sample per request", () => {
    samples.m = { takenAt: iso(t), holders: [row("h1", 1n)] };
    const b = books();
    for (let i = 0; i < 50; i++) b.known("m");
    expect(sampleLookups).toBe(1);
    t += HOLDER_BOOK_SAMPLE_REUSE_MS + 1;
    b.known("m");
    expect(sampleLookups).toBe(2);
  });
});

describe("pctOf", () => {
  test("a share of supply in percent, rounded down to 4 decimals, exact for u64-sized amounts", () => {
    const supply = 10n ** 15n;
    expect(pctOf(supply, supply)).toBe(100);
    expect(pctOf(supply / 4n, supply)).toBe(25);
    expect(pctOf(123_456_789_012_345n, supply)).toBe(12.3456);
    expect(pctOf(1n, supply)).toBe(0);
    expect(pctOf(0n, supply)).toBe(0);
    expect(pctOf(5n, 0n)).toBe(0);
    expect(pctOf(99_999n * 10n ** 6n, supply)).toBe(0.0099); // 0.009999..., not rounded up to 0.01
  });
});

describe("buildHoldersView", () => {
  const supply = 1_000_000n;
  const pool = (account: string, balance: bigint, kind: "curve" | "pool" = "curve"): PoolHolding => ({ account, balance, kind, label: kind === "curve" ? "Meteora bonding curve" : "Meteora DAMM v2 pool" });
  const base = (over: Partial<Parameters<typeof buildHoldersView>[0]> = {}) => ({
    creator: "dev", supply,
    book: makeBook([row("dev", 100_000n), row("w1", 200_000n), row("w2", 50_000n), row("w3", 10_000n)], iso(5), "keeper_sample", "dev"),
    pools: [pool("vault1", 600_000n)] as PoolHolding[] | null,
    limit: 20, offset: 0, ...over,
  });

  test("ranks the pool and the wallets together, biggest first, with tags and shares of total supply", () => {
    const v = buildHoldersView(base());
    expect(v.holders.map((h) => [h.rank, h.wallet, h.balance, h.pct, h.tags])).toEqual([
      [1, "vault1", "600000", 60, ["pool"]],
      [2, "w1", "200000", 20, []],
      [3, "dev", "100000", 10, ["dev"]],
      [4, "w2", "50000", 5, []],
      [5, "w3", "10000", 1, []],
    ]);
    expect(v.holders[0]!.label).toBe("Meteora bonding curve");
    expect(v.holders[1]!.label).toBeUndefined();
  });

  test("totals: holders are the wallets (a pool is not one), top 10 leaves the pool out, dev and pool are shares of supply", () => {
    const v = buildHoldersView(base());
    expect(v).toMatchObject({ total: 5, holdersCount: 4, top10Pct: 36, devPct: 10, poolPct: 60, supply: "1000000", asOf: iso(5), source: "keeper_sample" });
  });

  test("the only tags are dev and pool: nothing marks a wallet as one that opted in to shielded delivery (v2.9), and nothing counts them", () => {
    const v = buildHoldersView(base());
    expect(v.holders.flatMap((h) => h.tags).sort()).toEqual(["dev", "pool"]);
    expect(v.holders.find((h) => h.wallet === "dev")!.tags).toEqual(["dev"]);
    expect(v.holders.find((h) => h.wallet === "vault1")!.tags).toEqual(["pool"]);
    expect(JSON.stringify(v)).not.toMatch(/opt/i);
  });

  test("top10Pct counts only the ten largest wallets", () => {
    const wallets = Array.from({ length: 15 }, (_, i) => row(`w${i}`, BigInt(1_000 * (i + 1))));
    const v = buildHoldersView(base({ book: makeBook(wallets, iso(5), "chain", null), pools: [] }));
    expect(v.top10Pct).toBe(pctOf(6_000n + 7_000n + 8_000n + 9_000n + 10_000n + 11_000n + 12_000n + 13_000n + 14_000n + 15_000n, supply));
  });

  test("unreadable pool vaults (null) leave their rows and their share out instead of guessing: poolPct is null", () => {
    const v = buildHoldersView(base({ pools: null }));
    expect(v.poolPct).toBeNull();
    expect(v.holders.some((h) => h.tags.includes("pool"))).toBe(false);
    expect(v.total).toBe(4);
  });

  test("no pool vault holding anything is poolPct 0 (a graduated coin whose curve is empty)", () => {
    expect(buildHoldersView(base({ pools: [] })).poolPct).toBe(0);
  });

  test("two pool rows (a graduated coin still holds some on the curve vault): both ranked, both pool, poolPct is their sum", () => {
    const v = buildHoldersView(base({ pools: [pool("damm", 300_000n, "pool"), pool("curve", 1_000n)] }));
    expect(v.holders.filter((h) => h.tags.includes("pool")).map((h) => h.label)).toEqual(["Meteora DAMM v2 pool", "Meteora bonding curve"]);
    expect(v.poolPct).toBe(30.1);
    expect(v.total).toBe(6);
  });

  test("paging: ranks continue from the offset, an offset past the end is an empty page with the same totals", () => {
    const first = buildHoldersView(base({ limit: 2, offset: 0 }));
    const second = buildHoldersView(base({ limit: 2, offset: 2 }));
    expect(first.holders.map((h) => h.rank)).toEqual([1, 2]);
    expect(second.holders.map((h) => h.rank)).toEqual([3, 4]);
    const past = buildHoldersView(base({ limit: 20, offset: 9_999 }));
    expect(past.holders).toEqual([]);
    expect([past.total, past.holdersCount]).toEqual([5, 4]);
  });

  test("equal balances are ordered by wallet, so a page never repeats or skips a wallet", () => {
    const tied = makeBook([row("c", 5n), row("a", 5n), row("b", 5n)], iso(1), "chain", null);
    const all = buildHoldersView(base({ book: tied, pools: [], limit: 20 })).holders.map((h) => h.wallet);
    expect(all).toEqual(["a", "b", "c"]);
    const pages = [0, 1, 2].map((o) => buildHoldersView(base({ book: tied, pools: [], limit: 1, offset: o })).holders[0]!.wallet);
    expect(pages).toEqual(all);
  });

  test("an empty coin (no holder, no pool) is an empty page with zero totals", () => {
    const v = buildHoldersView(base({ book: makeBook([], iso(1), "chain", "dev"), pools: [] }));
    expect(v).toMatchObject({ holders: [], total: 0, holdersCount: 0, top10Pct: 0, devPct: 0, poolPct: 0 });
  });

  test("no row carries anything but a rank, a wallet, a balance, a share, tags and a label: no Zcash address, no opt-in time", () => {
    const v = buildHoldersView(base());
    for (const h of v.holders) expect(Object.keys(h).every((k) => ["rank", "wallet", "balance", "pct", "tags", "label"].includes(k))).toBe(true);
    expect(Object.keys(v).sort()).toEqual(["asOf", "devPct", "holders", "holdersCount", "poolPct", "source", "supply", "top10Pct", "total"]);
  });
});
