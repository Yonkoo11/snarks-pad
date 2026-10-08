// Audit S6, product decision 1: fees of a coin nobody holds through a window are not claimed, and fees already held for such a
// coin wait 30 days for its holders, then join the next paying round (a quarter to the team, the rest pro rata to the holders
// that round pays), recorded under the orphaned mint.
//   Before: every due run claimed every launched coin; with no eligible holder the claim sat in the keeper account as orphaned
//   proceeds, and the public record showed less than the chain showed claimed. No rule ever released a bucket whose coin stayed
//   without holders. No chain here: the claim step is injected, the chain config check is a no-op.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import * as db from "../src/db";
import { ORPHAN_RELEASE_TEAM_BPS, claimRemainingCoins, claimWindowStart, discardEmptyDraft, releaseStaleOrphans, type ClaimDeps } from "../src/epoch/engine";
import { getTreasuryView } from "../src/ledger";

const w = () => Keypair.generate().publicKey.toBase58();
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const cleanups: (() => void)[] = [];
const clearFloor = () => db.getDb().query("DELETE FROM meta WHERE key IN ('claim_window_floor_at','claim_skipped_in_draft')").run();
beforeEach(clearFloor);
afterEach(() => {
  clearFloor();
  for (const c of cleanups.splice(0)) c();
});

function draft(at: string): string {
  const id = `epoch-orph-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at, coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
  cleanups.push(() => db.deleteDraftEpoch(id));
  return id;
}

function launchedCoin(): db.CoinRow {
  const row: db.CoinRow = { mint: w(), name: "O", symbol: "O", imageUrl: "", description: "", creator: w(), createdAt: iso(Date.now()), feeBps: 100, poolId: w(), mintDecimals: 6, status: "launched", configId: null };
  db.upsertCoin(row);
  cleanups.push(() => db.upsertCoin({ ...row, status: "pending" })); // a pending coin is never claimed by other tests
  return row;
}

/** A bucket of `zats` for `mint` that has been held since `sinceAt`. */
function bucket(mint: string, zats: bigint, sinceAt: string): void {
  db.setOrphanedCoinProceeds(mint, zats);
  db.getDb().query("UPDATE coin_orphaned_zats SET sinceAt = $s WHERE mint = $m").run({ $s: sinceAt, $m: mint });
  cleanups.push(() => db.setOrphanedCoinProceeds(mint, 0n));
}

describe("no claim without an eligible holder", () => {
  test("a coin nobody held through its window is not claimed; the draft that skipped it moves the next window past its samples", async () => {
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0;
    const coin = launchedCoin();
    const holder = w();
    const t1 = Date.parse("2098-03-01T00:00:00.000Z");
    db.insertHolderSample(coin.mint, iso(t1 - 2 * 3_600_000), []); // taken before anyone bought
    db.insertHolderSample(coin.mint, iso(t1 - 3_600_000), [{ wallet: holder, balance: 100n }]);
    let claims = 0;
    // Other launched coins in the shared test database have no holder here, so the gate skips them; only this coin is ever claimed.
    const deps: ClaimDeps = {
      ensureConfig: async () => {},
      claimCoin: async (_e, c) => { if (c.mint !== coin.mint) throw new Error("another coin reached the claim"); claims += 1; return 1_000n; },
      currentHolders: async (mint) => (mint === coin.mint ? [{ wallet: holder, balance: 100n }] : []),
    };
    const e1 = draft(iso(t1));
    await claimRemainingCoins(e1, deps);
    expect(claims).toBe(0); // the early empty sample: the holder's least balance in the window is 0, nobody is eligible
    expect(db.listEpochCoinHarvests(e1)).toEqual([]);
    expect(db.getOrphanedCoinProceeds(coin.mint)).toBe(0n);
    discardEmptyDraft(e1);
    expect(claimWindowStart(iso(t1 + 3 * 3_600_000))).toBe(iso(t1)); // the window now starts at the skipped draft
    expect(db.getMeta("claim_skipped_in_draft")).toBeNull();

    db.insertHolderSample(coin.mint, iso(t1 + 3_600_000), [{ wallet: holder, balance: 100n }]);
    const e2 = draft(iso(t1 + 3 * 3_600_000));
    await claimRemainingCoins(e2, deps);
    expect(claims).toBe(1);
    expect(db.combineEpochCoinShares(e2).get(holder)).toBe(750n); // the whole 1,000 claim: the team's quarter, the holder the rest
  });

  test("a coin with an eligible holder is claimed as before; a draft that skipped nothing and claimed nothing does not move the window", async () => {
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0;
    const coin = launchedCoin();
    const holder = w();
    let claims = 0;
    const deps: ClaimDeps = {
      ensureConfig: async () => {},
      claimCoin: async (_e, c) => { if (c.mint === coin.mint) claims += 1; return 0n; },
      currentHolders: async (mint) => (mint === coin.mint ? [{ wallet: holder, balance: 5n }] : []),
    };
    const at = "2098-04-01T00:00:00.000Z";
    const before = claimWindowStart("2098-04-02T00:00:00.000Z");
    const e = draft(at);
    await claimRemainingCoins(e, deps);
    expect(claims).toBe(1);
    // claimed 0: a harvest row of 0 is recorded (the coin is done for this epoch), which moves the window as before
    expect(db.listEpochCoinHarvests(e).map((h) => h.mint)).toContain(coin.mint);
    discardEmptyDraft(e);
    expect(claimWindowStart("2098-04-02T00:00:00.000Z")).toBe(at);
    clearFloor();
    expect(claimWindowStart("2098-04-02T00:00:00.000Z")).toBe(before);
  });
});

describe("a bucket held 30 days joins the next paying round", () => {
  test("the bucket's age starts when it first holds money, stays while it holds, and clears when it empties", () => {
    const m = w();
    cleanups.push(() => db.setOrphanedCoinProceeds(m, 0n));
    db.setOrphanedCoinProceeds(m, 100n);
    const since = db.listOrphanedCoinProceeds().find((o) => o.mint === m)!.sinceAt!;
    expect(Date.now() - Date.parse(since) < 5_000).toBe(true);
    db.setOrphanedCoinProceeds(m, 250n);
    expect(db.listOrphanedCoinProceeds().find((o) => o.mint === m)).toMatchObject({ amountZats: "250", sinceAt: since });
    db.setOrphanedCoinProceeds(m, 0n);
    expect(db.listOrphanedCoinProceeds().find((o) => o.mint === m)).toBeUndefined();
    expect((db.getDb().query("SELECT sinceAt FROM coin_orphaned_zats WHERE mint = $m").get({ $m: m }) as { sinceAt: string | null }).sinceAt).toBeNull();
  });

  test("a stale bucket is recorded as a harvest under its own mint: a quarter to the team, the rest pro rata to this round's paid holders; a young one waits", () => {
    const now = Date.parse("2098-05-01T00:00:00.000Z");
    const stale = w();
    const young = w();
    bucket(stale, 4_000n, iso(now - (config.epoch.orphanReleaseDays + 1) * DAY));
    bucket(young, 9_000n, iso(now - (config.epoch.orphanReleaseDays - 1) * DAY));
    const paying = w();
    const [a, b] = [w(), w()];
    const e = draft(iso(now));
    db.recordEpochCoinHarvest(e, paying, 10_000n, [{ wallet: a, amount: 2_500n }, { wallet: b, amount: 7_500n }], 0n, 0n);

    releaseStaleOrphans(e, now);

    const released = db.listEpochCoinHarvests(e).find((h) => h.mint === stale);
    expect(released).toMatchObject({ soldForZatsQuote: "4000", teamZats: "1000" });
    expect(ORPHAN_RELEASE_TEAM_BPS).toBe(2_500);
    // The shares written under the orphaned mint (other tests leave buckets in the shared database, released here too at this far-off `now`).
    const shares = new Map(db.listEpochCoinShares(e).filter((r) => r.mint === stale).map((r) => [r.wallet, BigInt(r.amountZats)]));
    expect(shares.get(a)).toBe(750n); // 3,000 to the holders, 1:3
    expect(shares.get(b)).toBe(2_250n);
    expect(db.combineEpochCoinShares(e).get(a)! >= 2_500n + 750n).toBe(true);
    expect(db.getOrphanedCoinProceeds(stale)).toBe(0n);
    expect(db.getOrphanedCoinProceeds(young)).toBe(9_000n);
    expect(db.listEpochCoinHarvests(e).some((h) => h.mint === young)).toBe(false);
  });

  test("a round that pays nobody releases nothing: the bucket waits for one that does", () => {
    const now = Date.parse("2098-06-01T00:00:00.000Z");
    const stale = w();
    bucket(stale, 4_000n, iso(now - 40 * DAY));
    const e = draft(iso(now));
    releaseStaleOrphans(e, now);
    expect(db.getOrphanedCoinProceeds(stale)).toBe(4_000n);
    expect(db.listEpochCoinHarvests(e)).toEqual([]);
  });

  test("the treasury view lists each bucket with when it started and when it is due to join a round", async () => {
    const m = w();
    const since = "2098-07-01T00:00:00.000Z";
    bucket(m, 777n, since);
    const view = await getTreasuryView();
    expect(view.orphaned.find((o) => o.mint === m)).toEqual({ mint: m, amountZats: "777", sinceAt: since, releaseAt: iso(Date.parse(since) + config.epoch.orphanReleaseDays * DAY) });
    expect(BigInt(view.orphanedZats) >= 777n).toBe(true);
  });
});
