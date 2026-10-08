// Per-coin rewards on GET /api/coins (the Home card must show a coin's OWN paid-to-holders, never the pad-wide total),
// and the featured-mints listing filter.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { computeAllCoinRewards, computeCoinRewards } from "../src/api";
import { visibleCoins } from "../src/dbc/visible";
import * as db from "../src/db";

const mint = () => Keypair.generate().publicKey.toBase58();

function epoch(coinMints: string[]): string {
  const id = `epoch-test-${crypto.randomUUID()}`;
  db.upsertEpoch({
    id, at: new Date().toISOString(), coinMints: JSON.stringify(coinMints), harvestedZats: "1000", feeZats: "0",
    status: "ok", swapProvider: null, swapRef: null, swapState: "failed_before_funds_moved", swapAmountOutZats: null, zcashTxids: "[]",
  });
  return id;
}

describe("per-coin rewards", () => {
  test("an epoch with two coins splits each rail's total by the coins' holder shares, never the whole total under each coin", () => {
    const a = mint();
    const b = mint();
    const id = epoch([a, b]);
    db.recordEpochCoinHarvest(id, a, 750n, [{ wallet: "w1", amount: 300n }, { wallet: "w2", amount: 200n }]);
    db.recordEpochCoinHarvest(id, b, 250n, [{ wallet: "w1", amount: 100n }, { wallet: "w2", amount: 400n }]);
    db.planPayout({ epochId: id, wallet: "w1", kind: "solana", amountZats: "400" });
    db.markPayoutSent(id, "w1", "solana", "sig-w1");
    db.planPayout({ epochId: id, wallet: "w2", kind: "shielded", amountZats: "600", zcashAddress: "u1x" });
    db.markPayoutSent(id, "w2", "shielded", "ab".repeat(32));

    const all = computeAllCoinRewards();
    // shares: a = 500, b = 500 of 1000, so each coin gets half of 400 solana and half of 600 shielded
    expect(all.get(a)).toEqual({ paidSolanaZec: "200", paidShieldedZec: "300", epochs: 1 });
    expect(all.get(b)).toEqual({ paidSolanaZec: "200", paidShieldedZec: "300", epochs: 1 });
    expect(computeCoinRewards(a)).toEqual(all.get(a)!);
  });

  test("a coin that was in no epoch has zero, and a single-coin epoch keeps the whole amount", () => {
    const solo = mint();
    const id = epoch([solo]);
    db.planPayout({ epochId: id, wallet: "w9", kind: "solana", amountZats: "700" });
    db.markPayoutSent(id, "w9", "solana", "sig-w9");
    expect(computeCoinRewards(solo)).toEqual({ paidSolanaZec: "700", paidShieldedZec: "0", epochs: 1 });
    expect(computeCoinRewards(mint())).toEqual({ paidSolanaZec: "0", paidShieldedZec: "0", epochs: 0 });
  });
});

describe("featured mints listing", () => {
  const coins = [{ mint: "A" }, { mint: "B" }, { mint: "C" }];
  test("no featured list lists everything; a list keeps only those mints; all=1 lists everything", () => {
    expect(visibleCoins(coins, false, [])).toEqual(coins);
    expect(visibleCoins(coins, false, ["C", "A"])).toEqual([{ mint: "A" }, { mint: "C" }]);
    expect(visibleCoins(coins, true, ["C"])).toEqual(coins);
  });
});
