// The coin page's price chart: one point per recorded trade (the trades the engine indexed when browsers confirmed
// them), so it needs no extra chain reads and is cheap to serve. Each point is that trade's fee-adjusted average
// price in zats per whole token: a buy is paid gross of the pool fee and a sell is received net of it, so without the
// adjustment the line would zigzag by the fee on every alternating trade. The fee is the one the trade paid at its time: inside the
// launch window that is the window fee of that second, not the tier (2026-10-12: the first mainnet coin's chart opened at 100x its price).
import BN from "bn.js";
import type { CoinRow, TradeRow } from "../db";
import { decimalRatio } from "./read";
import { endFeeBps, feeBpsAt, hasWindow, storedWindowOf } from "./window";

export interface PricePoint {
  at: string;
  priceZec: string; // zats per 1 whole token, decimal string, same unit as Coin.priceZec
}

export const MAX_PRICE_POINTS = 300;

/** What the price of a trade needs of its coin: the tier fee, the decimals, and (when stored) the launch-window schedule. */
export type PricedCoin = Pick<CoinRow, "feeBps" | "mintDecimals"> & Partial<Pick<CoinRow, "feeSchedule" | "activationPoint">>;
/** What the price of a trade needs of the trade; `at` places it in the coin's launch window. */
export type PricedTrade = Pick<TradeRow, "side" | "amountToken" | "amountZec"> & Partial<Pick<TradeRow, "at">>;

/**
 * The fee a trade paid, in bps. Inside a coin's launch window the curve charges the window fee of that second (dbc/window.ts: 99% in the first
 * second of the 1% tier, falling to the tier by the sixth), and the launcher's own first buy pays the tier fee whatever the second (the config's
 * `enable_first_swap_with_min_fee`); without a stored schedule, or after the window, the tier fee. A DAMM v2 pool's dynamic fee (about 1 to 1.2%,
 * Meteora's number) is taken as the tier fee: close enough for a chart point, and the curve's rows carry no DAMM fee.
 */
export function tradeFeeBps(coin: PricedCoin, t: PricedTrade, opts: { firstTrade?: boolean } = {}): number {
  const stored = storedWindowOf(coin);
  if (!stored || !hasWindow(stored.schedule)) return coin.feeBps;
  if (opts.firstTrade && stored.schedule.firstSwapAtEndFee) return endFeeBps(stored.schedule);
  const atMs = t.at ? Date.parse(t.at) : NaN;
  if (!Number.isFinite(atMs)) return coin.feeBps;
  const second = new BN(Math.floor(atMs / 1000));
  // A trade cannot come before its pool exists (the first buy shares the launch's block, so its time equals the activation). A row dated earlier
  // is a clock the chain did not write; the tier fee reads it, not the 99% that feeBpsAt gives a clock still short of the activation.
  if (second.lt(stored.activation)) return coin.feeBps;
  return feeBpsAt(stored.schedule, stored.activation, second);
}

/**
 * One trade's fee-adjusted average price in zats per whole token, or null for a trade that moved no tokens or no ZEC
 * (a failed read is not a price of 0). A buy is paid gross of the pool fee and a sell is received net of it; the fee is the one
 * the trade paid at its time (tradeFeeBps), so a launch-window buy at 99% does not draw as a price a hundred times the curve's.
 */
export function tradePriceZec(coin: PricedCoin, t: PricedTrade, opts: { firstTrade?: boolean } = {}): string | null {
  const tokens = BigInt(t.amountToken);
  const zec = BigInt(t.amountZec);
  if (tokens <= 0n || zec <= 0n) return null;
  const feeBps = tradeFeeBps(coin, t, opts);
  if (feeBps >= 10_000) return null; // a fee of everything leaves no price to read
  const keep = BigInt(10_000 - feeBps);
  const scale = 10n ** BigInt(coin.mintDecimals);
  // buy: zec is the gross input, the pool took feeBps of it; sell: zec is the net output, the pool took feeBps before it.
  const priceNumerator = t.side === "buy" ? zec * keep * scale : zec * 10_000n * scale;
  const priceDenominator = t.side === "buy" ? tokens * 10_000n : tokens * keep;
  return decimalRatio(priceNumerator, priceDenominator, 12);
}

/**
 * Trades in ascending time order -> price points. A trade with no tokens moved (a failed read) is skipped, not drawn as 0.
 * `firstTradeSig` is the coin's first recorded trade ever (db.firstTradeSig): the launcher's first buy, priced at the tier fee.
 */
export function pricePoints(coin: PricedCoin, trades: TradeRow[], firstTradeSig: string | null = null): PricePoint[] {
  const points: PricePoint[] = [];
  for (const t of trades) {
    const priceZec = tradePriceZec(coin, t, { firstTrade: t.sig === firstTradeSig });
    if (priceZec !== null) points.push({ at: t.at, priceZec });
  }
  return points;
}
