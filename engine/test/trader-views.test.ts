// The pot, the fixed-facts panel and the holders route docs/API.md v2.6, the parts that need no chain: the last payout of each coin
// (from the rows the keeper wrote), the pot's split (the engine's own 75/25 rule), the Token-2022 metadata parse, and a hostile pass on
// the three routes' parameters. Real pools: trader-live.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { ExtensionType } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { clearStatsCache, handleRequest } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { metadataUpdateAuthority } from "../src/dbc/fixed";
import { buildPot } from "../src/dbc/pot";
import { computeAllCoinRewards } from "../src/epoch/publicView";
import { computeAllLastPayouts } from "../src/epoch/publicView";
import { splitClaim } from "../src/epoch/split";

const run = crypto.randomUUID().slice(0, 8);
const key = () => Keypair.generate().publicKey.toBase58();
const epochIds: string[] = [];
const mints: string[] = [];
let clock = Date.parse("2026-07-01T00:00:00.000Z");

function coin(): string {
  const mint = key();
  db.upsertCoin({ mint, name: `V ${run}`, symbol: "VW", imageUrl: "", description: "", creator: key(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
  db.markCoinLaunched(mint, key());
  mints.push(mint);
  return mint;
}

/** An epoch that paid `rows` for these coins; `shares` sets each coin's summed holder shares (the weights its payouts are split by). */
function epoch(coins: string[], rows: { kind: "solana" | "shielded"; zats: bigint; sig?: string }[], shares: Record<string, bigint> = {}): string {
  const id = `epoch-views-${run}-${epochIds.length}`;
  epochIds.push(id);
  db.upsertEpoch({ id, at: new Date((clock += 3_600_000)).toISOString(), coinMints: JSON.stringify(coins), harvestedZats: "1000", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "settled", swapAmountOutZats: null, zcashTxids: "[]" });
  for (const c of coins) if (shares[c] !== undefined) db.recordEpochCoinHarvest(id, c, shares[c]!, [{ wallet: key(), amount: shares[c]! }]);
  rows.forEach((r, i) => {
    const w = key();
    db.planPayout({ epochId: id, wallet: w, kind: r.kind, amountZats: r.zats.toString(), ...(r.kind === "shielded" ? { zcashAddress: "uregtest1x" } : {}) });
    if (r.sig !== "unsent") db.markPayoutSent(id, w, r.kind, r.sig ?? (r.kind === "solana" ? `sig-${id}-${i}` : "d".repeat(64)));
  });
  return id;
}

afterAll(() => {
  const d = db.getDb();
  for (const id of epochIds) for (const t of ["epochs", "payouts", "epoch_coin_shares", "epoch_coin_harvests"]) d.query(`DELETE FROM ${t} WHERE ${t === "epochs" ? "id" : "epochId"} = $id`).run({ $id: id });
  for (const m of mints) d.query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
});

describe("a coin's last payout", () => {
  test("the newest epoch that moved money to the coin's holders: when it ran, what it paid in all, and how much of that was shielded", () => {
    const a = coin();
    const older = epoch([a], [{ kind: "solana", zats: 1_000n }]);
    const newer = epoch([a], [{ kind: "solana", zats: 2_000n }, { kind: "shielded", zats: 700n }]);
    const last = computeAllLastPayouts().get(a)!;
    expect(last.epochId).toBe(newer);
    expect(last).toMatchObject({ totalZats: "2700", shieldedZats: "700" });
    expect(last.at).toBe(db.getEpoch(newer)!.at);
    expect(older).not.toBe(newer);
  });

  test("an epoch whose payouts were carried or are still unsent paid nothing yet: the last payout is the one before it", () => {
    const a = coin();
    const paid = epoch([a], [{ kind: "solana", zats: 5_000n }]);
    epoch([a], [{ kind: "solana", zats: 9_000n, sig: "carried:new_account_below_rent" }]);
    epoch([a], [{ kind: "solana", zats: 8_000n, sig: "unsent" }]);
    expect(computeAllLastPayouts().get(a)!.epochId).toBe(paid);
  });

  test("a coin nobody was paid for has none", () => {
    const a = coin();
    epoch([a], [{ kind: "solana", zats: 1n, sig: "unsent" }]);
    expect(computeAllLastPayouts().has(a)).toBe(false);
  });

  test("an epoch of several coins splits what it paid by each coin's holder shares, floor, the same rule as Coin.rewards", () => {
    const [a, b] = [coin(), coin()];
    epoch([a, b], [{ kind: "solana", zats: 1_000n }, { kind: "shielded", zats: 500n }], { [a]: 3_000n, [b]: 1_000n });
    const last = computeAllLastPayouts();
    expect([last.get(a)!.totalZats, last.get(a)!.shieldedZats]).toEqual(["1125", "375"]); // 3/4 of 1,500 and of 500
    expect([last.get(b)!.totalZats, last.get(b)!.shieldedZats]).toEqual(["375", "125"]);
    const rewards = computeAllCoinRewards();
    expect(rewards.get(a)).toMatchObject({ paidSolanaZec: "750", paidShieldedZec: "375", epochs: 1 });
    expect(BigInt(rewards.get(a)!.paidSolanaZec) + BigInt(rewards.get(a)!.paidShieldedZec)).toBe(BigInt(last.get(a)!.totalZats));
  });

  test("with a single coin, or no recorded shares, the whole epoch is the coin's", () => {
    const [a, b] = [coin(), coin()];
    epoch([a, b], [{ kind: "solana", zats: 1_000n }]); // two coins but no shares recorded
    expect(computeAllLastPayouts().get(a)!.totalZats).toBe("1000");
    expect(computeAllLastPayouts().get(b)!.totalZats).toBe("1000");
  });
});

describe("buildPot", () => {
  const next = "2026-10-06T00:00:00.000Z";

  test("adds the curve's and the graduated pool's accrued fee and splits it the way an epoch splits what it claims (team floor, holders the rest)", () => {
    const p = buildPot({ curve: 600_001n, pool: 400_002n, readAtMs: Date.parse("2026-10-04T12:00:00.000Z") }, next, null);
    const { holders, team } = splitClaim(1_000_003n, config.epoch.team.shareBps);
    expect([p.accruedZats, p.holdersZats, p.teamZats]).toEqual(["1000003", holders.toString(), team.toString()]);
    expect(BigInt(p.holdersZats) + BigInt(p.teamZats)).toBe(1_000_003n);
    expect(team).toBe((1_000_003n * BigInt(config.epoch.team.shareBps)) / 10_000n);
    expect([p.nextPayoutAt, p.lastPayout, p.asOf]).toEqual([next, null, "2026-10-04T12:00:00.000Z"]);
    expect(p.minClaimZats).toBe(config.epoch.minClaimZats.toString());
  });

  test("nothing accrued is zeros; u64-sized fees are exact", () => {
    expect(buildPot({ curve: 0n, pool: 0n, readAtMs: 0 }, null, null)).toMatchObject({ accruedZats: "0", holdersZats: "0", teamZats: "0", nextPayoutAt: null });
    const big = 2n ** 63n;
    const p = buildPot({ curve: big, pool: big - 1n, readAtMs: 0 }, null, null);
    expect(p.accruedZats).toBe((2n * big - 1n).toString());
    expect(BigInt(p.holdersZats) + BigInt(p.teamZats)).toBe(2n * big - 1n);
  });

  test("carries the last payout through unchanged", () => {
    const last = { epochId: "epoch-1", at: "2026-10-03T00:00:00.000Z", totalZats: "10", shieldedZats: "4" };
    expect(buildPot({ curve: 1n, pool: 0n, readAtMs: 0 }, null, last).lastPayout).toEqual(last);
  });
});

describe("metadataUpdateAuthority", () => {
  /** A Token-2022 TLV area: type (u16 LE), length (u16 LE), value. */
  const tlv = (type: number, value: Buffer) => Buffer.concat([Buffer.from([type & 0xff, type >> 8, value.length & 0xff, value.length >> 8]), value]);
  const meta = (authority: Buffer) => Buffer.concat([authority, Buffer.alloc(32, 7), Buffer.from("rest of the metadata")]);

  test("the update authority is the first 32 bytes of the metadata extension; all zeros means nobody", () => {
    const who = Keypair.generate().publicKey;
    expect(metadataUpdateAuthority(tlv(ExtensionType.TokenMetadata, meta(Buffer.from(who.toBytes()))))).toBe(who.toBase58());
    expect(metadataUpdateAuthority(tlv(ExtensionType.TokenMetadata, meta(Buffer.alloc(32))))).toBeNull();
  });

  test("a mint without the extension, with other extensions only, or with nothing, has none", () => {
    expect(metadataUpdateAuthority(Buffer.alloc(0))).toBeNull();
    expect(metadataUpdateAuthority(tlv(ExtensionType.MetadataPointer, Buffer.alloc(64, 1)))).toBeNull();
  });

  test("found after another extension; a truncated extension is none, not a crash", () => {
    const who = Keypair.generate().publicKey;
    expect(metadataUpdateAuthority(Buffer.concat([tlv(ExtensionType.MetadataPointer, Buffer.alloc(64, 1)), tlv(ExtensionType.TokenMetadata, meta(Buffer.from(who.toBytes())))]))).toBe(who.toBase58());
    expect(metadataUpdateAuthority(tlv(ExtensionType.TokenMetadata, Buffer.alloc(10, 1)))).toBeNull();
    expect(PublicKey.default.toBase58()).toBeTruthy();
  });
});

describe("hostile requests to holders, pot and fixed", () => {
  const MINT = key();
  const POOL = key(); // no such account on any chain
  const made = () => db.upsertCoin({ mint: MINT, name: "Views Probe", symbol: "VPRB", imageUrl: "", description: "", creator: key(), createdAt: new Date().toISOString(), feeBps: 100, poolId: POOL, mintDecimals: 6, status: "launched" });
  made();
  afterAll(() => {
    db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: MINT });
  });

  async function call(method: string, path: string) {
    const res = await handleRequest(new Request(`http://pad.test/api${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) }));
    const text = await res.text();
    expect(res.status).not.toBe(500);
    expect(text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:/);
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  test("holders: limit 1..100 and offset 0..10000 are plain decimal integers: 400 bad_request naming the field, before any chain read", async () => {
    for (const [qs, field] of [["limit=0", "limit"], ["limit=101", "limit"], ["limit=-1", "limit"], ["limit=1.5", "limit"], ["limit=1e1", "limit"], ["limit=abc", "limit"], ["limit=", "limit"], ["limit=1&limit=2", "limit"], ["offset=-1", "offset"], ["offset=10001", "offset"], ["offset=x", "offset"], ["offset=1.5", "offset"], ["offset=9999999999", "offset"]] as const) {
      const r = await call("GET", `/coins/${MINT}/holders?${qs}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field });
    }
  });

  test("an unknown or malformed mint is 404 unknown_mint on all three, in every spelling", async () => {
    for (const route of ["holders", "pot", "fixed"]) {
      for (const m of [key(), "garbage", "..%2F..%2Fetc", "%E0%A4%A", encodeURIComponent("$(id)"), "1".repeat(45), "launch-tx"]) {
        const r = await call("GET", `/coins/${m}/${route}`);
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: "unknown_mint" });
      }
    }
  });

  test("a coin whose pool the chain does not have is 503 chain_unavailable on pot and fixed, not a 500, with nothing about the pool in it", async () => {
    for (const route of ["pot", "fixed"]) {
      const r = await call("GET", `/coins/${MINT}/${route}`);
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: "chain_unavailable" });
      expect(r.text).not.toContain(POOL);
    }
  });

  test("holders for a coin whose token accounts cannot be read is 503 chain_unavailable (nothing to show is not an empty list)", async () => {
    const r = await call("GET", `/coins/${MINT}/holders`);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "chain_unavailable" });
  });

  test("only GET is a route; a longer path or a different word is not", async () => {
    for (const route of ["holders", "pot", "fixed", "trades", "quote"]) {
      expect((await call("POST", `/coins/${MINT}/${route}`)).status).toBe(404);
      expect((await call("GET", `/coins/${MINT}/${route}/extra`)).status).toBe(404);
    }
    for (const word of ["holder", "potty", "fix", "trade", "quotes"]) expect((await call("GET", `/coins/${MINT}/${word}`)).status).toBe(404);
  });

  test("the pool's last payout is read from a cache that is forgotten with the other public numbers", () => {
    clearStatsCache();
    expect(computeAllLastPayouts()).toBeInstanceOf(Map);
  });
});
