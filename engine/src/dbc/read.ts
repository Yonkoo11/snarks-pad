// Read-only pool/curve state for the public coin listing. Informational only:
// payouts are settled from each claim transaction's own balance change, never
// from these estimates. Since v2.8.1 the list and the coin page are built from
// the database first and wait at most COIN_VIEW_WAIT_MS for the chain: a chain
// that cannot be read leaves the pool numbers at their last read value, or out.
import { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";
import Decimal from "decimal.js";
import { config } from "../config";
import { getCpAmm, getDbcClient } from "../solana";
import * as db from "../db";
import type { CoinRow, TradeRow } from "../db";
import { settleWithin } from "../rpcGuard";
import { readStoredSocials, type Socials } from "../socials";
import { DEFAULT_TIER_BPS, reviewedTier } from "./reviewed";
import { tierShares } from "./tiers";
import { visibleCoins } from "./visible";
import { configScheduleOf, launchWindowOf, scheduleFromJson, scheduleToJson, storedWindowOf, type ConfigSchedule, type LaunchWindow } from "./window";

export type Venue = "meteora-dbc" | "meteora-damm-v2";

export interface CoinView {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string;
  description: string;
  // The creator's links (contract v2.7): each an https address, only the ones the creator gave; {} for none and for a coin launched before v2.7.
  socials: Socials;
  creator: string;
  createdAt: string;
  // When the pad recorded the coin's move to its DAMM v2 pool (the keeper does it when it next reconciles, so this can be later than the
  // chain event, and a coin someone else already migrated reads stage "graduated" with null until then); null while the coin is on the curve.
  graduatedAt: string | null;
  // The coin's fee tier: the fee on its bonding curve in bps (100, 200, 400, 600 or 1000) once its launch window has closed, fixed for life by the DBC config it launched on.
  feeBps: number;
  // Of the whole trading fee, in bps (10000 = all of it), for THIS coin's tier. Meteora keeps 2000 at every tier; the creator's part
  // (0 on the 1% tier) is claimed by the creator's own wallet; the pad claims the rest (8000 minus the creator's) and splits it
  // holders/team (owner policy 2026-10-12: 12.5/87.5 of what is claimed). 1% tier: claimed 8000, holders 1000, team 7000, creator 0.
  claimedShareBps: number;
  holderShareBps: number;
  teamShareBps: number;
  creatorShareBps: number;
  // The fee the graduated DAMM v2 pool charges before its dynamic part, in bps: equal to feeBps except on the 10% tier, which drops to 6%.
  postGraduationFeeBps: number;
  stage: "curve" | "graduated";
  venue: Venue;
  curveProgress: number;
  priceZec: string;
  marketCapZec: string;
  poolId: string;
  // The launch window the coin's config carries (contract v2.8): the fee starts at `cliffBps` in the pool's first second and steps down to `endBps` (the coin's
  // tier) by `endsAt`, then stays there. null for a coin launched on a flat-fee config (before v2.8). A fact of the config and the pool's activation point.
  launchWindow: LaunchWindow | null;
  // The wallet the CHAIN records as the pool's creator: the one that receives the creator's share of the fee and the only one that can claim it. It is
  // `creator` (who launched and paid) unless a Creator wallet was set at launch (or the pool was handed over since).
  creatorWallet: string;
}

const PRICE_DP = 12;
const Q64 = new Decimal(2).pow(64);

/** num/den as a decimal string with at most `dp` fractional digits (trailing zeros trimmed). */
export function decimalRatio(num: bigint, den: bigint, dp: number): string {
  const scaled = (num * 10n ** BigInt(dp)) / den;
  const whole = scaled / 10n ** BigInt(dp);
  const frac = (scaled % 10n ** BigInt(dp)).toString().padStart(dp, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Both Meteora programs store the price as a Q64.64 square root of (token B raw
 * per token A raw). `baseIsA` says which side the coin is. Returns zats per
 * WHOLE token as a decimal string (a memecoin is far below 1 zat, so
 * docs/API.md makes it a decimal string) and the market cap in integer zats.
 */
export function priceFromSqrtPrice(sqrtPrice: bigint, baseIsA: boolean): { priceZec: string; marketCapZec: string } {
  const rawBPerA = new Decimal(sqrtPrice.toString()).div(Q64).pow(2);
  if (rawBPerA.isZero()) return { priceZec: "0", marketCapZec: "0" };
  const quotePerBaseRaw = baseIsA ? rawBPerA : new Decimal(1).div(rawBPerA);
  const zatsPerWholeToken = quotePerBaseRaw.mul(new Decimal(10).pow(config.solana.dbc.baseDecimals));
  const marketCap = zatsPerWholeToken.mul(config.solana.dbc.totalSupply).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return { priceZec: zatsPerWholeToken.toFixed(PRICE_DP).replace(/\.?0+$/, "") || "0", marketCapZec: marketCap.toFixed(0) };
}

async function readDammStage(coin: CoinRow): Promise<{ priceZec: string; marketCapZec: string } | null> {
  const pool = await getCpAmm().fetchPoolState(new PublicKey(coin.dammPool!)).catch(() => null);
  if (!pool) return null;
  return priceFromSqrtPrice(BigInt(pool.sqrtPrice.toString()), pool.tokenAMint.toBase58() === coin.mint);
}

/** The fee tier of a coin: its recorded curve fee when that is on the menu, else the default (an env-overridden experiment config). */
export function coinTier(coin: Pick<CoinRow, "feeBps">): number {
  return reviewedTier(coin.feeBps) ? coin.feeBps : DEFAULT_TIER_BPS;
}

/** The Coin fields only a read of the pool on chain gives. */
type PoolField = "curveProgress" | "priceZec" | "marketCapZec";

/**
 * A coin as GET /coins and GET /coins/:mint answer it (contract v2.8.1): every field the database has, and the pool numbers when a chain read has them. They are
 * absent when the chain cannot be read and was never read for the coin; `launchWindow` is absent until its facts are stored or read.
 */
export type PublicCoinView = Omit<CoinView, PoolField | "launchWindow"> & Partial<Pick<CoinView, PoolField | "launchWindow">>;

/**
 * What the database alone says about a coin: stage and venue as the pad recorded them (a coin someone else migrated reads `curve` here until the keeper records
 * it), the Creator wallet asked for at launch, and the launch window worked out from the facts stored at launch and at confirm.
 */
export function coinBaseView(coin: CoinRow): PublicCoinView {
  const tierBps = coinTier(coin);
  const shares = tierShares(tierBps, config.epoch.team.shareBps);
  const migrated = !!coin.dammPool;
  const facts = storedWindowOf(coin);
  return {
    mint: coin.mint, name: coin.name, symbol: coin.symbol, imageUrl: coin.imageUrl, description: coin.description, socials: readStoredSocials(coin.socials),
    creator: coin.creator, createdAt: coin.createdAt, graduatedAt: coin.migratedAt ?? null, feeBps: coin.feeBps,
    claimedShareBps: shares.claimedBps, holderShareBps: shares.holdersBps, teamShareBps: shares.teamBps, creatorShareBps: shares.creatorBps,
    postGraduationFeeBps: reviewedTier(tierBps)!.postGraduationFeeBps,
    stage: migrated ? "graduated" : "curve", venue: migrated ? "meteora-damm-v2" : "meteora-dbc", poolId: coin.poolId ?? "",
    creatorWallet: coin.creatorWallet ?? coin.creator,
    ...(facts ? { launchWindow: launchWindowOf(facts.schedule, facts.activation) } : {}),
  };
}

/** The lazy backfill (contract v2.8.1): a coin from before its window facts were stored gets them from its first chain read, once. A failed write only logs. */
function rememberWindowFacts(coin: CoinRow, schedule: ConfigSchedule, activationPoint: BN): void {
  if (coin.feeSchedule && coin.activationPoint) return;
  try {
    db.fillCoinWindowFacts(coin.mint, scheduleToJson(schedule), activationPoint.toString());
  } catch (err) {
    console.error(`[api] window facts of ${coin.mint} not stored, tried again on the next read: ${(err as Error)?.message ?? err}`);
  }
}

async function readCoinViewFromChain(coin: CoinRow): Promise<CoinView | null> {
  if (!coin.poolId) return null;
  const pool = await getDbcClient().state.getPool(coin.poolId);
  if (!pool) return null;
  const s = pool.poolState;
  const migrated = s.isMigrated !== 0 || !!coin.dammPool;
  const threshold = BigInt((await getDbcClient().state.getPoolMigrationQuoteThreshold(coin.poolId)).toString());

  // The DBC pool's base mint is always the coin; which side is "A" is fixed by the program.
  const baseIsA = true;
  const priced =
    (migrated && coin.dammPool ? await readDammStage(coin) : null) ?? priceFromSqrtPrice(BigInt(s.sqrtPrice.toString()), baseIsA);
  const reserve = BigInt(s.quoteReserve.toString());
  const schedule = scheduleFromJson(coin.feeSchedule) ?? (await configScheduleOf(s.config));
  rememberWindowFacts(coin, schedule, s.activationPoint);
  return {
    ...coinBaseView(coin),
    stage: migrated ? "graduated" : "curve",
    venue: migrated && coin.dammPool ? "meteora-damm-v2" : "meteora-dbc",
    curveProgress: migrated ? 1 : threshold === 0n ? 0 : Math.min(1, Number(reserve) / Number(threshold)),
    ...priced,
    poolId: coin.poolId,
    launchWindow: launchWindowOf(schedule, s.activationPoint),
    creatorWallet: s.creator.toBase58(),
  };
}

/**
 * Reads at most once per `maxAgeMs` per key, one read at a time per key; a failed read is not kept (stress API load,
 * audit/STRESS-REPORT.md D7: every GET /coins re-read every pool from the chain, so ~100 listing requests a second
 * saturated the API process and every route slowed together).
 */
export function makeReadCache<K, V>(read: (key: K) => Promise<V>, keyOf: (key: K) => string, maxAgeMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { atMs: number; value: Promise<V> }>();
  return (key: K): Promise<V> => {
    const k = keyOf(key);
    const hit = entries.get(k);
    if (hit && now() - hit.atMs < maxAgeMs) return hit.value;
    const value = read(key);
    entries.set(k, { atMs: now(), value });
    value.catch(() => {
      if (entries.get(k)?.value === value) entries.delete(k);
    });
    return value;
  };
}

const viewKey = (c: CoinRow): string => `${c.mint}:${c.poolId}:${c.dammPool ?? ""}`;

/** The last answer the chain gave for each coin, of any age: a view, or null for a pool the chain said is not there. What the public routes fall back on. */
const lastViews = new Map<string, CoinView | null>();

/** The last view the chain gave for a coin, of any age, with no read: undefined if never read, null if the chain said its pool is not there. */
export const lastKnownView = (coin: CoinRow): CoinView | null | undefined => lastViews.get(viewKey(coin));

/** A coin's view read off the chain: pool state is informational (payouts never use it), so it is served up to PAD_COIN_VIEW_MAX_AGE_MS (3 s) old. Rejects when the chain cannot be read. */
export const readCoinView = makeReadCache(
  async (coin: CoinRow) => {
    const view = await readCoinViewFromChain(coin);
    lastViews.set(viewKey(coin), view);
    return view;
  },
  viewKey,
  Number(process.env.PAD_COIN_VIEW_MAX_AGE_MS ?? 3_000),
);

/** How long GET /coins and GET /coins/:mint wait for a chain read before they answer without it (contract v2.8.1: within 2 s when the chain cannot be read). */
export const COIN_VIEW_WAIT_MS = Number(process.env.PAD_COIN_VIEW_WAIT_MS ?? 1_000);

/** What a view read off the chain says that the database cannot: the pool numbers, and the chain's own stage, venue, window and pool creator. */
function chainFields(v: CoinView): Pick<CoinView, PoolField | "stage" | "venue" | "launchWindow" | "creatorWallet"> {
  return { stage: v.stage, venue: v.venue, curveProgress: v.curveProgress, priceZec: v.priceZec, marketCapZec: v.marketCapZec, launchWindow: v.launchWindow, creatorWallet: v.creatorWallet };
}

/**
 * A coin as the public routes answer it, never waiting more than `waitMs` for the chain (contract v2.8.1): the chain's view when a read at most 3 s old lands in
 * time; else the database's fields with what the last chain read said (any age), or with nothing from the chain if it was never read. null only when the chain
 * itself said the coin's pool is not there.
 */
export async function coinViewWithin(coin: CoinRow, waitMs: number = COIN_VIEW_WAIT_MS): Promise<PublicCoinView | null> {
  const read = await settleWithin(readCoinView(coin), waitMs);
  if (read.ok) return read.value;
  const last = lastViews.get(viewKey(coin));
  if (last === null) return null;
  return last === undefined ? coinBaseView(coin) : { ...coinBaseView(coin), ...chainFields(last) };
}

export interface CoinDetail extends CoinView {
  holders: number;
  recentTrades: TradeRow[];
}

/** The coins the board lists (`all`: every launched coin), each as coinViewWithin answers it. Only those are read: never the coins the board hides. */
export async function listCoinViews(all: boolean): Promise<PublicCoinView[]> {
  const rows = visibleCoins(db.listCoins().filter((c) => c.status === "launched"), all);
  const views = await Promise.all(rows.map((c) => coinViewWithin(c)));
  return views.filter((v): v is PublicCoinView => v !== null);
}
