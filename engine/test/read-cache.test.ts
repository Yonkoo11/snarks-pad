// makeReadCache (stress API load, audit/STRESS-REPORT.md D7): the public coin views read the chain at most once per
// window per coin, however many requests arrive.
import { describe, expect, test } from "bun:test";
import { makeReadCache } from "../src/dbc/read";

describe("makeReadCache", () => {
  test("50 concurrent requests for one key make one read; another key reads on its own; after the window, a new read", async () => {
    let reads = 0;
    let t = 0;
    const get = makeReadCache(async (k: string) => { reads++; await Bun.sleep(20); return `${k}${reads}`; }, (k) => k, 1000, () => t);
    const out = await Promise.all(Array.from({ length: 50 }, () => get("a")));
    expect(reads).toBe(1);
    expect(new Set(out).size).toBe(1);
    await get("b");
    expect(reads).toBe(2);
    t = 999;
    await get("a");
    expect(reads).toBe(2);
    t = 1000;
    await get("a");
    expect(reads).toBe(3);
  });
  test("a failed read is not kept: the next request reads again", async () => {
    let reads = 0;
    const get = makeReadCache(async () => { reads++; if (reads === 1) throw new Error("rpc down"); return 1; }, () => "k", 60_000);
    await expect(get("k")).rejects.toThrow("rpc down");
    expect(await get("k")).toBe(1);
    expect(reads).toBe(2);
  });
});
