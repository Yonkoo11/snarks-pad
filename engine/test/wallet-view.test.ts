// GET /api/wallets/:wallet docs/API.md v2.9: the profile page's data about one wallet, from the database alone. The coins it launched or is the Creator
// wallet of, the trades it made on this pad (the trades table records the trader), and when it first appeared. Pending launches and coins the board hides are
// nowhere, as on the coin list. No chain: the view is synchronous, so it cannot wait for an RPC call, and it holds nothing about rewards or shielded delivery.
import { afterAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import { handleWalletRoute } from "../src/api/walletRoutes";
import * as db from "../src/db";
import { WALLET_TRADES_LIMIT, walletView } from "../src/dbc/walletView";

const run = crypto.randomUUID().slice(0, 8);
const key = () => Keypair.generate().publicKey.toBase58();
const mints: string[] = [];
const sigs: string[] = [];
const at = (minute: number) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + minute * 60_000).toISOString();

interface CoinOptions { creator: string; creatorWallet?: string; createdAt?: string; feeBps?: number; symbol?: string; pending?: boolean; graduated?: boolean }
function coin(o: CoinOptions): string {
  const mint = key();
  db.upsertCoin({
    mint, name: `Wallet ${run}`, symbol: o.symbol ?? "WV", imageUrl: `https://pad.test/i/${run}.png`, description: "", creator: o.creator, createdAt: o.createdAt ?? at(0), feeBps: o.feeBps ?? 100,
    poolId: null, mintDecimals: 6, status: "pending", creatorWallet: o.creatorWallet ?? null,
  });
  if (!o.pending) db.markCoinLaunched(mint, key());
  if (o.graduated) db.markCoinMigrated(mint, key(), null);
  mints.push(mint);
  return mint;
}

let n = 0;
function trade(wallet: string, mint: string, minute: number, side: "buy" | "sell" = "buy"): string {
  const sig = `wv-${run}-${n++}`;
  sigs.push(sig);
  db.insertTrade({ sig, mint, side, wallet, amountToken: String(1_000_000 * (minute + 1)), amountZec: String(10_000 * (minute + 1)), at: at(minute) });
  return sig;
}

afterAll(() => {
  const d = db.getDb();
  for (const m of mints) d.query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
  for (const s of sigs) d.query("DELETE FROM trades WHERE sig = $s").run({ $s: s });
});

async function get(wallet: string) {
  const res = await handleRequest(new Request(`http://pad.test/api/wallets/${wallet}`));
  const text = await res.text();
  expect(res.status).not.toBe(500);
  return { status: res.status, text, body: JSON.parse(text) as any };
}

describe("launched", () => {
  test("the coins the wallet launched or is the Creator wallet of, newest first, each with the fields the profile prints", async () => {
    const a = key();
    const b = key();
    const older = coin({ creator: a, createdAt: at(10), symbol: "OLD" });
    const newer = coin({ creator: a, createdAt: at(30), symbol: "NEW", feeBps: 400, graduated: true });
    const handedOver = coin({ creator: b, creatorWallet: a, createdAt: at(20), symbol: "HAND", feeBps: 200 });
    const others = coin({ creator: b, createdAt: at(40), symbol: "OTHER" });

    const r = await get(a);
    expect(r.status).toBe(200);
    expect(r.body.wallet).toBe(a);
    expect(r.body.launched.map((c: { mint: string }) => c.mint)).toEqual([newer, handedOver, older]);
    expect(r.body.launched[0]).toEqual({
      mint: newer, name: `Wallet ${run}`, symbol: "NEW", imageUrl: `https://pad.test/i/${run}.png`, creator: a, creatorWallet: a,
      stage: "graduated", createdAt: at(30), feeBps: 400, creatorShareBps: 6000, status: "launched",
    });
    expect(r.body.launched[1]).toMatchObject({ mint: handedOver, creator: b, creatorWallet: a, stage: "curve", feeBps: 200, creatorShareBps: 4000 }); // the pad's record names a as who is paid
    expect(r.body.launched[2]).toMatchObject({ mint: older, creator: a, creatorWallet: a, feeBps: 100, creatorShareBps: 0 }); // the 1% tier has no creator share
    expect(r.text).not.toContain(others);

    const launcher = await get(b); // the launcher of a handed-over coin keeps it on its own profile too
    expect(launcher.body.launched.map((c: { mint: string }) => c.mint)).toEqual([others, handedOver]);
  });

  test("a pending launch is not listed (the coin page answers 404 for it too), and a wallet that launched nothing has an empty list", async () => {
    const a = key();
    coin({ creator: a, pending: true });
    const r = await get(a);
    expect(r.body.launched).toEqual([]);
    expect((await get(key())).body.launched).toEqual([]);
  });
});

describe("trades", () => {
  test("the wallet's own trades, newest first, with the coin's symbol, and no other wallet's", async () => {
    const w = key();
    const rival = key();
    const m1 = coin({ creator: key(), symbol: "ONE" });
    const m2 = coin({ creator: key(), symbol: "TWO" });
    const s1 = trade(w, m1, 5);
    const s2 = trade(w, m2, 9, "sell");
    trade(rival, m1, 7);

    const r = await get(w);
    expect(r.body.trades).toEqual([
      { sig: s2, mint: m2, symbol: "TWO", side: "sell", amountToken: String(1_000_000 * 10), amountZec: String(10_000 * 10), at: at(9) },
      { sig: s1, mint: m1, symbol: "ONE", side: "buy", amountToken: String(1_000_000 * 6), amountZec: String(10_000 * 6), at: at(5) },
    ]);
    expect(r.text).not.toContain(rival);
  });

  test(`at most ${WALLET_TRADES_LIMIT} are listed, the newest ones`, async () => {
    const w = key();
    const m = coin({ creator: key() });
    for (let i = 0; i < WALLET_TRADES_LIMIT + 5; i++) trade(w, m, i);
    const r = await get(w);
    expect(r.body.trades.length).toBe(WALLET_TRADES_LIMIT);
    expect(r.body.trades[0].at).toBe(at(WALLET_TRADES_LIMIT + 4));
    expect(r.body.trades[WALLET_TRADES_LIMIT - 1].at).toBe(at(5));
  });

  test("a trade on a pending launch is not listed", async () => {
    const w = key();
    trade(w, coin({ creator: key(), pending: true }), 3);
    expect((await get(w)).body.trades).toEqual([]);
  });
});

describe("firstSeenAt", () => {
  test("the earlier of the wallet's first trade and its first coin", async () => {
    const w = key();
    coin({ creator: w, createdAt: at(50) });
    trade(w, coin({ creator: key() }), 80);
    expect((await get(w)).body.firstSeenAt).toBe(at(50)); // launched before it ever traded

    const t = key();
    coin({ creator: t, createdAt: at(90) });
    trade(t, coin({ creator: key() }), 15);
    trade(t, coin({ creator: key() }), 40);
    expect((await get(t)).body.firstSeenAt).toBe(at(15)); // traded before it launched, and the first of two trades
  });

  test("a wallet the pad has never recorded is 200 with nothing: no coins, no trades, no date", async () => {
    const w = key();
    const r = await get(w);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ wallet: w, launched: [], trades: [], firstSeenAt: null });
  });
});

describe("what the route is", () => {
  test("a view of the database alone: synchronous, so it cannot wait for an RPC call, and the answer has only the four keys", async () => {
    const w = key();
    coin({ creator: w });
    const view = walletView(w, null);
    expect(view).not.toBeInstanceOf(Promise);
    const res = handleWalletRoute(new Request(`http://pad.test/api/wallets/${w}`), new URL(`http://pad.test/api/wallets/${w}`));
    expect(res).toBeInstanceOf(Response);
    expect(Object.keys(view).sort()).toEqual(["firstSeenAt", "launched", "trades", "wallet"]);
  });

  test("it says nothing about rewards or shielded delivery, for a wallet that opted in as for one that did not", async () => {
    const on = key();
    db.upsertOptin(on, "uregtest1thisaddressmustneverappearinanyanswer0123456789");
    try {
      coin({ creator: on });
      const a = await get(on);
      const b = await get(key());
      expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
      expect(a.text).not.toMatch(/optedIn|shielded|zcashAddress|uregtest1|payout|reward/i);
    } finally {
      db.getDb().query("DELETE FROM optins WHERE wallet = $w").run({ $w: on });
    }
  });

  test("a coin the board does not list is not on the profile either, whoever launched it (the board's rule, from the featured list)", () => {
    const w = key();
    const listed = coin({ creator: w, createdAt: at(1) });
    const hidden = coin({ creator: w, createdAt: at(2) });
    const m = coin({ creator: key() });
    trade(w, m, 4);
    const tradedHidden = coin({ creator: key() });
    trade(w, tradedHidden, 6);

    const view = walletView(w, [listed, m]); // a featured list: only these coins are on the board
    expect(view.launched.map((c) => c.mint)).toEqual([listed]);
    expect(view.launched.map((c) => c.mint)).not.toContain(hidden);
    expect(view.trades.map((t) => t.mint)).toEqual([m]);
    expect(view.firstSeenAt).toBe(at(1));
    expect(walletView(w, null).launched.map((c) => c.mint)).toEqual([hidden, listed]); // no featured list: every launched coin
  });

  test("through the route: a creator's coin the featured list leaves off the board is still on their profile; a hidden coin is not (2026-10-06 live finding)", async () => {
    const w = key();
    const mine = coin({ creator: w, createdAt: at(1) });
    const moderated = coin({ creator: w, createdAt: at(2) });
    const lists = config.api as { featuredMints: string[]; hiddenMints: string[] }; // the test sets the two lists the route reads, and puts them back
    const [featured, hidden] = [lists.featuredMints, lists.hiddenMints];
    lists.featuredMints = ["none"];
    lists.hiddenMints = [moderated];
    try {
      const r = await get(w);
      expect(r.status).toBe(200);
      expect((r.body as { launched: { mint: string }[] }).launched.map((c) => c.mint)).toEqual([mine]);
    } finally {
      lists.featuredMints = featured;
      lists.hiddenMints = hidden;
    }
  });

  test("hostile paths: not a wallet is 400 bad_wallet naming the field, never a 500 and never an echo; other methods and sub-paths are not this route", async () => {
    for (const bad of ["abc", "0".repeat(44), "..%2F..%2Fetc%2Fpasswd", "%E0%A4%A", encodeURIComponent("$(id)"), "1".repeat(45), encodeURIComponent("' OR 1=1 --")]) {
      const r = await get(bad);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_wallet", field: "wallet" });
    }
    const w = key();
    expect((await handleRequest(new Request(`http://pad.test/api/wallets/${w}`, { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await handleRequest(new Request(`http://pad.test/api/wallets/${w}/coins`))).status).toBe(404);
    expect((await handleRequest(new Request("http://pad.test/api/wallets/"))).status).toBe(404);
  });
});
