// GET /api/tiers (contract v2.7): beside each tier's fee split it now names the ZEC the curve must raise to graduate and how much of the
// graduated pool's liquidity is locked for good, and the answer names the token every coin of the pad is paired with. The Launch page prints
// exactly these, so a wrong number here is a wrong sentence in front of a creator.
import { describe, expect, test } from "bun:test";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import { buildConfigParams } from "../src/dbc/config";
import { REVIEWED_SERIALIZED, REVIEWED_TIERS, TIER_MENU_BPS } from "../src/dbc/reviewed";
import { factsOfTier, feeLineOfTier, graduationText, liquidityText } from "../../web/src/lib/launch";
import type { Tier } from "../../web/src/lib/types";

interface TierAnswer {
  feeBps: number;
  migrationThresholdZats: string;
  liquidity: { partnerLockedPct: number; creatorLockedPct: number; unlockedPct: number };
}

async function tiersAnswer(): Promise<{ tiers: TierAnswer[]; quoteMint: string }> {
  const res = await handleRequest(new Request("http://pad.test/api/tiers"));
  expect(res.status).toBe(200);
  return (await res.json()) as { tiers: TierAnswer[]; quoteMint: string };
}

describe("GET /api/tiers, v2.7 additions", () => {
  test("names the quote token every coin is paired with", async () => {
    const a = await tiersAnswer();
    expect(a.quoteMint).toBe(config.solana.dbc.quoteMint.toBase58());
  });

  test("each tier carries the zats the curve must raise, as the reviewed config the engine builds for it says", async () => {
    const a = await tiersAnswer();
    expect(a.tiers.map((t) => t.feeBps)).toEqual([...TIER_MENU_BPS]);
    for (const t of a.tiers) {
      expect(t.migrationThresholdZats).toMatch(/^[1-9][0-9]*$/);
      expect(t.migrationThresholdZats).toBe(buildConfigParams(t.feeBps).migrationQuoteThreshold.toString());
    }
    expect(a.tiers.find((t) => t.feeBps === 100)!.migrationThresholdZats).toBe(REVIEWED_SERIALIZED.migrationQuoteThreshold);
  });

  test("each tier's locked liquidity is the reviewed table's, and what is not locked is the rest of 100", async () => {
    const a = await tiersAnswer();
    for (const t of a.tiers) {
      const reviewed = REVIEWED_TIERS[t.feeBps]!;
      expect(t.liquidity.partnerLockedPct).toBe(reviewed.partnerLockedLpPercentage);
      expect(t.liquidity.creatorLockedPct).toBe(reviewed.creatorLockedLpPercentage);
      expect(t.liquidity.partnerLockedPct + t.liquidity.creatorLockedPct + t.liquidity.unlockedPct).toBe(100);
      expect(t.liquidity.unlockedPct).toBeGreaterThanOrEqual(0);
    }
  });

  test("the Launch page's words for each tier, built from this answer, are the owner's policy: one fee line per tier, the shares on the preview card, the liquidity is all locked, the curve holds 6.67 ZEC", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/tiers"));
    const tiers = ((await res.json()) as { tiers: Tier[] }).tiers;
    // the line under the tier picker, one per tier, read straight from the answer
    expect(tiers.map((t) => { const l = feeLineOfTier(t); return l.fee + l.rest; })).toEqual([
      "1% on every trade, paid in ZEC, fixed at launch.",
      "2% on every trade, paid in ZEC, fixed at launch.",
      "4% on every trade, paid in ZEC, fixed at launch.",
      "6% on every trade, paid in ZEC, fixed at launch.",
      "10% on every trade, paid in ZEC, fixed at launch.",
    ]);
    expect(tiers.map((t) => factsOfTier(t).creatorShare)).toEqual([null, "40%", "60%", "66.4%", "72%"]);
    expect(tiers.map((t) => factsOfTier(t).holdersShare)).toEqual(["10%", "5%", "2.5%", "1.7%", "1%"]);
    for (const t of tiers) {
      expect(liquidityText(t.liquidity)).toBe("Locked for good");
      expect(graduationText(t)).toBe("6.67 ZEC");
    }
  });

  test("the fee-split fields that were there before are still there", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/tiers"));
    const first = ((await res.json()) as { tiers: Record<string, unknown>[] }).tiers[0]!;
    for (const k of ["feeBps", "available", "postGraduationFeeBps", "roundTripCostBps", "meteoraShareBps", "creatorShareBps", "holderShareBps", "teamShareBps", "claimedShareBps"]) {
      expect(first).toHaveProperty(k);
    }
  });
});
