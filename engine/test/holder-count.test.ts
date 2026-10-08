// The holder count of the public views never waits for the chain (audit S2-11, stress D7): the keeper's newest sample first,
// else an on-chain count read in the background at most once per window per coin. The counter is built with a fake read
// and a fake clock, so no RPC and no sleeping.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import {
  HOLDER_COUNT_TTL_DEFAULT_MS, HOLDER_COUNT_TTL_FLOOR_MS, HOLDER_COUNT_TTL_MS, HOLDER_RETRY_MS, HOLDER_SAMPLE_REUSE_MS, MAX_BACKGROUND_READS, holderCountTtlMs, makeHolderCounter,
} from "../src/dbc/holderCount";

const mint = () => Keypair.generate().publicKey.toBase58();

/** A read that stays open until the test settles it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function rig(samples: Record<string, number> = {}) {
  const clock = { t: 1_000_000 };
  const reads: { mint: string; d: ReturnType<typeof deferred<number>> }[] = [];
  let sampleLookups = 0;
  const counter = makeHolderCounter({
    now: () => clock.t,
    read: (m) => {
      const d = deferred<number>();
      reads.push({ mint: m, d });
      return d.promise;
    },
    sample: (m) => {
      sampleLookups++;
      return samples[m] ?? null;
    },
  });
  return { clock, reads, counter, sampleLookups: () => sampleLookups };
}

const tick = () => new Promise((r) => setTimeout(r, 0)); // lets promise callbacks run

// A failed read is logged, which this file does not want in its output.
const realError = console.error;
const logged: string[] = [];
beforeEach(() => { logged.length = 0; console.error = (...a: unknown[]) => { logged.push(a.join(" ")); }; });
afterEach(() => { console.error = realError; });

describe("holder counter: the keeper's sample comes first", () => {
  test("a coin with a sample is answered from it and the chain is never read", () => {
    const m = mint();
    const { counter, reads } = rig({ [m]: 134 });
    expect(counter.known(m)).toBe(134);
    expect(counter.known(m)).toBe(134);
    expect(reads.length).toBe(0);
  });

  test("a sample of 0 holders is a count, not 'no sample'", () => {
    const m = mint();
    const { counter, reads } = rig({ [m]: 0 });
    expect(counter.known(m)).toBe(0);
    expect(reads.length).toBe(0);
  });

  test("the database is asked once per reuse window per coin, even for coins that have no sample", () => {
    const withSample = mint();
    const without = mint();
    const { counter, clock, sampleLookups } = rig({ [withSample]: 5 });
    for (let i = 0; i < 20; i++) { counter.known(withSample); counter.known(without); }
    expect(sampleLookups()).toBe(2);
    clock.t += HOLDER_SAMPLE_REUSE_MS;
    counter.known(withSample);
    expect(sampleLookups()).toBe(3);
  });
});

describe("holder counter: no sample, so the on-chain count, read in the background", () => {
  test("the first answer is null and starts one read; a hundred more requests start no more; the count lands for the next one", async () => {
    const m = mint();
    const { counter, reads } = rig();
    expect(counter.known(m)).toBeNull();
    for (let i = 0; i < 100; i++) expect(counter.known(m)).toBeNull();
    expect(reads.length).toBe(1);
    reads[0]!.d.resolve(41);
    await tick();
    expect(counter.known(m)).toBe(41);
    expect(reads.length).toBe(1);
  });

  test("after the window the old count is still served while one new read runs, and the new count replaces it", async () => {
    const m = mint();
    const { counter, reads, clock } = rig();
    counter.known(m);
    reads[0]!.d.resolve(10);
    await tick();
    clock.t += HOLDER_COUNT_TTL_MS - 1;
    expect(counter.known(m)).toBe(10);
    expect(reads.length).toBe(1); // still inside the window: refreshed at most every HOLDER_COUNT_TTL_MS
    clock.t += 1;
    expect(counter.known(m)).toBe(10); // stale, served at once
    expect(counter.known(m)).toBe(10);
    expect(reads.length).toBe(2); // one read for the new window, however many requests
    reads[1]!.d.resolve(12);
    await tick();
    expect(counter.known(m)).toBe(12);
  });

  test("a failed read keeps the last count, is tried again after HOLDER_RETRY_MS (not at once, not after a whole window), and says so in the log", async () => {
    const m = mint();
    const { counter, reads, clock } = rig();
    counter.known(m);
    reads[0]!.d.resolve(7);
    await tick();
    clock.t += HOLDER_COUNT_TTL_MS;
    counter.known(m);
    reads[1]!.d.reject(new Error("429 Too Many Requests"));
    await tick();
    expect(counter.known(m)).toBe(7);
    expect(reads.length).toBe(2);
    expect(logged.join("\n")).toContain("429 Too Many Requests");
    clock.t += HOLDER_RETRY_MS - 1;
    counter.known(m);
    expect(reads.length).toBe(2);
    clock.t += 1;
    expect(counter.known(m)).toBe(7);
    expect(reads.length).toBe(3);
    reads[2]!.d.resolve(9);
    await tick();
    expect(counter.known(m)).toBe(9);
  });

  test("a coin whose very first read fails is null until the retry succeeds", async () => {
    const m = mint();
    const { counter, reads, clock } = rig();
    expect(counter.known(m)).toBeNull();
    reads[0]!.d.reject(new Error("rpc down"));
    await tick();
    expect(counter.known(m)).toBeNull();
    clock.t += HOLDER_RETRY_MS;
    expect(counter.known(m)).toBeNull();
    reads[1]!.d.resolve(3);
    await tick();
    expect(counter.known(m)).toBe(3);
  });

  test("at most MAX_BACKGROUND_READS reads at once across coins; the others start as slots free up", async () => {
    const coins = Array.from({ length: 10 }, mint);
    const { counter, reads } = rig();
    for (const c of coins) expect(counter.known(c)).toBeNull();
    expect(reads.length).toBe(MAX_BACKGROUND_READS);
    reads[0]!.d.resolve(1);
    await tick();
    for (const c of coins) counter.known(c);
    expect(reads.length).toBe(MAX_BACKGROUND_READS + 1);
    for (const r of reads.slice(1)) r.d.resolve(2);
    await tick();
    for (const c of coins) counter.known(c);
    for (const r of reads) r.d.resolve(3);
    await tick();
    for (const c of coins) counter.known(c);
    for (const r of reads) r.d.resolve(4);
    await tick();
    expect(new Set(reads.map((r) => r.mint)).size).toBe(10); // every coin got its read in the end
  });

  test("a read that never settles stops holding a slot once its coin starts a new one, so four hung reads cannot stop the rest for good", async () => {
    const hung = Array.from({ length: MAX_BACKGROUND_READS }, mint);
    const other = mint();
    const { counter, reads, clock } = rig();
    for (const c of hung) counter.known(c);
    counter.known(other);
    expect(reads.length).toBe(MAX_BACKGROUND_READS); // the fifth coin waits: every slot is taken
    clock.t += HOLDER_COUNT_TTL_MS;
    counter.known(hung[0]!); // its window is over: a new read replaces the hung one
    counter.known(other);
    expect(reads.length).toBeGreaterThan(MAX_BACKGROUND_READS);
    expect(reads.some((r) => r.mint === other)).toBe(true);
  });
});

describe("holder counter: the coin page", () => {
  test("count() answers at once from a sample or a known count, and waits for the first read only when nothing is known", async () => {
    const sampled = mint();
    const cold = mint();
    const { counter, reads } = rig({ [sampled]: 77 });
    expect(await counter.count(sampled)).toBe(77);
    const pending = counter.count(cold);
    let done = false;
    void pending.then(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    expect(reads.length).toBe(1);
    reads[0]!.d.resolve(5);
    expect(await pending).toBe(5);
    expect(await counter.count(cold)).toBe(5); // known now: no second read
    expect(reads.length).toBe(1);
  });

  test("count() of a coin whose first read fails rejects (the page says it could not load) and does not hang", async () => {
    const m = mint();
    const { counter, reads } = rig();
    const pending = counter.count(m);
    reads[0]!.d.reject(new Error("rpc down"));
    await expect(pending).rejects.toThrow("rpc down");
  });

  test("chain() is the old countHolders: one read per window per coin, shared by every caller", async () => {
    const m = mint();
    const { counter, reads } = rig();
    const calls = Array.from({ length: 10 }, () => counter.chain(m));
    expect(reads.length).toBe(1);
    reads[0]!.d.resolve(8);
    expect(await Promise.all(calls)).toEqual(Array(10).fill(8));
  });
});

// PAD_HOLDER_COUNT_TTL_MS: a count is a getProgramAccounts (10 credits a call on Helius), so on a free plan the wait between counts of a coin is set longer
// (mainnet: 600000, ops/MAINNET-RUNBOOK.md G13). The holders table (src/dbc/holderBook.ts) is the same scan and waits the same.
describe("PAD_HOLDER_COUNT_TTL_MS: 60 s unless set, never under 10 s", () => {
  const read = (raw: string | undefined) => {
    const said: string[] = [];
    return { ms: holderCountTtlMs(raw, (line) => said.push(line)), said };
  };

  test("unset, empty and blank give the 60 s default, without a word", () => {
    for (const raw of [undefined, "", "   "]) expect(read(raw)).toEqual({ ms: 60_000, said: [] });
    expect(HOLDER_COUNT_TTL_DEFAULT_MS).toBe(60_000);
    expect(HOLDER_COUNT_TTL_FLOOR_MS).toBe(10_000);
  });

  test("a number is taken as it is: ten minutes, and the floor itself", () => {
    expect(read("600000")).toEqual({ ms: 600_000, said: [] });
    expect(read(" 600000 ").ms).toBe(600_000);
    expect(read("10000").ms).toBe(10_000);
    expect(read("1e6").ms).toBe(1_000_000);
  });

  test("a number under the floor is raised to it: 9999, 1000, 0 and a negative one (a wait of 0 would scan on every page view)", () => {
    for (const raw of ["9999", "1000", "1", "0", "-5"]) expect(read(raw)).toEqual({ ms: 10_000, said: [] });
  });

  test("a fraction is rounded down", () => {
    expect(read("600000.9").ms).toBe(600_000);
    expect(read("10000.5").ms).toBe(10_000);
    expect(read("9999.9").ms).toBe(10_000);
  });

  test("anything that is not a number gives the default and says so once, naming the setting and the value", () => {
    for (const raw of ["abc", "600_000", "10min", "Infinity", "NaN", "6e999"]) {
      const { ms, said } = read(raw);
      expect(ms).toBe(60_000);
      expect(said.length).toBe(1);
      expect(said[0]).toContain("PAD_HOLDER_COUNT_TTL_MS");
      expect(said[0]).toContain(JSON.stringify(raw));
    }
  });

  /** Loads the real modules in a process of their own with the setting, and runs a counter on a fake clock: reads before and after the window the setting names. */
  function inAProcess(env: Record<string, string>): { ttl: number; book: number; readsAt599s: number; readsAt601s: number } {
    const script = `
      import { makeHolderCounter, HOLDER_COUNT_TTL_MS } from "./src/dbc/holderCount";
      import { HOLDER_BOOK_TTL_MS } from "./src/dbc/holderBook";
      let reads = 0;
      let t = 1_000_000;
      const counter = makeHolderCounter({ now: () => t, read: async () => (reads++, 7), sample: () => null });
      await counter.chain("m");
      t += 599_000;
      await counter.chain("m");
      const readsAt599s = reads;
      t += 2_000;
      await counter.chain("m");
      console.log(JSON.stringify({ ttl: HOLDER_COUNT_TTL_MS, book: HOLDER_BOOK_TTL_MS, readsAt599s, readsAt601s: reads }));
    `;
    const p = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAD_DB_FILE: "/dev/null", ...env },
      stdout: "pipe", stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    return JSON.parse(p.stdout.toString()) as { ttl: number; book: number; readsAt599s: number; readsAt601s: number };
  }

  test("a process started with 600000 counts a coin at most once in ten minutes, and its holders table waits the same; started without it, once a minute", () => {
    expect(inAProcess({ PAD_HOLDER_COUNT_TTL_MS: "600000" })).toEqual({ ttl: 600_000, book: 600_000, readsAt599s: 1, readsAt601s: 2 });
    expect(inAProcess({})).toEqual({ ttl: 60_000, book: 60_000, readsAt599s: 2, readsAt601s: 2 }); // read again after 60 s, and the new window still holds 2 s later
  });

  test("a process started with a value under the floor waits the floor", () => {
    expect(inAProcess({ PAD_HOLDER_COUNT_TTL_MS: "500" })).toMatchObject({ ttl: 10_000, book: 10_000 });
  });

  test("the tests above ran with the setting unset: the constant in this process is the default", () => {
    expect(HOLDER_COUNT_TTL_MS).toBe(60_000);
  });
});

describe("db.latestHolderSampleCount", () => {
  const holders = (n: number) => Array.from({ length: n }, (_, i) => ({ wallet: `w${i}`, balance: 1n }));

  test("is the size of the newest sample, null for a coin with none, and 0 for an empty newest sample", () => {
    const m = mint();
    expect(db.latestHolderSampleCount(m)).toBeNull();
    db.insertHolderSample(m, "2026-10-01T00:00:00.000Z", holders(3));
    db.insertHolderSample(m, "2026-10-03T00:00:00.000Z", holders(5));
    db.insertHolderSample(m, "2026-10-02T00:00:00.000Z", holders(4)); // inserted last, but not the newest
    expect(db.latestHolderSampleCount(m)).toBe(5);
    db.insertHolderSample(m, "2026-10-04T00:00:00.000Z", []);
    expect(db.latestHolderSampleCount(m)).toBe(0);
  });

  test("two samples at the same instant: the later insert wins", () => {
    const m = mint();
    db.insertHolderSample(m, "2026-10-01T00:00:00.000Z", holders(2));
    db.insertHolderSample(m, "2026-10-01T00:00:00.000Z", holders(9));
    expect(db.latestHolderSampleCount(m)).toBe(9);
  });

  test("another coin's samples are never counted", () => {
    const a = mint();
    const b = mint();
    db.insertHolderSample(a, "2026-10-01T00:00:00.000Z", holders(6));
    expect(db.latestHolderSampleCount(b)).toBeNull();
  });
});
