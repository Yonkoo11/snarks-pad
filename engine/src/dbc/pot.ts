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
