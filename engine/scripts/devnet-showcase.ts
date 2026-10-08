#!/usr/bin/env bun
// D-3 on devnet: after the five launch-window configs exist and the pad uses them, relaunch the devnet showcase on them THROUGH THE DEPLOYED PAD'S
// OWN API, the way a creator's browser does: a new $SNARKS (the mascot, uploaded), and the tier coins TIER2 and TIER6 of D-2, each with a first buy, then (after the launch window
// has closed) a second odd-sized buy and a sell by the other test wallet. The pool's own fee counters are compared with src/dbc/tiers.ts after the window, to the zat.
//   scripts/devnet.sh bun scripts/devnet-showcase.ts [--api https://snarks.fun/api]
// The test wallets are the ones of D-2 (data/devnet-wallets.json, 0600, gitignored, test-only keys: they already hold the old coins and two of them are opted in to shielded delivery on
// the pad). Funding comes from the faucet key (data/keys/faucet-devnet.json), the stand-in ZEC mint's authority. Prints the three mints for PAD_FEATURED_MINTS; writes
// data/devnet-showcase.json and probe/fee-scheduler/results/d3-showcase-<ts>.json. Devnet only.
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { REVIEWED_TIERS } from "../src/dbc/reviewed";
import { feeNumeratorOf, splitSwapFee } from "../src/dbc/tiers";
import { waitForWindowToClose } from "../src/dbc/windowWait";
import { getConnection } from "../src/solana";
import { call, counters, launch, minus, must, topUp, trade, zecOf, type Counters, type Launched } from "./lib/devnet-live";

const arg = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const API = (arg("--api") ?? "https://snarks.fun/api").replace(/\/$/, "");
const RESULTS = join(config.paths.repoRoot, "probe", "fee-scheduler", "results");
const FIRST_BUY = 100_000_000n; // 1 stand-in ZEC
const SECOND_BUY = 123_456_789n;
const SNARKS_FIRST_BUY = 20_000_000n; // the owner's launch buy of D-1, 0.2 ZEC
const BUYER_ZEC = 100_000_000n; // each holder of the new $SNARKS buys 1 ZEC, as the seed did

interface Wallets { creator: string; defaults: string[]; optins: { key: string }[] }
const wallets = JSON.parse(readFileSync(join(config.paths.dataDir, "devnet-wallets.json"), "utf8")) as Wallets;
const kp = (secret: string): Keypair => Keypair.fromSecretKey(bs58.decode(secret));
const [creatorKp, buyerA, buyerB] = [kp(wallets.creator), ...wallets.defaults.map(kp)] as [Keypair, Keypair, Keypair];
const holders = [buyerA, buyerB, ...wallets.optins.map((o) => kp(o.key))];
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** The pad must offer the tiers and say each has a launch window before anything is launched on it. */
async function requireTiers(tiers: number[]): Promise<void> {
  const answer = await must(API, "GET", "/tiers");
  for (const bps of tiers) {
    const t = (answer.tiers as Record<string, any>[]).find((x) => x.feeBps === bps);
    if (!t?.available) throw new Error(`the pad does not offer the ${bps} bps tier yet: create its config first (config-create) and restart the API`);
    if (t.launchWindow?.cliffBps !== 9900) throw new Error(`the pad's ${bps} bps tier does not report the launch window: is the v2.8 engine deployed?`);
  }
}

/** The mascot, stored by the pad (POST /uploads) the way the Launch page does it: the pad answers where its own copy is. */
async function uploadMascot(): Promise<string> {
  const form = new FormData();
  form.append("file", new File([readFileSync(join(config.paths.repoRoot, "web", "public", "mascot.jpg"))], "mascot.jpg", { type: "image/jpeg" }));
  const res = await fetch(`${API}/uploads`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`POST /uploads answered ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

/** The launch (first buy inside it pays the tier fee), then the wait until the pool's window has closed on the chain's clock. */
async function launchAndSettle(creator: Keypair, p: Parameters<typeof launch>[2]): Promise<Launched> {
  const l = await launch(API, creator, p);
  log(`LAUNCH ${p.symbol} tier ${p.feeTier} bps mint ${l.mint} pool ${l.poolId} launch tx ${l.sig}`);
  await waitForWindowToClose(l.poolId);
  return l;
}

const tokenOf = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID);
const heldOf = async (mint: string, owner: PublicKey): Promise<bigint> => (await getAccount(getConnection(), tokenOf(mint, owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

/** Compares what the pool accrued over one trade with the fee model at the tier's own fee (after the window); returns the line for the record. */
function modelLine(label: string, tier: number, amount: bigint, delta: Counters): { label: string; equal: boolean } {
  const m = splitSwapFee(amount, feeNumeratorOf(tier), REVIEWED_TIERS[tier]!.creatorFeePercentage);
  const equal = delta.partner === m.partner && delta.creator === m.creator && delta.protocol === m.meteora;
  log(`  ${label}: pool partner/creator/protocol = ${delta.partner}/${delta.creator}/${delta.protocol}; model = ${m.partner}/${m.creator}/${m.meteora}; ${equal ? "EQUAL" : "DIFFERENT"}`);
  return { label, equal };
}

/** A tier coin as D-2 made it: a first buy by its creator, then (window closed) an odd-sized buy and a sell by the other wallet, each checked against the model. */
async function tierCoin(tier: number, symbol: string, name: string, creator: Keypair, buyer: Keypair): Promise<Record<string, unknown>> {
  const l = await launchAndSettle(creator, { name, symbol, description: `a ${tier / 100}% creator-fee coin (devnet test)`, imageUrl: "", feeTier: tier, firstBuyZats: FIRST_BUY });
  const checks: { label: string; equal: boolean }[] = [];
  const before = await counters(l.poolId);
  await trade(API, l.mint, buyer, "buy", SECOND_BUY);
  const afterBuy = await counters(l.poolId);
  checks.push(modelLine(`buy of ${SECOND_BUY} after the window`, tier, SECOND_BUY, minus(afterBuy, before)));
  const zecBefore = await zecOf(buyer.publicKey);
  const sold = (await heldOf(l.mint, buyer.publicKey)) / 3n;
  await trade(API, l.mint, buyer, "sell", sold);
  const dd = minus(await counters(l.poolId), afterBuy);
  const gross = (await zecOf(buyer.publicKey)) - zecBefore + dd.partner + dd.creator + dd.protocol; // received + fee = the gross output the fee is taken from
  checks.push(modelLine(`sell of ${sold} raw tokens (gross ${gross} zats)`, tier, gross, dd));
  return { symbol, tier, ...l, creator: creator.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), checks };
}

/** The new $SNARKS: the mascot, the owner's 0.2 ZEC first buy, then one ZEC from each of the four holders (two of them are opted in to shielded delivery on the pad). */
async function snarks(): Promise<Record<string, unknown>> {
  const imageUrl = await uploadMascot();
  log("mascot stored by the pad at", imageUrl);
  const l = await launchAndSettle(creatorKp, { name: "Snarks", symbol: "SNARKS", description: "The pad's launch coin. RELEASE THE SNARKS.", imageUrl, feeTier: 100, firstBuyZats: SNARKS_FIRST_BUY });
  const sigs: string[] = [];
  for (const h of holders) sigs.push((await trade(API, l.mint, h, "buy", BUYER_ZEC)).sig);
  log(`SNARKS bought by ${holders.length} holders: ${sigs.length} trades recorded`);
  return { symbol: "SNARKS", tier: 100, ...l, imageUrl, creator: creatorKp.publicKey.toBase58(), holderBuys: sigs };
}

async function main(): Promise<void> {
  log("pad API", API, "cluster", config.mode);
  await requireTiers([100, 200, 600]);
  for (const w of [creatorKp, ...holders]) await topUp(w.publicKey, 0.12, 4n * BUYER_ZEC);
  const coins = { snarks: await snarks(), tier2: await tierCoin(200, "TIER2", "Two Percent", buyerA, buyerB), tier6: await tierCoin(600, "TIER6", "Six Percent", buyerB, buyerA) };
  const mints = [coins.snarks, coins.tier2, coins.tier6].map((c) => c.mint as string);
  const featured = mints.join(",");
  log("PAD_FEATURED_MINTS for the pad:", featured);
  const board = await call(API, "GET", "/coins?all=1");
  log("the pad lists", (board.body.coins as unknown[]).length, "coins with ?all=1");
  mkdirSync(RESULTS, { recursive: true });
  const out = { probe: "D-3 showcase", cluster: config.mode, api: API, at: new Date().toISOString(), featured, coins };
  writeFileSync(join(config.paths.dataDir, "devnet-showcase.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(RESULTS, `d3-showcase-${Date.now()}.json`), JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const bad = [coins.tier2, coins.tier6].flatMap((c) => (c.checks as { label: string; equal: boolean }[]).filter((x) => !x.equal));
  if (bad.length > 0) throw new Error(`the pool's accrual differs from the model on ${bad.length} trades: ${bad.map((b) => b.label).join("; ")}`);
}

await main();
