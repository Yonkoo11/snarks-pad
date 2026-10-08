// Audit O-1: the snapshot is not one predictable moment. N samples at random times inside the epoch window,
// one more at claim time, and a holder's weight is the MINIMUM balance it showed in them.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import * as db from "../src/db";
import { claimRemainingCoins, type ClaimDeps } from "../src/epoch/engine";
import { validatorUp } from "./helpers/validator-up";
import { drawSnapshotTimes, ensurePlan, minimumBalanceHolders, takeDueSamples, takeSamplesNow } from "../src/epoch/snapshots";

const w = () => Keypair.generate().publicKey.toBase58();
const holder = (wallet: string, balance: bigint) => ({ wallet, balance });

describe("drawSnapshotTimes", () => {
  const DAY = 24 * 3_600_000;
  test("one instant inside each of N equal slices, ascending, from the injected generator", () => {
    const calls: [number, number][] = [];
    const rand = (min: number, max: number) => {
      calls.push([min, max]);
      return max - 1; // the last millisecond of every slice
    };
    const t = drawSnapshotTimes(1_000, 1_000 + 6 * DAY, 6, rand);
    expect(t).toEqual([0, 1, 2, 3, 4, 5].map((i) => 1_000 + i * DAY + DAY - 1));
    expect(calls).toEqual(Array.from({ length: 6 }, () => [0, DAY]));
  });

  test("with the real generator every draw stays in its slice, and two draws differ", () => {
    const start = Date.now();
    const a = drawSnapshotTimes(start, start + 2 * DAY, 6);
    const b = drawSnapshotTimes(start, start + 2 * DAY, 6);
    for (const draw of [a, b]) {
      draw.forEach((t, i) => {
        expect(t).toBeGreaterThanOrEqual(start + (i * 2 * DAY) / 6 - 1);
        expect(t).toBeLessThan(start + ((i + 1) * 2 * DAY) / 6);
      });
    }
    expect(a).not.toEqual(b); // 6 draws among 2.9e7 values each: equal only if the generator is constant
  });

  test("the generator is the OS CSPRNG, never Math.random", () => {
    const src = readFileSync(join(config.paths.engineRoot, "src", "epoch", "snapshots.ts"), "utf8");
    expect(src).toContain('import { randomInt } from "node:crypto"');
    expect(src).not.toMatch(/Math\.random/);
  });

  test("a window too small for the count is refused", () => {
    expect(() => drawSnapshotTimes(0, 3, 6)).toThrow(/cannot place/);
  });
});

describe("minimumBalanceHolders", () => {
  const [a, b, c] = [w(), w(), w()];
  test("the least balance across every sample", () => {
    const out = minimumBalanceHolders([[holder(a, 100n), holder(b, 50n)], [holder(a, 80n), holder(b, 70n)], [holder(a, 120n), holder(b, 60n)]]);
    expect(new Map(out.map((h) => [h.wallet, h.balance]))).toEqual(new Map([[a, 80n], [b, 50n]]));
  });
  test("a wallet missing from any sample weighs nothing", () => {
    const out = minimumBalanceHolders([[holder(a, 100n)], [holder(a, 100n), holder(c, 999n)], [holder(a, 100n)]]);
    expect(out.map((h) => h.wallet)).toEqual([a]);
  });
  test("owners excluded now are dropped even if the samples kept them", () => {
    expect(minimumBalanceHolders([[holder(a, 5n), holder(b, 5n)]], new Set([b])).map((h) => h.wallet)).toEqual([a]);
  });
  test("no samples, no holders", () => {
    expect(minimumBalanceHolders([])).toEqual([]);
  });
});

describe.if(await validatorUp())("a sniper that buys before the claim-time sample and sells after it earns ~0 (the claim step reads the chain: live validator)", () => {
  const original = config.epoch.snapshots.minWindowSamples;
  afterEach(() => {
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = original;
  });

  /** A launched coin with `samples` window samples (taken in the open window of a far-future epoch) and a claim of `claimed`. */
  function setup(opts: { samples: [string, bigint][][]; now: [string, bigint][]; claimed: bigint }) {
    const mint = w();
    const epochAt = "2090-01-10T00:00:00.000Z";
    const row: db.CoinRow = { mint, name: "S", symbol: "S", imageUrl: "", description: "", creator: w(), createdAt: new Date().toISOString(), feeBps: 100, poolId: w(), mintDecimals: 6, status: "launched", configId: null };
    db.upsertCoin(row);
    opts.samples.forEach((s, i) => db.insertHolderSample(mint, new Date(Date.parse(epochAt) - (opts.samples.length - i) * 3_600_000).toISOString(), s.map(([x, y]) => holder(x, y))));
    const epochId = `epoch-sample-${crypto.randomUUID()}`;
    db.upsertEpoch({ id: epochId, at: epochAt, coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
    const claimedCoins: string[] = [];
    const deps: ClaimDeps = {
      claimCoin: async (_e, coin) => {
        if (coin.mint !== mint) return 0n;
        claimedCoins.push(coin.mint);
        return opts.claimed;
      },
      currentHolders: async () => opts.now.map(([x, y]) => holder(x, y)),
    };
    const run = async () => {
      await claimRemainingCoins(epochId, deps);
      return db.combineEpochCoinShares(epochId);
    };
    const cleanup = () => {
      db.deleteDraftEpoch(epochId);
      db.upsertCoin({ ...row, status: "pending" }); // later test files must not see a launched coin that has no pool
    };
    return { mint, epochId, run, claimedCoins, cleanup };
  }

  // Owner policy 2026-10-02: the team keeps 25% of each claim, so holders split 75% of `claimed`.
  test("the sniper holds only at claim time: the honest holder takes the whole holders' share of the claim", async () => {
    const honest = w();
    const sniper = w();
    const s = setup({
      samples: [[[honest, 100n]], [[honest, 100n]], [[honest, 100n]]],
      now: [[honest, 100n], [sniper, 1_000_000n]], // ten thousand times the honest balance, bought just now
      claimed: 1_000_000n,
    });
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 3;
    const shares = await s.run();
    expect(shares.get(sniper) ?? 0n).toBe(0n);
    expect(shares.get(honest)).toBe(750_000n); // 1,000,000 claimed: team 250,000, holders 750,000
    s.cleanup();
  });

  test("a sniper present for only some of the samples earns nothing either; a partial seller is paid on what it kept", async () => {
    const honest = w();
    const sniper = w();
    const seller = w();
    const s = setup({
      samples: [
        [[honest, 100n], [seller, 100n]],
        [[honest, 100n], [seller, 100n], [sniper, 1_000_000n]],
        [[honest, 100n], [seller, 40n], [sniper, 1_000_000n]],
      ],
      now: [[honest, 100n], [seller, 40n], [sniper, 1_000_000n]],
      claimed: 1_400n,
    });
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 3;
    const shares = await s.run();
    expect(shares.get(sniper) ?? 0n).toBe(0n);
    expect(shares.get(honest)).toBe(750n); // 1,400 claimed: team 350, holders 1,050; 100 of (100 + 40)
    expect(shares.get(seller)).toBe(300n);
    s.cleanup();
  });

  test("too few samples in the window: the coin is not claimed at all (nothing is left in the keeper unexplained)", async () => {
    const honest = w();
    const s = setup({ samples: [[[honest, 100n]], [[honest, 100n]]], now: [[honest, 100n]], claimed: 500n });
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 3;
    expect((await s.run()).size).toBe(0);
    expect(s.claimedCoins).toEqual([]);
    expect(db.listEpochCoinHarvests(s.epochId).some((h) => h.mint === s.mint)).toBe(false); // left for a later run, not recorded as done
    s.cleanup();
  });

  test("with the local default (no samples required) the claim-time sample alone decides, as before", async () => {
    const honest = w();
    const s = setup({ samples: [], now: [[honest, 100n]], claimed: 500n });
    (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0;
    expect((await s.run()).get(honest)).toBe(375n); // 500 claimed: team 125, holders 375
    s.cleanup();
  });
});

describe("the sample gate by mode", () => {
  const minSamples = (mode: string) =>
    Bun.spawnSync(["bun", "-e", 'import { config } from "./src/config"; console.log(config.epoch.snapshots.minWindowSamples)'], {
      cwd: config.paths.engineRoot,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, PAD_MODE: mode, PAD_DB_FILE: "/dev/null" },
    }).stdout.toString().trim();

  test("mainnet requires 3 samples by default; local and devnet (test money, judge flow) require none", () => {
    expect(minSamples("mainnet")).toBe("3");
    expect(minSamples("devnet")).toBe("0");
    expect(minSamples("local")).toBe("0");
  });
});

describe("the plan and the due samples", () => {
  test("a plan is kept for the same window and redrawn for a new one", () => {
    const start = Date.now();
    const p1 = ensurePlan(start, start + 48 * 3_600_000, 6);
    const p2 = ensurePlan(start, start + 48 * 3_600_000, 6);
    expect(p2.times).toEqual(p1.times);
    const p3 = ensurePlan(start + 48 * 3_600_000, start + 96 * 3_600_000, 6);
    expect(p3.times).not.toEqual(p1.times);
  });

  test("samples due at once are one stored observation, and consumed only once", async () => {
    const mint = w();
    const row: db.CoinRow = { mint, name: "P", symbol: "P", imageUrl: "", description: "", creator: w(), createdAt: new Date().toISOString(), feeBps: 100, poolId: w(), mintDecimals: 6, status: "launched", configId: null };
    db.upsertCoin(row);
    const start = Date.parse("2091-01-01T00:00:00Z");
    const plan = ensurePlan(start, start + 6 * 3_600_000, 6, (min) => min); // the first millisecond of every slice
    const reader = async () => [holder(w(), 1n)];
    const now = start + 4 * 3_600_000 + 1; // slices 0..4 are due
    expect(await takeDueSamples(now, plan, reader)).toBe(5);
    const stored = db.listHolderSamples(mint, "2090-12-31T00:00:00Z", "2091-01-02T00:00:00Z");
    expect(stored.length).toBe(1);
    expect(await takeDueSamples(now, { ...plan, taken: 5 }, reader)).toBe(0);
    expect(await takeSamplesNow(now + 1, reader)).toBeGreaterThanOrEqual(1);
    db.upsertCoin({ ...row, status: "pending" });
  });
});
