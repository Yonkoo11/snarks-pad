// GET /api/coins/:mint/pot docs/API.md v2.6: the fee a coin's pool has accrued for the pad and nobody has claimed yet, what
// part of it is the holders', when the keeper loop next runs a round, and what the last round paid. The accrued numbers are the
// pool's own fee counters read through the Meteora SDKs and kept for POT_MAX_AGE_MS; nothing here claims, signs or pays, and it
// imports nothing from the keeper side (INV-17).
import { PublicKey } from "@solana/web3.js";
import { getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { config } from "../config";
import { getDbcClient } from "../solana";
import { viewCpAmm } from "./cpAmm";
import * as db from "../db";
import type { CoinRow } from "../db";
import { splitClaim } from "../epoch/split";
import { computeAllLastPayouts, type LastPayout } from "../epoch/publicView";
import { NEXT_EPOCH_AT_META } from "../ledger";
import { makeTtlMemo } from "../util/memo";
import { expectedFeeClaimer } from "./config";
import { STATS_MAX_AGE_MS } from "./marketStats";
import { makeReadCache } from "./read";

export const POT_MAX_AGE_MS = Number(process.env.PAD_POT_MAX_AGE_MS ?? 10_000);

export interface PotView {
  accruedZats: string;
  holdersZats: string;
  teamZats: string;
  minClaimZats: string;
  nextPayoutAt: string | null;
  lastPayout: LastPayout | null;
  asOf: string;
}

export interface Accrued {
  curve: bigint;
  pool: bigint;
  readAtMs: number;
}

/** The address the coin's config names as fee claimer: the owner of the partner's locked position on the graduated pool. */
function feeClaimerOf(coin: CoinRow): PublicKey | null {
  const row = coin.configId ? db.getDbcConfig(coin.configId) : null;
  return row ? new PublicKey(row.feeClaimer) : expectedFeeClaimer();
}

/** The unclaimed ZEC fee of the partner's locked position(s) in a graduated coin's DAMM v2 pool: the same sum the keeper's claim uses. */
async function positionFeeZats(coin: CoinRow): Promise<bigint> {
  const claimer = feeClaimerOf(coin);
  if (!claimer) return 0n;
  const cp = viewCpAmm();
  const dammPool = new PublicKey(coin.dammPool!);
  const pool = await cp.fetchPoolState(dammPool);
  const positions = await cp.getUserPositionByPool(dammPool, claimer);
  const quoteIsA = pool.tokenAMint.equals(config.solana.dbc.quoteMint);
  return positions.reduce((sum, p) => {
    const fee = getUnClaimLpFee(pool, p.positionState);
    return sum + BigInt((quoteIsA ? fee.feeTokenA : fee.feeTokenB).toString());
  }, 0n);
}

async function readAccrued(coin: CoinRow): Promise<Accrued> {
  const { current } = await getDbcClient().state.getPoolFeeMetrics(coin.poolId!);
  const curve = BigInt(current.partnerQuoteFee.toString()); // QuoteToken fee mode: the partner's fee accrues in ZEC
  const pool = coin.dammPool ? await positionFeeZats(coin) : 0n;
  return { curve, pool, readAtMs: Date.now() };
}

/** A coin's accrued, unclaimed partner fee, read at most once per window per coin; a failed read is not kept. */
export const accruedFees = makeReadCache(readAccrued, (c: CoinRow) => `${c.mint}:${c.poolId}:${c.dammPool ?? ""}`, POT_MAX_AGE_MS);

/** The newest paying epoch of every coin, worked out for all coins in one pass and kept as long as the other public totals. */
const lastPayouts = makeTtlMemo(() => computeAllLastPayouts(), STATS_MAX_AGE_MS);

/** For tests: forget the kept last payouts. */
export function clearPotCaches(): void {
  lastPayouts.clear();
}

/** The pot view from what was read: the accrued fee split the way an epoch splits what it claims, the next round's time and the last payout. */
export function buildPot(accrued: Accrued, nextPayoutAt: string | null, lastPayout: LastPayout | null): PotView {
  const total = accrued.curve + accrued.pool;
  const { holders, team } = splitClaim(total, config.epoch.team.shareBps);
  return {
    accruedZats: total.toString(),
    holdersZats: holders.toString(),
    teamZats: team.toString(),
    minClaimZats: config.epoch.minClaimZats.toString(),
    nextPayoutAt,
    lastPayout,
    asOf: new Date(accrued.readAtMs).toISOString(),
  };
}

export async function potOf(coin: CoinRow): Promise<PotView> {
  return buildPot(await accruedFees(coin), db.getMeta(NEXT_EPOCH_AT_META), lastPayouts.get().get(coin.mint) ?? null);
}

/** GET /api/pot: the pots of every coin the board lists, added up: what is waiting for holders across the pad right now. */
export interface PadPotView {
  accruedZats: string;
  holdersZats: string;
  teamZats: string;
  /** Coins whose pot was read and is in the sum. */
  coins: number;
  /** Coins whose pool could not be read this time; their pots are not in the sum. */
  unread: number;
  nextPayoutAt: string | null;
  asOf: string;
}

/** The pad's pot is one read for everyone who asks within this window: one home-page poll should not cost one chain read per coin per visitor. */
export const PAD_POT_MAX_AGE_MS = Number(process.env.PAD_PAD_POT_MAX_AGE_MS ?? 30_000);

/** The sum of what was read; the oldest read dates it. Every coin unread is counted, never guessed. All unread = nothing to show, so the caller answers 503. */
export function buildPadPot(read: Accrued[], unread: number, nextPayoutAt: string | null, nowMs: number = Date.now()): PadPotView {
  if (read.length === 0 && unread > 0) throw new Error(`the pad's pot: none of ${unread} coins could be read`);
  const total = read.reduce((sum, a) => sum + a.curve + a.pool, 0n);
  const { holders, team } = splitClaim(total, config.epoch.team.shareBps);
  const oldest = read.reduce((t, a) => Math.min(t, a.readAtMs), nowMs);
  return { accruedZats: total.toString(), holdersZats: holders.toString(), teamZats: team.toString(), coins: read.length, unread, nextPayoutAt, asOf: new Date(oldest).toISOString() };
}

async function readPadPot(coins: CoinRow[]): Promise<PadPotView> {
  const results = await Promise.allSettled(coins.map((c) => accruedFees(c)));
  const read = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  for (const [i, r] of results.entries()) if (r.status === "rejected") console.error(`[pot] ${coins[i]!.mint} not read: ${(r.reason as Error)?.message ?? r.reason}`);
  return buildPadPot(read, results.length - read.length, db.getMeta(NEXT_EPOCH_AT_META));
}

let padPotKept: { atMs: number; coins: string; value: Promise<PadPotView> } | null = null;

/** The pad's pot for `coins` (the board's launched coins), read at most once per PAD_POT_MAX_AGE_MS for the same list; a failed read is not kept. */
export function padPotOf(coins: CoinRow[], now: number = Date.now()): Promise<PadPotView> {
  const key = coins.map((c) => c.mint).join(",");
  if (padPotKept && padPotKept.coins === key && now - padPotKept.atMs < PAD_POT_MAX_AGE_MS && now >= padPotKept.atMs) return padPotKept.value;
  const value = readPadPot(coins);
  const kept = { atMs: now, coins: key, value };
  padPotKept = kept;
  value.catch(() => {
    if (padPotKept === kept) padPotKept = null;
  });
  return value;
}

/** For tests: forget the kept pad pot. */
export function clearPadPot(): void {
  padPotKept = null;
}
