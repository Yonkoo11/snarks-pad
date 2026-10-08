// A quote without a wallet docs/API.md v2.6, "Quote without a wallet"): the numbers POST /coins/:mint/trade-tx puts in its
// `quote`, worked out from a snapshot of the coin's pool that is at most PAD_QUOTE_MAX_AGE_MS (2 s) old. The chain is read once per
// window per coin and every quote is arithmetic on that snapshot, so a caller who varies the amount costs no RPC call. Read-only:
// nothing is built or signed, no wallet or token account is looked at, and the keeper key is never involved (INV-17).
import { PublicKey } from "@solana/web3.js";
import { getCurrentPoint as dbcCurrentPoint, SwapMode as DbcSwapMode, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { SwapMode as DammSwapMode, getCurrentPoint as dammCurrentPoint, type PoolState } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { config } from "../config";
import { getConnection, getDbcClient } from "../solana";
import { viewCpAmm } from "./cpAmm";
import type { CoinRow } from "../db";
import { makeReadCache } from "./read";
import { withBlockRetry, type TradeSide } from "./trade";
import { feeBpsAt, launchWindowOf, scheduleOfState, windowSecondsLeft } from "./window";

export type QuoteRoute = "curve" | "damm";

export interface QuoteView {
  side: TradeSide;
  in: string;
  out: string;
  minOut: string;
  feeZec: string;
  /** The pool fee this trade pays at the chain's current point, in bps: inside a coin's launch window it is the step's fee, after it the coin's tier. null on the DAMM v2 route (its fee is a base plus a dynamic part). */
  feeBps: number | null;
  /** Whole seconds until the launch window closes at the chain's current point; 0 once it has (and always on the DAMM v2 route). */
  windowSecondsLeft: number;
  priceImpactBps: number;
  route: QuoteRoute;
  slippageBps: number;
  /** When the pool state behind this answer was read (ISO). */
  at: string;
}

/** The amount cannot be filled by the pool (a sell of more than the curve takes, a buy past the fundraising target, a trade too small to move a unit). */
export class QuoteUnfillableError extends Error {
  constructor(cause: unknown) {
    super(`the pool cannot fill this amount: ${String((cause as Error)?.message ?? cause)}`);
  }
}

/** A price as a fraction: `num / den` quote raw units per base raw unit. */
export interface Spot {
  num: bigint;
  den: bigint;
}

/** What a quote is worked out from: one read of a coin's pool, its price just before any trade, and the chain's current point. */
export type PoolSnapshot =
  | { route: "curve"; virtualPool: VirtualPool; poolConfig: PoolConfig; spot: Spot; currentPoint: BN; readAtMs: number }
  | { route: "damm"; poolState: PoolState; coinMint: string; spot: Spot; currentPoint: BN; readAtMs: number };

export const QUOTE_MAX_AGE_MS = Number(process.env.PAD_QUOTE_MAX_AGE_MS ?? 2_000);
/** Answers kept at most this many at once: a caller who varies the amount cannot grow memory without bound. */
export const MAX_KEPT_QUOTES = 2_000;

const TWO_128 = 1n << 128n;

/**
 * The chain's current point (a slot or a timestamp, by activation type) is the same for every coin, so one pair of RPC calls per window
 * serves them all instead of one pair per coin. A failed read is not kept.
 */
export const dbcPoint = makeReadCache((activation: number) => withBlockRetry(() => dbcCurrentPoint(getConnection(), activation)), String, QUOTE_MAX_AGE_MS);
const dammPoint = makeReadCache((activation: number) => withBlockRetry(() => dammCurrentPoint(getConnection(), activation)), String, QUOTE_MAX_AGE_MS);

/** How many pool snapshots were read from the chain: what a test counts to show that varying the amount costs no extra read. */
export const quoteReads = { snapshots: 0 };

async function readSnapshot(coin: CoinRow): Promise<PoolSnapshot> {
  quoteReads.snapshots++;
  if (coin.dammPool) {
    const poolState = await viewCpAmm().fetchPoolState(new PublicKey(coin.dammPool));
    const currentPoint = await dammPoint(poolState.activationType);
    const sqrt = BigInt(poolState.sqrtPrice.toString());
    const spot: Spot = poolState.tokenAMint.toBase58() === coin.mint ? { num: sqrt * sqrt, den: TWO_128 } : { num: TWO_128, den: sqrt * sqrt }; // the price is token B per token A
    return { route: "damm", poolState, coinMint: coin.mint, spot, currentPoint, readAtMs: Date.now() };
  }
  const client = getDbcClient();
  const virtualPool = await client.state.getPool(new PublicKey(coin.poolId!));
  const poolConfig = virtualPool ? await client.state.getPoolConfig(virtualPool.poolState.config) : null;
  if (!virtualPool || !poolConfig) throw new Error(`DBC pool ${coin.poolId} or its config was not found`);
  const currentPoint = await dbcPoint(poolConfig.activationType);
  const sqrt = BigInt(virtualPool.poolState.sqrtPrice.toString());
  return { route: "curve", virtualPool, poolConfig, spot: { num: sqrt * sqrt, den: TWO_128 }, currentPoint, readAtMs: Date.now() }; // a DBC pool's base is always token A
}

/** A coin's pool snapshot, read at most once per window per coin; a failed read is not kept. */
export const poolSnapshot = makeReadCache(readSnapshot, (c: CoinRow) => `${c.mint}:${c.poolId}:${c.dammPool ?? ""}`, QUOTE_MAX_AGE_MS);

/**
 * How much worse a trade's average price is than the pool's price just before it, in bps of that price, fee left out of both, rounded
 * down and never below 0. `quoteExFee` is the quote (ZEC) side of the trade without the pool fee, `base` the token side. Integer
 * arithmetic throughout: exec / spot = (quoteExFee x den) / (base x num), so a u64-sized trade loses nothing to a float.
 */
export function priceImpactBps(side: TradeSide, spot: Spot, quoteExFee: bigint, base: bigint): number {
  if (base <= 0n || quoteExFee <= 0n || spot.num <= 0n || spot.den <= 0n) return 0;
  const scaled = quoteExFee * spot.den * 10_000n; // ratio of the two prices, in 1/10,000ths, once divided by `denom`
  const denom = base * spot.num;
  // buy: floor((ratio - 1) x 10,000) = floor(ratio x 10,000) - 10,000; sell: floor((1 - ratio) x 10,000) = 10,000 - ceil(ratio x 10,000)
  const bps = side === "buy" ? scaled / denom - 10_000n : 10_000n - (scaled + denom - 1n) / denom;
  return bps > 0n ? Number(bps) : 0;
}

interface Numbers {
  out: bigint;
  minOut: bigint;
  fee: bigint;
  /** What the buyer's input was after the pool fee (a buy), or what the seller's output was before it (a sell): the fee-free quote side. */
  quoteExFee: bigint;
  base: bigint;
}

function curveNumbers(snap: Extract<PoolSnapshot, { route: "curve" }>, side: TradeSide, amountIn: BN, slippageBps: number): Numbers {
  const q = getDbcClient().pool.swapQuote2({
    virtualPool: snap.virtualPool, config: snap.poolConfig, swapBaseForQuote: side === "sell", hasReferral: false, eligibleForFirstSwapWithMinFee: false,
    currentPoint: snap.currentPoint, slippageBps, swapMode: DbcSwapMode.ExactIn, amountIn,
  });
  const out = BigInt(q.outputAmount.toString());
  const fee = BigInt(q.tradingFee.add(q.protocolFee).add(q.referralFee).toString());
  const isBuy = side === "buy";
  return {
    out, fee, minOut: BigInt((q.minimumAmountOut ?? new BN(0)).toString()),
    quoteExFee: isBuy ? BigInt(q.excludedFeeInputAmount.toString()) : out + fee,
    base: isBuy ? out : BigInt(amountIn.toString()),
  };
}

function dammNumbers(snap: Extract<PoolSnapshot, { route: "damm" }>, side: TradeSide, amountIn: BN, slippageBps: number): Numbers {
  const { poolState } = snap;
  const quoteMint = config.solana.dbc.quoteMint;
  const coinMint = new PublicKey(snap.coinMint);
  const decimalsOf = (m: PublicKey) => (m.equals(quoteMint) ? config.solana.dbc.quoteDecimals : config.solana.dbc.baseDecimals);
  const q = viewCpAmm().getQuote2({
    inputTokenMint: side === "buy" ? quoteMint : coinMint, slippage: slippageBps / 100, currentPoint: snap.currentPoint, poolState, hasReferral: false,
    tokenADecimal: decimalsOf(poolState.tokenAMint), tokenBDecimal: decimalsOf(poolState.tokenBMint), swapMode: DammSwapMode.ExactIn, amountIn,
  });
  const out = BigInt(q.outputAmount.toString());
  const fee = BigInt(q.claimingFee.add(q.protocolFee).add(q.referralFee).toString());
  const isBuy = side === "buy";
  return {
    out, fee, minOut: BigInt((q.minimumAmountOut ?? new BN(0)).toString()),
    quoteExFee: isBuy ? BigInt(q.excludedFeeInputAmount.toString()) : out + fee,
    base: isBuy ? out : BigInt(amountIn.toString()),
  };
}

/** The fee a trade pays now and how long the launch window has left, from the snapshot's own pool, config and current point. */
function windowFacts(snap: PoolSnapshot): Pick<QuoteView, "feeBps" | "windowSecondsLeft"> {
  if (snap.route !== "curve") return { feeBps: null, windowSecondsLeft: 0 };
  const schedule = scheduleOfState(snap.poolConfig);
  const activation = snap.virtualPool.poolState.activationPoint;
  return { feeBps: feeBpsAt(schedule, activation, snap.currentPoint), windowSecondsLeft: windowSecondsLeft(launchWindowOf(schedule, activation), snap.currentPoint) };
}

/**
 * The quote for `amount` (a positive integer string within u64) on a snapshot. Pure arithmetic on the snapshot, so it never touches the
 * chain. Throws QuoteUnfillableError for an amount the pool cannot fill.
 */
export function quoteFromSnapshot(snap: PoolSnapshot, side: TradeSide, amount: string, slippageBps: number): QuoteView {
  let n: Numbers;
  try {
    const amountIn = new BN(amount);
    n = snap.route === "curve" ? curveNumbers(snap, side, amountIn, slippageBps) : dammNumbers(snap, side, amountIn, slippageBps);
  } catch (err) {
    throw new QuoteUnfillableError(err);
  }
  return {
    side, in: amount, out: n.out.toString(), minOut: n.minOut.toString(), feeZec: n.fee.toString(), ...windowFacts(snap),
    priceImpactBps: priceImpactBps(side, snap.spot, n.quoteExFee, n.base),
    route: snap.route, slippageBps, at: new Date(snap.readAtMs).toISOString(),
  };
}

const kept = new Map<string, { atMs: number; view: QuoteView }>();

/** For tests: forget every kept answer and snapshot. */
export function clearQuoteCaches(): void {
  kept.clear();
}

/**
 * The public quote of a coin: the same answer for the same (coin, side, amount, slippage) inside the window, worked out from a
 * snapshot that is itself shared by every amount. A refused amount is not kept (it is cheap to refuse again).
 */
export async function quoteCoin(coin: CoinRow, side: TradeSide, amount: string, slippageBps: number, nowMs: number = Date.now()): Promise<QuoteView> {
  const key = `${coin.mint}:${coin.dammPool ?? ""}:${side}:${amount}:${slippageBps}`;
  const hit = kept.get(key);
  if (hit && nowMs - hit.atMs >= 0 && nowMs - hit.atMs < QUOTE_MAX_AGE_MS) return hit.view;
  const view = quoteFromSnapshot(await poolSnapshot(coin), side, amount, slippageBps);
  if (kept.size >= MAX_KEPT_QUOTES) kept.delete(kept.keys().next().value!);
  kept.set(key, { atMs: nowMs, view });
  return view;
}
