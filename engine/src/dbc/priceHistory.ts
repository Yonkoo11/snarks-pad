// The coin page's price chart: one point per recorded trade (the trades the engine indexed when browsers confirmed
// them), so it needs no extra chain reads and is cheap to serve. Each point is that trade's fee-adjusted average
// price in zats per whole token: a buy is paid gross of the pool fee and a sell is received net of it, so without the
// adjustment the line would zigzag by the fee on every alternating trade.
import type { CoinRow, TradeRow } from "../db";
import { decimalRatio } from "./read";

export interface PricePoint {
  at: string;
  priceZec: string; // zats per 1 whole token, decimal string, same unit as Coin.priceZec
}

export const MAX_PRICE_POINTS = 300;

/**
 * One trade's fee-adjusted average price in zats per whole token, or null for a trade that moved no tokens or no ZEC
 * (a failed read is not a price of 0). A buy is paid gross of the pool fee and a sell is received net of it.
 */
export function tradePriceZec(coin: Pick<CoinRow, "feeBps" | "mintDecimals">, t: Pick<TradeRow, "side" | "amountToken" | "amountZec">): string | null {
  const tokens = BigInt(t.amountToken);
  const zec = BigInt(t.amountZec);
  if (tokens <= 0n || zec <= 0n) return null;
  const keep = BigInt(10_000 - coin.feeBps);
  const scale = 10n ** BigInt(coin.mintDecimals);
  // buy: zec is the gross input, the pool took feeBps of it; sell: zec is the net output, the pool took feeBps before it.
  const priceNumerator = t.side === "buy" ? zec * keep * scale : zec * 10_000n * scale;
  const priceDenominator = t.side === "buy" ? tokens * 10_000n : tokens * keep;
  return decimalRatio(priceNumerator, priceDenominator, 12);
}

/** Trades in ascending time order -> price points. A trade with no tokens moved (a failed read) is skipped, not drawn as 0. */
export function pricePoints(coin: Pick<CoinRow, "feeBps" | "mintDecimals">, trades: TradeRow[]): PricePoint[] {
  const points: PricePoint[] = [];
  for (const t of trades) {
    const priceZec = tradePriceZec(coin, t);
    if (priceZec !== null) points.push({ at: t.at, priceZec });
  }
  return points;
}
