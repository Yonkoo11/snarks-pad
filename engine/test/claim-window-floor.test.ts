// Found by the server soak (2026-10-03, audit/STRESS-REPORT.md scenario 4 on the VPS): the keeper took a holder sample
// before anyone held two new coins, then every holder bought. Each due run claimed the fees, found no holder with a
// non-zero minimum (the early empty sample), held the claim as orphaned proceeds and discarded the draft epoch. The
// discarded draft did not move the sample window, so the empty sample stayed in every later window and the holders
// were never paid. A discarded draft that recorded claims now starts the next window. The window arithmetic is DB-level;
// the first test goes through claimRemainingCoins, which starts with ensureDbcConfig() and so reads the local validator,
// hence it runs only where one is up (a fresh clone without the chain got a connection error, not a skip, 2026-10-04).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import * as db from "../src/db";
import { claimRemainingCoins, claimWindowStart, discardEmptyDraft, type ClaimDeps } from "../src/epoch/engine";
import { validatorUp } from "./helpers/validator-up";

const LIVE = await validatorUp();

const w = () => Keypair.generate().publicKey.toBase58();
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;
const draft = (id: string, at: string) =>
  db.upsertEpoch({ id, at, coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
const cleanups: (() => void)[] = [];
// The test DB persists between runs: start every test without a floor left by an earlier run.
const clearFloor = () => db.getDb().query("DELETE FROM meta WHERE key = 'claim_window_floor_at'").run();
beforeEach(clearFloor);
afterEach(() => {
  clearFloor();
  for (const c of cleanups.splice(0)) c();
});

describe("claim window after a discarded draft", () => {
  test.if(LIVE)("holders who arrived after an early empty sample: the first run claims nothing (no eligible holder, audit S6 decision 1) and moves the window; the next run claims and pays", async () => {
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0; // devnet/local value
    const holder = w();
    const mint = w();
    const row: db.CoinRow = { mint, name: "F", symbol: "F", imageUrl: "", description: "", creator: w(), createdAt: iso(Date.now()), feeBps: 100, poolId: w(), mintDecimals: 6, status: "launched", configId: null };
    db.upsertCoin(row);
    const t1 = Date.parse("2095-03-01T00:00:00.000Z");
    db.insertHolderSample(mint, iso(t1 - 3 * H), []); // taken before anyone bought
    db.insertHolderSample(mint, iso(t1 - 2 * H), [{ wallet: holder, balance: 100n }]);
    const claims = [1_000n, 500n];
    const deps: ClaimDeps = {
      claimCoin: async (_e, coin) => (coin.mint === mint ? claims.shift()! : 0n),
      currentHolders: async () => [{ wallet: holder, balance: 100n }],
    };

    const e1 = `epoch-floor-${crypto.randomUUID()}`;
    draft(e1, iso(t1));
    cleanups.push(() => { db.deleteDraftEpoch(e1); db.upsertCoin({ ...row, status: "pending" }); });
    await claimRemainingCoins(e1, deps);
    expect(db.combineEpochCoinShares(e1).size).toBe(0); // the empty sample: nobody eligible this run
    expect(claims).toEqual([1_000n, 500n]); // so the coin was not claimed at all; its fees stay in the pool
    expect(db.getOrphanedCoinProceeds(mint)).toBe(0n);
    discardEmptyDraft(e1); // what runEpoch does when finalizeHarvest finds nothing to pay
    expect(claimWindowStart(iso(t1 + 3 * H))).toBe(iso(t1)); // the skipped draft moved the window

    db.insertHolderSample(mint, iso(t1 + 1 * H), [{ wallet: holder, balance: 100n }]);
    const e2 = `epoch-floor-${crypto.randomUUID()}`;
    draft(e2, iso(t1 + 3 * H));
    cleanups.push(() => db.deleteDraftEpoch(e2));
    await claimRemainingCoins(e2, deps);
    // The first claim (1,000, the fees of both windows) happens now; the team keeps 25%, the holder gets 750.
    expect(db.combineEpochCoinShares(e2).get(holder)).toBe(750n);
    expect(db.getOrphanedCoinProceeds(mint)).toBe(0n);
  });

  test("a draft discarded with no claim recorded does not move the window", () => {
    const at = "2096-01-01T00:00:00.000Z";
    const before = claimWindowStart("2096-01-02T00:00:00.000Z");
    const e = `epoch-floor-${crypto.randomUUID()}`;
    draft(e, at);
    discardEmptyDraft(e);
    expect(claimWindowStart("2096-01-02T00:00:00.000Z")).toBe(before);
  });
});
