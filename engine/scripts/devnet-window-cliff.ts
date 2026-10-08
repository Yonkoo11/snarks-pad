#!/usr/bin/env bun
// D-3: the 99% step of the launch window, read off devnet. A coin is launched through the DEPLOYED pad's own API (launch-tx, confirm), and a stranger's buy that was signed beforehand
// from addresses alone (scripts/lib/blind-buy.ts) is sent straight behind the launch transaction, so it can land in the launch's own second. The buy's block time minus the pool's
// activation point is the second it was priced in, and the pool's counters say what it paid: the first second must cost the cliff, numerator 990,000,000 (99%).
//   scripts/devnet.sh bun scripts/devnet-window-cliff.ts [--api https://snarks.fun/api] [--tier 100] [--config <config id>] [--attempts 8]
// The config of the tier is read from probe/fee-scheduler/results/d3-devnet-configs.json (the pad's launch-tx does not name it); `--config` overrides. Wallets are fresh keys made here and
// funded by the faucet key (test money); an attempt costs about 0.012 SOL. A buy that reached the chain before its pool existed fails and is recorded, not counted. Stops at the first
// buy that landed in second 0; writes probe/fee-scheduler/results/d3-window-cliff-<ts>.json. Devnet only.
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";
import { buildBlindBuy } from "./lib/blind-buy";
import { blockTimeOf, counters, must, numeratorAtSecond, topUp, total } from "./lib/devnet-live";

const arg = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const API = (arg("--api") ?? "https://snarks.fun/api").replace(/\/$/, "");
const TIER = Number(arg("--tier") ?? 100);
const ATTEMPTS = Number(arg("--attempts") ?? 8);
const FIRST_BUY = 50_000_000n; // the launcher's own buy, inside the launch transaction (pays the tier fee)
const AMOUNT = 10_000_000n; // the stranger's buy: 0.1 ZEC, so the fee at every step is a whole number of zats
const RESULTS = join(config.paths.repoRoot, "probe", "fee-scheduler", "results");
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const ceilFee = (amount: bigint, numerator: bigint): bigint => (amount * numerator + 999_999_999n) / 1_000_000_000n;

/** The config the pad launches the tier on: the one recorded when it was created (D-3), unless `--config` names another. */
function configOfTier(): string {
  const named = arg("--config");
  if (named) return named;
  const file = JSON.parse(readFileSync(join(RESULTS, "d3-devnet-configs.json"), "utf8")) as { configs: { tier: number; id: string }[] };
  const found = file.configs.find((c) => c.tier === TIER);
  if (!found) throw new Error(`no config recorded for the ${TIER} bps tier: pass --config`);
  return found.id;
}

interface Attempt {
  attempt: number;
  coin: string;
  pool: string;
  launchSig: string;
  buySig: string;
  buyFailed: boolean;
  second: number | null;
  numerator: string | null;
  feeObserved: string | null;
  feeExpected: string | null;
  exact: boolean;
}

/** One launch with the blind buy sent right behind it. */
async function attempt(n: number, configId: string): Promise<Attempt> {
  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  await topUp(creator.publicKey, 0.06, 3n * FIRST_BUY);
  await topUp(buyer.publicKey, 0.03, 3n * AMOUNT);
  const made = await must(API, "POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: `Window cliff ${n}`, symbol: `WC${Date.now() % 100000}`, description: "devnet launch-window cliff proof (D-3)", imageUrl: "", feeTier: TIER, initialBuyZec: FIRST_BUY.toString() });
  const mint = made.mint as string;
  const buyTx = await buildBlindBuy(buyer, new PublicKey(mint), new PublicKey(configId), AMOUNT);
  const launchTx = VersionedTransaction.deserialize(Buffer.from(made.tx as string, "base64"));
  launchTx.sign([creator]);
  const conn = getConnection();
  const launchSig = await conn.sendRawTransaction(launchTx.serialize(), { skipPreflight: true });
  const buySig = await conn.sendRawTransaction(buyTx.serialize(), { skipPreflight: true });
  const [, bought] = await Promise.all([conn.confirmTransaction(launchSig, "confirmed"), conn.confirmTransaction(buySig, "confirmed")]);
  const confirmed = await must(API, "POST", "/coins/confirm", { sig: launchSig, mint });
  const pool = confirmed.poolId as string;
  const base = { attempt: n, coin: mint, pool, launchSig, buySig };
  if (bought.value.err) return { ...base, buyFailed: true, second: null, numerator: null, feeObserved: null, feeExpected: null, exact: false };
  const activation = Number((await getDbcClient().state.getPool(pool))!.poolState.activationPoint.toString());
  const second = (await blockTimeOf(buySig)) - activation;
  const numerator = numeratorAtSecond(TIER, second);
  const firstFee = ceilFee(FIRST_BUY, numeratorAtSecond(TIER, 5)); // the launcher's own buy paid the tier fee (devnet-window-proof.ts)
  const observed = total(await counters(pool)) - firstFee;
  const expected = ceilFee(AMOUNT, numerator);
  log(`attempt ${n}: the buy landed ${second} s after activation (period ${Math.min(second, 5)}): numerator ${numerator}, fee taken ${observed}, ${observed === expected ? "EXACT" : "NOT matching"} (ceil(amount x numerator / 1e9) = ${expected}); launch ${launchSig}, buy ${buySig}`);
  return { ...base, buyFailed: false, second, numerator: numerator.toString(), feeObserved: observed.toString(), feeExpected: expected.toString(), exact: observed === expected };
}

async function main(): Promise<void> {
  const configId = configOfTier();
  log("pad API", API, "cluster", config.mode, "tier", TIER, "config", configId);
  const runs: Attempt[] = [];
  for (let n = 1; n <= ATTEMPTS; n++) {
    runs.push(await attempt(n, configId));
    if (runs[runs.length - 1]!.second === 0) break; // the cliff itself: nothing more to read
  }
  const cliff = runs.find((r) => r.second === 0 && r.exact);
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `d3-window-cliff-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ probe: "D-3 window cliff", cluster: config.mode, api: API, tier: TIER, config: configId, at: new Date().toISOString(), landedInFirstSecond: !!cliff, runs }, null, 2));
  log(cliff ? `the first second cost the cliff: numerator ${cliff.numerator}, ${cliff.feeObserved} of ${AMOUNT}; results ${file}` : `no buy landed in the launch's own second in ${runs.length} attempts; results ${file}`);
  if (runs.some((r) => !r.buyFailed && !r.exact) || !cliff) process.exit(1);
}

await main();
