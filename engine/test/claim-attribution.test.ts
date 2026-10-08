// Needs the local validator on 127.0.0.1:8899 (createDbcConfig sends a real transaction): the chain lane, not the fast lane.
// Audit S6-A1: a claim that landed and was measured must never be left without a harvest row for good.
//   Before: claimCoinFees confirmed the trading claim, then the next kind's read threw; claimOneCoin swallowed it and the
//   draft was finalized (or discarded) at once, because only claims with status != confirmed held it back. The next epoch
//   has a new claim key, so that ZEC sat in the keeper account attributed to nothing.
//   Now: a confirmed claim whose coin has no harvest row keeps the draft open, and the coin is retried.
// Also: the sample gate does not skip a coin whose claim already started this epoch (samples are pruned after 30 days
// and an owner approval can take days), and a chain-down error is not swallowed per coin (the scheduler backs off).
import { afterEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import * as db from "../src/db";
import { claimRemainingCoins, runEpoch, type ClaimDeps } from "../src/epoch/engine";
import { ChainUnavailableError } from "../src/rpcGuard";
import type { SwapAdapter } from "../src/swap/types";

const w = () => Keypair.generate().publicKey.toBase58();
const neverSwap: SwapAdapter = {
  provider: "simulated",
  async quote() { throw new Error("must never reach the swap"); },
  async submit() { throw new Error("must never reach the swap"); },
  async status() { throw new Error("must never reach the swap"); },
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** This test's own draft, made first so runEpoch resumes it rather than whatever epoch another test left behind in the shared DB. */
function draftEpoch(): string {
  const id = `epoch-attr-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
  cleanups.push(() => db.deleteDraftEpoch(id));
  return id;
}

function launchedCoin(): db.CoinRow {
  const row: db.CoinRow = { mint: w(), name: "A", symbol: "A", imageUrl: "", description: "", creator: w(), createdAt: new Date().toISOString(), feeBps: 100, poolId: w(), mintDecimals: 6, status: "launched", configId: null };
  db.upsertCoin(row);
  cleanups.push(() => db.upsertCoin({ ...row, status: "pending" })); // a pending coin is never claimed by other tests
  return row;
}

const confirmedTradingClaim = (epochId: string, mint: string, amount: bigint) => {
  db.recordClaimSigned({ epochId, mint, kind: "trading", sig: "sig-" + crypto.randomUUID(), rawTx: "AA==", lastValidBlockHeight: 10, phase: "single" });
  db.recordClaimConfirmed(epochId, mint, "trading", amount);
};

describe("audit S6-A1: a measured claim with no harvest row keeps the draft open", () => {
  test("the trading claim is confirmed, the surplus read throws: the draft waits, nothing is paid, the retry attributes the whole claim", async () => {
    const coin = launchedCoin();
    const holder = w();
    let runs = 0;
    const deps: ClaimDeps = {
      claimCoin: async (epochId, c) => {
        if (c.mint !== coin.mint) return 0n;
        runs += 1;
        if (runs === 1) {
          confirmedTradingClaim(epochId, c.mint, 1_000n); // what runClaim does for the trading kind
          throw new Error("getPool failed: 503"); // what hasPartnerSurplus does on an RPC error
        }
        return 1_000n; // the retry: runClaim returns the recorded amount, the surplus read works this time
      },
      currentHolders: async () => [{ wallet: holder, balance: 100n }],
    };
    const draftId = draftEpoch();
    const out = await runEpoch(neverSwap, (id) => claimRemainingCoins(id, deps));
    expect(out.epoch).toBeNull();
    expect(out.awaitingClaims?.join("\n")).toContain(`trading claim for ${coin.mint} (measured 1000 zats`);
    expect(db.getEpoch(draftId)?.status).toBe("harvesting");
    expect(db.getPayouts(draftId)).toEqual([]);
    expect(db.listEpochCoinHarvests(draftId).find((h) => h.mint === coin.mint)).toBeUndefined();
    expect(db.listMeasuredClaimsWithoutHarvest(draftId).map((c) => c.mint)).toEqual([coin.mint]);
    expect(JSON.stringify(db.listOpenAlerts())).toContain("claim_unattributed"); // loud: the operator hears about a coin that holds the round

    await claimRemainingCoins(draftId, deps); // the next run's claim step
    expect(runs).toBe(2);
    expect(db.listMeasuredClaimsWithoutHarvest(draftId)).toEqual([]);
    const harvest = db.listEpochCoinHarvests(draftId).find((h) => h.mint === coin.mint);
    expect(harvest?.soldForZatsQuote).toBe("1000");
    expect(db.combineEpochCoinShares(draftId).get(holder)).toBe(750n); // 75% to the holder, the team keeps 25%
  });

  test("a chain-down error is not swallowed per coin: the run fails, the scheduler backs off, the draft stays", async () => {
    const coin = launchedCoin();
    const deps: ClaimDeps = {
      claimCoin: async () => { throw new ChainUnavailableError("timeout", "rpc gave up"); },
      currentHolders: async () => [{ wallet: w(), balance: 1n }], // an eligible holder, so the claim is reached (audit S6 decision 1 skips a coin without one)
    };
    const draftId = draftEpoch();
    await expect(runEpoch(neverSwap, (id) => claimRemainingCoins(id, deps))).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(db.getEpoch(draftId)?.status).toBe("harvesting");
    expect(db.listEpochCoinHarvests(draftId).find((h) => h.mint === coin.mint)).toBeUndefined();
  });
});

describe("audit S6-A1: the sample gate decides once per coin and epoch", () => {
  test("too few samples skips a coin with no claim yet, but never one whose claim already started", async () => {
    const snapshots = config.epoch.snapshots as { minWindowSamples: number };
    const saved = snapshots.minWindowSamples;
    snapshots.minWindowSamples = 3;
    cleanups.push(() => { snapshots.minWindowSamples = saved; });
    const coin = launchedCoin();
    const epochId = `epoch-gate-${crypto.randomUUID()}`;
    db.upsertEpoch({ id: epochId, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
    cleanups.push(() => db.deleteDraftEpoch(epochId));
    let calls = 0;
    const deps: ClaimDeps = { claimCoin: async () => { calls += 1; return 0n; }, currentHolders: async () => [] };

    await claimRemainingCoins(epochId, deps); // no samples in the window, no claim started: skipped
    expect(calls).toBe(0);

    db.recordClaimSigned({ epochId, mint: coin.mint, kind: "trading", sig: "sig-" + crypto.randomUUID(), rawTx: "AA==", lastValidBlockHeight: 10, phase: "propose" });
    db.setClaimPhase(epochId, coin.mint, "trading", "await"); // a proposal is out, waiting for the owner; the window's samples have since been pruned
    await claimRemainingCoins(epochId, deps);
    expect(calls).toBe(1); // resumed: the decision was made when the claim started
  });
});
