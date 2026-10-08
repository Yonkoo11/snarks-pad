// Fixes verified defect (review NIT 10): a coin whose holder snapshot came
// back empty (every holder excluded, e.g. all supply sits in pool vaults)
// still gets sold for real zats each epoch; with nobody eligible to pay, those
// zats used to be recorded as "sold" with zero shares -- silently
// unattributed forever. src/db.ts's coin_orphaned_zats + recordEpochCoinHarvest's
// resetOrphanedZatsTo hold them until a later epoch has eligible holders.
// This test exercises the exact call sequence src/epoch/engine.ts's
// harvestRemainingCoins makes, at the DB layer (no chain needed).
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { proRataSplit } from "../src/epoch/math";

function mint(): string {
  return `mint-test-${crypto.randomUUID()}`;
}
function epochId(): string {
  return `epoch-test-${crypto.randomUUID()}`;
}

describe("orphaned coin proceeds (finding 10)", () => {
  test("a coin with zero eligible holders holds its whole sale in the orphaned bucket, and contributes 0 to the epoch's public total", () => {
    const m = mint();
    const e1 = epochId();

    // Mirrors harvestRemainingCoins: sold 1000 zats, snapshotHolders came back
    // empty, proRataSplit([]) is [].
    const shares = proRataSplit(1000n, []);
    expect(shares).toEqual([]);
    db.recordEpochCoinHarvest(e1, m, 0n, [], 1000n);

    expect(db.getOrphanedCoinProceeds(m)).toBe(1000n);
    expect(db.listEpochCoinHarvests(e1).find((h) => h.mint === m)!.soldForZatsQuote).toBe("0");
    expect(db.combineEpochCoinShares(e1).size).toBe(0);
  });

  test("a later epoch with eligible holders folds in every previously orphaned zat, and clears the bucket -- atomically with recording the harvest", () => {
    const m = mint();
    const e1 = epochId();
    db.recordEpochCoinHarvest(e1, m, 0n, [], 1000n); // orphaned from a prior no-holder epoch

    const e2 = epochId();
    const orphaned = db.getOrphanedCoinProceeds(m);
    expect(orphaned).toBe(1000n);
    const soldThisEpoch = 500n;
    const toDistribute = soldThisEpoch + orphaned; // 1500
    const shares = proRataSplit(toDistribute, [
      { wallet: "alice", balance: 1n },
      { wallet: "bob", balance: 1n },
    ]);
    db.recordEpochCoinHarvest(e2, m, toDistribute, shares, 0n);

    expect(db.getOrphanedCoinProceeds(m)).toBe(0n); // fully folded in, not lost, not double-counted
    expect(db.listEpochCoinHarvests(e2).find((h) => h.mint === m)!.soldForZatsQuote).toBe("1500");
    const combined = db.combineEpochCoinShares(e2);
    expect(combined.get("alice")! + combined.get("bob")!).toBe(1500n); // every orphaned zat is now attributed to someone
  });

  test("orphaned proceeds accumulate across consecutive no-holder epochs instead of overwriting each other", () => {
    const m = mint();
    db.recordEpochCoinHarvest(epochId(), m, 0n, [], 1000n);
    expect(db.getOrphanedCoinProceeds(m)).toBe(1000n);

    // A second consecutive epoch sells more, still with zero eligible holders.
    const stillOrphaned = db.getOrphanedCoinProceeds(m) + 300n;
    db.recordEpochCoinHarvest(epochId(), m, 0n, [], stillOrphaned);
    expect(db.getOrphanedCoinProceeds(m)).toBe(1300n);
  });

  test("a coin that always has eligible holders is unaffected (orphaned stays 0 throughout)", () => {
    const m = mint();
    const shares = proRataSplit(900n, [{ wallet: "carol", balance: 1n }]);
    db.recordEpochCoinHarvest(epochId(), m, 900n, shares, 0n);
    expect(db.getOrphanedCoinProceeds(m)).toBe(0n);
  });
});
