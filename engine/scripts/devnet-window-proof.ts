#!/usr/bin/env bun
// D-3 live proof on devnet: through the DEPLOYED pad's own API, one coin is launched on a launch-window config and bought in the window and after it. Read back from the chain:
//   - the launcher's own first buy (in the launch transaction) paid the tier fee, not 99%;
//   - a buy that lands inside the window paid the fee of the second its block landed in: ceil(amount x numerator / 1e9) equals the sum of the pool's counters' growth, with the numerator
//     = cliff - period x reduction worked out by hand (txid, slot, second, numerator below);
//   - the pad's `feeNowBps` on GET /coins/:mint, sampled during the window, is each time the fee of a second between two reads of the chain's clock, and `windowSecondsLeft` its seconds left;
//   - after the window `feeNowBps` is the tier fee, and a buy pays exactly the tier fee (numerator tierBps x 100,000).
//   scripts/devnet.sh bun scripts/devnet-window-proof.ts [--api https://snarks.fun/api] [--tier 100] [--attempts 3]
// The pad answers launch and trade requests exactly as for a browser; the wallets are fresh keys made here and funded by the faucet key (test money). Each attempt costs about 0.012 SOL;
// attempts that miss the window (a slow network) are recorded and not counted. Writes probe/fee-scheduler/results/d3-window-proof-<ts>.json. Devnet only.
import { Keypair } from "@solana/web3.js";
import { ActivationType, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { waitForWindowToClose } from "../src/dbc/windowWait";
import { getConnection } from "../src/solana";
import { blockTimeOf, counters, launch, minus, must, numeratorAtSecond, topUp, total, trade, type Counters } from "./lib/devnet-live";

const arg = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const API = (arg("--api") ?? "https://snarks.fun/api").replace(/\/$/, "");
const TIER = Number(arg("--tier") ?? 100);
const ATTEMPTS = Number(arg("--attempts") ?? 3);
const FIRST_BUY = 50_000_000n; // 0.5 ZEC inside the launch transaction
const WINDOW_BUY = 30_000_000n;
const AFTER_BUY = 100_000_000n; // 1 ZEC: the tier fee on it is a whole number of zats at every tier
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const ceilFee = (amount: bigint, numerator: bigint): bigint => (amount * numerator + 999_999_999n) / 1_000_000_000n;
const chainNow = async (): Promise<number> => Number((await getCurrentPoint(getConnection(), ActivationType.Timestamp)).toString());

interface Sample {
  clockBefore: number;
  clockAfter: number;
  feeNowBps: number | null;
  windowSecondsLeft: number;
  ok: boolean;
}

/** One read of the pad's live fee between two reads of the chain's clock: the pad's answer must be the fee of a second in between (and its seconds left that second's). */
async function sample(mint: string, activation: number): Promise<Sample> {
  const clockBefore = await chainNow();
  const r = await must(API, "GET", `/coins/${mint}`);
  const clockAfter = await chainNow();
  const seconds = Array.from({ length: clockAfter - clockBefore + 1 }, (_, i) => clockBefore + i);
  const fees = new Set(seconds.map((t) => Number(numeratorAtSecond(TIER, t - activation) / 100_000n)));
  const lefts = new Set(seconds.map((t) => Math.max(0, activation + 5 - t)));
  return { clockBefore, clockAfter, feeNowBps: r.feeNowBps as number | null, windowSecondsLeft: r.windowSecondsLeft as number, ok: fees.has(r.feeNowBps as number) && lefts.has(r.windowSecondsLeft as number) };
}

/** Samples the pad's live fee every ~150 ms until the window has closed or `max` samples were taken. */
async function sampler(mint: string, activation: number, max = 12): Promise<Sample[]> {
  const out: Sample[] = [];
  for (let i = 0; i < max; i++) {
    out.push(await sample(mint, activation));
    if (out[i]!.windowSecondsLeft === 0) break;
    await Bun.sleep(150);
  }
  return out;
}

interface Buy {
  sig: string;
  amount: string;
  landedSecond: number;
  numerator: string;
  feeObserved: string;
  feeExpected: string;
  confirmed: boolean;
  quotedFeeZec: string;
}

/** A buy through the pad, then the fee the pool really took, checked against the numerator of the second its block landed in. */
async function buy(mint: string, poolId: string, activation: number, wallet: Keypair, amount: bigint): Promise<Buy> {
  const before: Counters = await counters(poolId);
  const t = await trade(API, mint, wallet, "buy", amount);
  const landedSecond = (await blockTimeOf(t.sig)) - activation;
  const numerator = numeratorAtSecond(TIER, landedSecond);
  const observed = total(minus(await counters(poolId), before));
  const b: Buy = {
    sig: t.sig, amount: amount.toString(), landedSecond, numerator: numerator.toString(), feeObserved: observed.toString(), feeExpected: ceilFee(amount, numerator).toString(),
    confirmed: observed === ceilFee(amount, numerator), quotedFeeZec: String(t.quote.feeZec),
  };
  log(`buy ${amount} landed ${landedSecond} s after activation (period ${Math.min(landedSecond, 5)}): fee taken ${observed}, numerator ${numerator} ${b.confirmed ? "CONFIRMED" : "NOT matching"} (ceil(amount x numerator / 1e9) = ${b.feeExpected}); quote said ${b.quotedFeeZec}`);
  return b;
}

async function attempt(n: number): Promise<Record<string, unknown>> {
  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  for (const w of [creator, buyer]) await topUp(w.publicKey, 0.06, 3n * AFTER_BUY);
  const l = await launch(API, creator, { name: `Window proof ${n}`, symbol: `WP${Date.now() % 100000}`, description: "devnet launch-window proof (D-3)", imageUrl: "", feeTier: TIER, firstBuyZats: FIRST_BUY });
  const firstFee = total(await counters(l.poolId));
  log(`attempt ${n}: coin ${l.mint}, pool ${l.poolId}, launch tx ${l.sig}, activation ${l.activation}; the launcher's own first buy of ${FIRST_BUY} paid ${firstFee} (tier fee ${ceilFee(FIRST_BUY, numeratorAtSecond(TIER, 5))}, a stranger's second-0 fee would be ${ceilFee(FIRST_BUY, numeratorAtSecond(TIER, 0))})`);
  const [samples, inWindow] = await Promise.all([sampler(l.mint, l.activation), buy(l.mint, l.poolId, l.activation, buyer, WINDOW_BUY)]);
  await waitForWindowToClose(l.poolId);
  const closed = await must(API, "GET", `/coins/${l.mint}`);
  const after = await buy(l.mint, l.poolId, l.activation, buyer, AFTER_BUY);
  return {
    attempt: n, coin: l.mint, pool: l.poolId, launchSig: l.sig, activation: l.activation, firstBuy: { amount: FIRST_BUY.toString(), feeObserved: firstFee.toString(), paidTierFee: firstFee === ceilFee(FIRST_BUY, numeratorAtSecond(TIER, 5)) },
    inWindow, samples, samplesAllConsistent: samples.every((s) => s.ok), afterWindowCoin: { feeNowBps: closed.feeNowBps, windowSecondsLeft: closed.windowSecondsLeft }, after,
    inTheWindow: inWindow.landedSecond < 5, afterWindowPaidTierFee: after.landedSecond >= 5 && after.confirmed && after.feeObserved === ceilFee(AFTER_BUY, numeratorAtSecond(TIER, 5)).toString(),
  };
}

async function main(): Promise<void> {
  log("pad API", API, "cluster", config.mode, "tier", TIER);
  const tiers = await must(API, "GET", "/tiers");
  const t = (tiers.tiers as Record<string, any>[]).find((x) => x.feeBps === TIER);
  if (!t?.available) throw new Error(`the pad does not offer the ${TIER} bps tier`);
  const runs: Record<string, unknown>[] = [];
  for (let i = 1; i <= ATTEMPTS; i++) {
    runs.push(await attempt(i));
    const last = runs[runs.length - 1]!;
    if (last.inTheWindow === true && (last.inWindow as Buy).landedSecond <= 1) break; // as early as a network allows; more attempts would only spend test money
  }
  const good = runs.filter((r) => r.inTheWindow === true && (r.inWindow as Buy).confirmed && r.afterWindowPaidTierFee === true && (r.firstBuy as { paidTierFee: boolean }).paidTierFee && r.samplesAllConsistent === true);
  mkdirSync(join(config.paths.repoRoot, "probe", "fee-scheduler", "results"), { recursive: true });
  const file = join(config.paths.repoRoot, "probe", "fee-scheduler", "results", `d3-window-proof-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ probe: "D-3 window proof", cluster: config.mode, api: API, tier: TIER, at: new Date().toISOString(), proved: good.length > 0, runs }, null, 2));
  log(`${good.length} of ${runs.length} attempts proved the window end to end; results ${file}`);
  if (good.length === 0) process.exit(1);
}

await main();
