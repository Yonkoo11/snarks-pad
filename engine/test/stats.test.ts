// GET /api/stats docs/API.md v2.5: coins and graduated coins, 24-hour volume, what holders were paid on each
// rail, and how many wallets opted in. Database and cache only (no chain read, so these run without a validator), and
// aggregates only. The database file is shared with other test files, so every number is checked either on mints of this
// file's own or against GET /api/epochs, which sums the same rows.
import { beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { clearStatsCache, handleRequest, statsView, totalPaidToHolders } from "../src/api";
import * as db from "../src/db";

const HOUR = 3_600_000;
const mint = () => Keypair.generate().publicKey.toBase58();
const wallet = mint;

function launched(feeBps = 100): string {
  const m = mint();
  db.upsertCoin({ mint: m, name: "Stat", symbol: "STAT", imageUrl: "", description: "", creator: m, createdAt: new Date().toISOString(), feeBps, poolId: null, mintDecimals: 6, status: "pending" });
  db.markCoinLaunched(m, mint());
  return m;
}

let n = 0;
function trade(m: string, amountZec: string, msAgo = HOUR): void {
  db.insertTrade({ sig: `stats-${m}-${n++}`, mint: m, side: "buy", wallet: "w", amountToken: "1000000", amountZec, at: new Date(Date.now() - msAgo).toISOString() });
}

function epoch(coinMints: string[]): string {
  const id = `epoch-stats-${crypto.randomUUID()}`;
  db.upsertEpoch({
    id, at: new Date().toISOString(), coinMints: JSON.stringify(coinMints), harvestedZats: "1000", feeZats: "0",
    status: "ok", swapProvider: null, swapRef: null, swapState: "failed_before_funds_moved", swapAmountOutZats: null, zcashTxids: "[]",
  });
  return id;
}

async function get(path: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const res = await handleRequest(new Request(`http://pad.test/api${path}`));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(() => clearStatsCache());

describe("coins, graduated and volume", () => {
  test("a launched coin counts; a coin that is only pending does not; graduated means the pad recorded the move to DAMM v2", () => {
    const before = statsView(true);
    const a = launched();
    const b = launched();
    db.upsertCoin({ mint: mint(), name: "P", symbol: "P", imageUrl: "", description: "", creator: "c", createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
    clearStatsCache();
    const mid = statsView(true);
    expect([mid.coins - before.coins, mid.graduated - before.graduated]).toEqual([2, 0]);
    db.markCoinMigrated(b, mint(), null);
    clearStatsCache();
    const after = statsView(true);
    expect([after.coins - before.coins, after.graduated - before.graduated]).toEqual([2, 1]);
    void a;
  });

  test("the board's own list decides: the featured mints by default, every coin with all", () => {
    const a = launched();
    const b = launched();
    const c = launched();
    db.markCoinMigrated(b, mint(), null);
    trade(a, "100");
    trade(b, "20");
    trade(c, "3");
    expect(statsView(false, [a, b])).toMatchObject({ coins: 2, graduated: 1, volume24hZats: "120" });
    expect(statsView(false, [c])).toMatchObject({ coins: 1, graduated: 0, volume24hZats: "3" });
    expect(statsView(false, [mint()])).toMatchObject({ coins: 0, graduated: 0, volume24hZats: "0" }); // a featured mint that is not a coin
    const all = statsView(true, [a]);
    expect(all.coins).toBeGreaterThanOrEqual(3); // all=1 ignores the featured list
    expect(BigInt(all.volume24hZats)).toBeGreaterThanOrEqual(123n);
  });

  test("volume is the sum of the recorded ZEC of the last 24 hours only, exact past 2^53", () => {
    const a = launched();
    trade(a, "9007199254740993");
    trade(a, "9007199254740993", 2 * HOUR);
    trade(a, "500", 23 * HOUR);
    trade(a, "777", 25 * HOUR); // outside the window
    expect(statsView(false, [a]).volume24hZats).toBe((2n * 9007199254740993n + 500n).toString());
  });
});

describe("paid to holders", () => {
  test("is exactly what GET /api/epochs adds up, rail by rail, with the same classification", async () => {
    const m = launched();
    const id = epoch([m]);
    db.planPayout({ epochId: id, wallet: "h-sol", kind: "solana", amountZats: "500" });
    db.markPayoutSent(id, "h-sol", "solana", "sig-sol");
    db.planPayout({ epochId: id, wallet: "h-shd", kind: "shielded", amountZats: "1000", zcashAddress: "uregtest1x" });
    db.markPayoutSent(id, "h-shd", "shielded", "b".repeat(64));
    db.planPayout({ epochId: id, wallet: "h-fall", kind: "shielded", amountZats: "250", zcashAddress: "uregtest1y" });
    db.markPayoutSent(id, "h-fall", "shielded", "fallback_solana:sig-fall"); // a shielded holder paid on Solana: Solana's
    db.planPayout({ epochId: id, wallet: "h-carry", kind: "solana", amountZats: "999" });
    db.markPayoutSent(id, "h-carry", "solana", "carried:new_account_below_rent"); // no money moved
    db.planPayout({ epochId: id, wallet: "h-unsent", kind: "solana", amountZats: "888" }); // planned, never sent
    db.planPayout({ epochId: id, wallet: "team-wallet", kind: "team", amountZats: "777" });
    db.markPayoutSent(id, "team-wallet", "team", "sig-team"); // the team's share is not paid to holders

    const paid = totalPaidToHolders();
    const epochs = ((await get("/epochs")).body.epochs as { solanaPayouts: { totalZats: string }; shielded: { totalZats: string } }[]);
    expect(paid.paidSolanaZats).toBe(epochs.reduce((a, e) => a + BigInt(e.solanaPayouts.totalZats), 0n).toString());
    expect(paid.paidShieldedZats).toBe(epochs.reduce((a, e) => a + BigInt(e.shielded.totalZats), 0n).toString());
    // and this epoch's rows are in it as classified: 500 + 250 on Solana, 1000 shielded
    const only = epochs.find((e) => (e as unknown as { id: string }).id === id) as { solanaPayouts: { totalZats: string }; shielded: { totalZats: string } };
    expect([only.solanaPayouts.totalZats, only.shielded.totalZats]).toEqual(["750", "1000"]);
  });

  test("a payout recorded after the last read shows once the few-second cache is cleared, and not before", () => {
    const m = launched();
    const primed = statsView(true); // the first read, now kept
    const id = epoch([m]);
    db.planPayout({ epochId: id, wallet: "late", kind: "solana", amountZats: "123" });
    db.markPayoutSent(id, "late", "solana", "sig-late");
    expect(statsView(true).paidSolanaZats).toBe(primed.paidSolanaZats); // still the earlier total...
    clearStatsCache();
    const fresh = statsView(true); // ...until it is forgotten
    expect(fresh).toMatchObject(totalPaidToHolders());
    expect(BigInt(fresh.paidSolanaZats) - BigInt(primed.paidSolanaZats)).toBe(123n);
    expect(fresh.paidShieldedZats).toBe(primed.paidShieldedZats);
  });
});

describe("opt-ins", () => {
  test("counts the wallets with shielded delivery on, and a wallet that stopped no longer counts", () => {
    const before = statsView(true).optIns;
    const [a, b, c] = [wallet(), wallet(), wallet()];
    for (const w of [a, b, c]) db.upsertOptin(w, "uregtest1address");
    db.deactivateOptin(c);
    expect(statsView(true).optIns - before).toBe(2);
    expect(db.countActiveOptins()).toBe(db.listActiveOptins().length);
  });
});

describe("GET /api/stats", () => {
  test("answers the six fields, with the right types, and nothing about any wallet or address", async () => {
    const w = wallet();
    db.upsertOptin(w, "uregtest1aVeryRecognisableAddressForThisTest");
    const m = launched();
    const id = epoch([m]);
    db.planPayout({ epochId: id, wallet: w, kind: "shielded", amountZats: "321", zcashAddress: "uregtest1aVeryRecognisableAddressForThisTest" });
    db.markPayoutSent(id, w, "shielded", "c".repeat(64));
    const r = await get("/stats");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["coins", "graduated", "optIns", "paidShieldedZats", "paidSolanaZats", "volume24hZats"]);
    expect(typeof r.body.coins).toBe("number");
    expect(typeof r.body.graduated).toBe("number");
    for (const k of ["volume24hZats", "paidSolanaZats", "paidShieldedZats"]) expect(r.body[k]).toMatch(/^[0-9]+$/);
    expect(r.body.optIns).toBeGreaterThanOrEqual(1);
    expect(r.text).not.toContain(w);
    expect(r.text).not.toContain("uregtest1");
    expect(r.text).not.toContain(id);
  });

  test("is public JSON with the pad-mode and CORS headers every route has, and POST is not a route", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/stats"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-pad-mode")).toBeTruthy();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await handleRequest(new Request("http://pad.test/api/stats", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await handleRequest(new Request("http://pad.test/api/stats/extra"))).status).toBe(404);
  });

  test("?all=1 is accepted, junk parameters change nothing, and it never answers 500", async () => {
    for (const qs of ["", "?all=1", "?all=0", "?all=%00", "?sort=bogus&limit=-5&q=%27%3B", "?all=1&all=1", "?" + "a=1&".repeat(500)]) {
      const r = await get(`/stats${qs}`);
      expect(r.status).toBe(200);
    }
  });

  test("is answered from a cache inside the window: a trade recorded after the first read is not in a second one", async () => {
    const m = launched();
    const first = BigInt((await get("/stats?all=1")).body.volume24hZats as string);
    trade(m, "5000");
    const second = BigInt((await get("/stats?all=1")).body.volume24hZats as string);
    expect(second).toBe(first);
    clearStatsCache();
    expect(BigInt((await get("/stats?all=1")).body.volume24hZats as string) - first).toBe(5000n);
  });
});
