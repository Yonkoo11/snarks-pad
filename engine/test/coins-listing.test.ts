// GET /api/coins?sort=&stage=&q=&limit=&offset= docs/API.md v2.5: what each parameter means (selectCoins, pure),
// and a hostile pass on the parameters themselves (through the real fetch handler: every bad one is a clean 400 naming
// the field, answered before any chain read, never a 500, never an echo of what was sent).
import { describe, expect, test } from "bun:test";
import { handleRequest } from "../src/api";
import { COIN_SORTS, DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET, MAX_SEARCH_CHARS, parseCoinsQuery, selectCoins, type ListedCoin } from "../src/dbc/listing";

const coin = (o: Partial<ListedCoin> & { mint: string }): ListedCoin => ({
  name: "Coin", symbol: "CN", stage: "curve", createdAt: "2026-10-01T00:00:00.000Z", curveProgress: 0.1, marketCapZec: "100", volume24hZats: "0", ...o,
});
const query = (qs: string) => parseCoinsQuery(new URLSearchParams(qs));
const select = (items: ListedCoin[], qs: string) => selectCoins(items, query(qs));
const mints = (items: ListedCoin[]) => items.map((c) => c.mint);

describe("parseCoinsQuery", () => {
  test("no parameters: newest first, both stages, no search, the first 100, the old board filter on", () => {
    expect(query("")).toEqual({ all: false, sort: "new", stage: null, q: "", limit: DEFAULT_LIMIT, offset: 0 });
    expect([DEFAULT_LIMIT, MAX_LIMIT]).toEqual([100, 100]);
  });

  test("every valid value is taken as sent; all=1 keeps meaning 'every launched coin'", () => {
    for (const sort of COIN_SORTS) expect(query(`sort=${sort}`).sort).toBe(sort);
    expect(query("stage=curve").stage).toBe("curve");
    expect(query("stage=graduated").stage).toBe("graduated");
    expect(query("limit=1&offset=0").limit).toBe(1);
    expect(query(`limit=${MAX_LIMIT}&offset=${MAX_OFFSET}`)).toMatchObject({ limit: MAX_LIMIT, offset: MAX_OFFSET });
    expect(query("all=1").all).toBe(true);
    expect(query("all=0").all).toBe(false);
    expect(query("all=true").all).toBe(false);
  });

  test("the search is trimmed, may be 64 characters, and an empty one is no search", () => {
    expect(query("q=%20%20snarks%20%20").q).toBe("snarks");
    expect(query("q=").q).toBe("");
    expect(query("q=%20%20").q).toBe("");
    expect(query(`q=${"a".repeat(MAX_SEARCH_CHARS)}`).q.length).toBe(MAX_SEARCH_CHARS);
    expect(query("q=%24SNARKS%20%26%20%E2%9C%93").q).toBe("$SNARKS & ✓");
  });

  test("unknown parameters are ignored (a cache-buster does not break the list)", () => {
    expect(query("_=1712345&utm_source=x&sort[]=mcap&__proto__=1&constructor=2")).toEqual(query(""));
  });
});

describe("selectCoins: order", () => {
  const coins = [
    coin({ mint: "A", createdAt: "2026-10-01T10:00:00.000Z", marketCapZec: "9", volume24hZats: "5", curveProgress: 0.5 }),
    coin({ mint: "B", createdAt: "2026-10-01T12:00:00.000Z", marketCapZec: "10", volume24hZats: "50", curveProgress: 0.9 }),
    coin({ mint: "C", createdAt: "2026-10-01T11:00:00.000Z", marketCapZec: "100000000000000000000", volume24hZats: "50", curveProgress: 1, stage: "graduated" }),
    coin({ mint: "D", createdAt: "2026-10-01T09:00:00.000Z", marketCapZec: "0", volume24hZats: "0", curveProgress: 0 }),
  ];

  test("new: newest first", () => {
    expect(mints(select(coins, "sort=new").page)).toEqual(["B", "C", "A", "D"]);
    expect(mints(select(coins, "").page)).toEqual(["B", "C", "A", "D"]); // the default
  });

  test("mcap: biggest first as a number, not as text ('9' is below '10'; 21 digits is above both)", () => {
    expect(mints(select(coins, "sort=mcap").page)).toEqual(["C", "B", "A", "D"]);
  });

  test("volume: biggest first; equal volumes go to the bigger market cap (most coins of a young pad have no volume)", () => {
    expect(mints(select(coins, "sort=volume").page)).toEqual(["C", "B", "A", "D"]); // B and C both traded 50: C's market cap is bigger
  });

  test("progress: the coins still on a curve first, nearest graduation first; the graduated coin comes after them", () => {
    expect(mints(select(coins, "sort=progress").page)).toEqual(["B", "A", "D", "C"]);
    expect(mints(select(coins, "sort=progress&stage=curve").page)).toEqual(["B", "A", "D"]);
    expect(mints(select(coins, "sort=progress&stage=graduated").page)).toEqual(["C"]);
  });

  test("whatever is still tied falls to the next rank, then to the newer coin, then to the mint", () => {
    const tied = [
      coin({ mint: "m1", createdAt: "2026-10-01T01:00:00.000Z", volume24hZats: "7", marketCapZec: "5", curveProgress: 0.4 }),
      coin({ mint: "m2", createdAt: "2026-10-01T03:00:00.000Z", volume24hZats: "7", marketCapZec: "5", curveProgress: 0.4 }),
      coin({ mint: "m3", createdAt: "2026-10-01T02:00:00.000Z", volume24hZats: "7", marketCapZec: "9", curveProgress: 0.4 }),
      coin({ mint: "m4", createdAt: "2026-10-01T04:00:00.000Z", volume24hZats: "1", marketCapZec: "1", curveProgress: 0.4 }),
    ];
    expect(mints(select(tied, "sort=volume").page)).toEqual(["m3", "m2", "m1", "m4"]); // volume, then market cap, then newest
    expect(mints(select(tied, "sort=progress").page)).toEqual(["m3", "m2", "m1", "m4"]); // all on the curve at 0.4: market cap (m3 9, m1 and m2 5, m4 1), then newest
    expect(mints(select(tied, "sort=mcap").page)).toEqual(["m3", "m2", "m1", "m4"]);
    const same = ["z", "m", "a"].map((mint) => coin({ mint }));
    for (const sort of COIN_SORTS) expect(mints(select(same, `sort=${sort}`).page)).toEqual(["a", "m", "z"]); // everything equal: by mint
  });

  test("a malformed amount ranks as 0", () => {
    const odd = [coin({ mint: "bad", marketCapZec: "12abc" }), coin({ mint: "ok", marketCapZec: "1" })];
    expect(mints(select(odd, "sort=mcap").page)).toEqual(["ok", "bad"]);
  });

  test("the input list is not reordered", () => {
    const before = mints(coins);
    select(coins, "sort=mcap");
    expect(mints(coins)).toEqual(before);
  });
});

describe("selectCoins: stage and search", () => {
  const coins = [
    coin({ mint: "So11111111111111111111111111111111111111112", name: "Release The Snarks", symbol: "SNARKS" }),
    coin({ mint: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", name: "Shielded Pie", symbol: "PIE", stage: "graduated" }),
    coin({ mint: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5", name: "Crayon Cat", symbol: "CRAYON" }),
  ];

  test("stage keeps one stage", () => {
    expect(select(coins, "stage=graduated").page.map((c) => c.symbol)).toEqual(["PIE"]);
    expect(select(coins, "stage=curve").total).toBe(2);
  });

  test("a name or symbol containing the text matches in any case; the text may sit mid-word", () => {
    expect(select(coins, "q=SNARK").page.map((c) => c.symbol)).toEqual(["SNARKS"]);
    expect(select(coins, "q=release").page.map((c) => c.symbol)).toEqual(["SNARKS"]);
    expect(select(coins, "q=nark").page.map((c) => c.symbol)).toEqual(["SNARKS"]); // inside both the name and the symbol
    expect(select(coins, "q=pie").page.map((c) => c.symbol)).toEqual(["PIE"]);
    expect(select(coins, "q=Cat").page.map((c) => c.symbol)).toEqual(["CRAYON"]);
  });

  test("a mint matches by its start only, and case counts (a mint is case-sensitive)", () => {
    expect(select(coins, "q=9xQeWv").page.map((c) => c.symbol)).toEqual(["PIE"]);
    expect(select(coins, "q=9xqewv").total).toBe(0);
    expect(select(coins, "q=xQeWv").total).toBe(0); // inside the mint, not at its start
    expect(select(coins, "q=So1111").page.map((c) => c.symbol)).toEqual(["SNARKS"]);
  });

  test("the text is matched as plain text: regex, SQL and wildcard characters mean nothing", () => {
    for (const q of [".*", "(", "[", "\\", "^", "$", "%", "_", "%25", "' OR '1'='1", "'; DROP TABLE coins;--", "1) UNION SELECT * FROM optins --", "\\d+", "(a+)+$", "..", "*", "?"]) {
      expect(select(coins, `q=${encodeURIComponent(q)}`).total).toBe(0);
    }
    const odd = [coin({ mint: "m1", name: "50% off_all (limited) [new]", symbol: "OFF" })];
    expect(select(odd, `q=${encodeURIComponent("50% off_")}`).total).toBe(1);
    expect(select(odd, `q=${encodeURIComponent("(limited) [")}`).total).toBe(1);
    expect(select(odd, `q=${encodeURIComponent("%")}`).total).toBe(1); // matches only because the name really holds a "%"
  });

  test("a pathological search is as quick as any other", () => {
    const many = Array.from({ length: 1000 }, (_, i) => coin({ mint: `m${i}`, name: `name ${i} ${"a".repeat(30)}` }));
    const t0 = performance.now();
    select(many, `q=${"a".repeat(MAX_SEARCH_CHARS - 1)}!`);
    select(many, `q=${encodeURIComponent("(a+)+$".repeat(10))}`);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  test("search, stage and sort apply together, and total counts the matches before the page", () => {
    const set = [
      coin({ mint: "a", name: "Moon One", stage: "curve", volume24hZats: "5" }),
      coin({ mint: "b", name: "Moon Two", stage: "graduated", volume24hZats: "9" }),
      coin({ mint: "c", name: "Moon Three", stage: "curve", volume24hZats: "7" }),
      coin({ mint: "d", name: "Sun", stage: "curve", volume24hZats: "99" }),
    ];
    const r = select(set, "q=moon&stage=curve&sort=volume&limit=1");
    expect(mints(r.page)).toEqual(["c"]);
    expect(r.total).toBe(2);
  });
});

describe("selectCoins: pages", () => {
  const coins = Array.from({ length: 10 }, (_, i) => coin({ mint: `m${i}`, createdAt: `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`, volume24hZats: String(i % 3) }));

  test("pages of any size walk the whole order once: no coin repeated, none skipped, total the same on every page", () => {
    for (const sort of COIN_SORTS) {
      const whole = mints(select(coins, `sort=${sort}`).page);
      for (const size of [1, 3, 4, 10, 100]) {
        const seen: string[] = [];
        for (let offset = 0; offset < coins.length; offset += size) {
          const r = select(coins, `sort=${sort}&limit=${size}&offset=${offset}`);
          expect(r.total).toBe(10);
          seen.push(...mints(r.page));
        }
        expect(seen).toEqual(whole);
      }
    }
  });

  test("an offset past the end is an empty page that still says how many there are; a short last page is short", () => {
    expect(select(coins, "offset=10")).toEqual({ page: [], total: 10 });
    expect(select(coins, `offset=${MAX_OFFSET}`)).toEqual({ page: [], total: 10 });
    expect(select(coins, "limit=4&offset=8").page.length).toBe(2);
  });

  test("no coins at all is an empty page with total 0", () => {
    expect(selectCoins([], query(""))).toEqual({ page: [], total: 0 });
  });
});

describe("GET /api/coins: hostile parameters", () => {
  const get = (qs: string) => handleRequest(new Request(`http://pad.test/api/coins?${qs}`));

  async function refused(qs: string, field: string, submitted?: string) {
    const res = await get(qs);
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "bad_request", field });
    expect(text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:/);
    if (submitted && submitted.length > 2) expect(text).not.toContain(submitted); // never an echo of what was sent
  }

  test("sort: only the four values, exactly as spelled", async () => {
    for (const bad of ["bogus", "NEW", "New", "", "new,mcap", " new", "new ", "new;DROP TABLE coins", "' OR 1=1 --", "%00", "constructor", "__proto__", "toString", "hasOwnProperty", "1", "../../etc/passwd", "new%0Amcap", "a".repeat(5000)]) {
      await refused(`sort=${encodeURIComponent(bad)}`, "sort", bad);
    }
  });

  test("stage: only curve or graduated", async () => {
    for (const bad of ["", "all", "Curve", "GRADUATED", "curve,graduated", "null", "0", "'", "graduated%00", "constructor"]) {
      await refused(`stage=${encodeURIComponent(bad)}`, "stage", bad);
    }
  });

  test("limit: a whole number from 1 to 100, written plainly", async () => {
    for (const bad of ["0", "101", "1000", "-1", "-0", "+5", "1.5", "5.0", "1e2", "0x10", "0b1", " 5", "5 ", "", "abc", "NaN", "Infinity", "null", "999999999", "1000000000", "99999999999999999999", "٣", "５", "5\n", "5,6", "[5]", "{}", "5;DROP"]) {
      await refused(`limit=${encodeURIComponent(bad)}`, "limit", bad);
    }
  });

  test("offset: a whole number from 0 to 1,000,000, written plainly", async () => {
    for (const bad of ["-1", "1000001", "1.5", "1e3", "0x1", " 1", "1 ", "", "abc", "NaN", "99999999999999999999", "٣", "-0"]) {
      await refused(`offset=${encodeURIComponent(bad)}`, "offset", bad);
    }
  });

  test("q: at most 64 characters and no control characters", async () => {
    await refused(`q=${"a".repeat(MAX_SEARCH_CHARS + 1)}`, "q");
    await refused(`q=${"a".repeat(100_000)}`, "q");
    for (const bad of ["%00", "a%00b", "%0A", "%0D%0A", "%1B%5B31m", "%7F", "tab%09tab"]) await refused(`q=${bad}`, "q");
  });

  test("a parameter sent twice is refused, whichever way the two differ", async () => {
    await refused("sort=new&sort=mcap", "sort");
    await refused("sort=new&sort=new", "sort");
    await refused("stage=curve&stage=graduated", "stage");
    await refused("limit=5&limit=6", "limit");
    await refused("offset=0&offset=1", "offset");
    await refused("q=a&q=b", "q");
    await refused("q=&q=", "q");
  });

  test("the first bad parameter is named, and a bad parameter is refused even next to good ones", async () => {
    await refused("all=1&sort=mcap&stage=curve&q=ok&limit=0", "limit");
    await refused("limit=5&sort=nope", "sort");
  });

  test("other methods and the sub-routes are untouched: POST /api/coins is still not a route", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/coins?sort=new", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });
});
