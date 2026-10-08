// The 24-hour market numbers of the public coin list and coin page docs/API.md v2.5: volume, trade count and
// the price change. They come from the trades table only: the trades this engine RECORDED (a browser's
// POST /coins/:mint/trade-confirm, or the seed scripts), never from the chain, so a trade made anywhere else (another
// front end, a direct swap) is not in them. One pass over the last 24 hours serves every coin and is kept for
// PAD_COIN_STATS_MAX_AGE_MS (5 s), so the cost does not grow with the request rate (stress D6/D7).
import * as db from "../db";
import { makeTtlMemo } from "../util/memo";
import { tradePriceZec } from "./priceHistory";

export const WINDOW_MS = 24 * 3_600_000;
const PRICE_DP = 12; // Coin.priceZec and the trade prices carry at most 12 decimals

export interface WindowStats {
  /** Sum of the window's recorded ZEC amounts: what a buyer paid (pool fee included) or a seller received (pool fee already taken). */
  volume24hZats: string;
  trades24h: number;
  /** The fee-adjusted price (zats per whole token, same unit as price-history) of the first trade of the window that has one. */
  firstPriceZec: string | null;
}

export const NO_TRADES: WindowStats = { volume24hZats: "0", trades24h: 0, firstPriceZec: null };

const DIGITS = /^[0-9]+$/;

/** Per coin that traded in the 24 hours up to `nowMs`; a coin that did not is absent. A row with a non-numeric amount is skipped, not fatal. */
export function windowStatsByMint(nowMs: number): Map<string, WindowStats> {
  const coins = new Map(db.listCoins().map((c) => [c.mint, c]));
  const acc = new Map<string, { volume: bigint; trades: number; firstPriceZec: string | null }>();
  for (const t of db.listTradesSince(new Date(nowMs - WINDOW_MS).toISOString())) {
    if (!DIGITS.test(t.amountZec) || !DIGITS.test(t.amountToken)) continue;
    const a = acc.get(t.mint) ?? { volume: 0n, trades: 0, firstPriceZec: null };
    acc.set(t.mint, a);
    a.volume += BigInt(t.amountZec);
    a.trades += 1;
    const coin = coins.get(t.mint);
    if (a.firstPriceZec === null && coin) a.firstPriceZec = tradePriceZec(coin, t);
  }
  return new Map([...acc].map(([mint, a]) => [mint, { volume24hZats: a.volume.toString(), trades24h: a.trades, firstPriceZec: a.firstPriceZec }]));
}

/** How old the public 24-hour numbers may be, in ms (PAD_COIN_STATS_MAX_AGE_MS, default 5 s). */
export const STATS_MAX_AGE_MS = Number(process.env.PAD_COIN_STATS_MAX_AGE_MS ?? 5_000);

/** Every coin's window stats, at most STATS_MAX_AGE_MS old. */
export const windowStats = makeTtlMemo(windowStatsByMint, STATS_MAX_AGE_MS);

/** A decimal string of at most PRICE_DP decimals as an integer count of 10^-PRICE_DP, or null for anything else. */
function scaled(price: string): bigint | null {
  const m = /^([0-9]+)(?:\.([0-9]{1,12}))?$/.exec(price);
  return m ? BigInt(m[1]!) * 10n ** BigInt(PRICE_DP) + BigInt((m[2] ?? "").padEnd(PRICE_DP, "0")) : null;
}

/**
 * Price now against the first trade's price of the window, in basis points (+10,000 = doubled), rounded to the nearest
 * with halves away from zero. null when there is no first price or either price is not above zero (a price that rounds
 * to "0" at 12 decimals cannot be compared).
 */
export function priceChangeBps(firstPriceZec: string | null, priceNowZec: string): number | null {
  const first = firstPriceZec === null ? null : scaled(firstPriceZec);
  const now = scaled(priceNowZec);
  if (first === null || now === null || first <= 0n || now <= 0n) return null;
  const change = (now - first) * 10_000n;
  const magnitude = ((change < 0n ? -change : change) * 2n + first) / (2n * first);
  return Number(change < 0n ? -magnitude : magnitude);
}
