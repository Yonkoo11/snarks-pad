// Candles for the coin chart, built from whatever price observations the page holds. Pure, so a test can read it.
// A bucket with no trade has no candle: the chart shows a gap, never a flat invented price.
export interface Candle {
  time: number // seconds since the epoch, the start of the bucket (what the chart library takes)
  open: number
  high: number
  low: number
  close: number
  volume: number // in the unit of the observations' `size`, 0 when the source carries none
}

export interface Obs { t: number; v: number; size?: number } // t in ms, v the price, size the traded amount if known

export const TIMEFRAMES = [
  { id: '1m', sec: 60, label: '1m' },
  { id: '5m', sec: 300, label: '5m' },
  { id: '15m', sec: 900, label: '15m' },
  { id: '1h', sec: 3600, label: '1h' },
  { id: '4h', sec: 14_400, label: '4h' },
  { id: '1d', sec: 86_400, label: '1d' },
] as const
export type Timeframe = (typeof TIMEFRAMES)[number]['id']
export const secOf = (tf: Timeframe): number => TIMEFRAMES.find((x) => x.id === tf)!.sec

const usable = (o: Obs) => Number.isFinite(o.t) && Number.isFinite(o.v) && o.v > 0

/** Observations to candles, oldest first. Observations that are not finite and positive are dropped, never drawn as 0. */
export function toCandles(obs: Obs[], sec: number): Candle[] {
  const sorted = obs.filter(usable).sort((a, b) => a.t - b.t)
  const out: Candle[] = []
  for (const o of sorted) {
    const time = Math.floor(o.t / 1000 / sec) * sec
    const last = out[out.length - 1]
    if (last && last.time === time) {
      if (o.v > last.high) last.high = o.v
      if (o.v < last.low) last.low = o.v
      last.close = o.v
      last.volume += o.size ?? 0
    } else {
      out.push({ time, open: o.v, high: o.v, low: o.v, close: o.v, volume: o.size ?? 0 })
    }
  }
  return out
}

/** One more observation folded into the candles, in place of a re-read: the live trade moves the last candle or opens the next. Older than the last candle is ignored. */
export function pushObs(candles: Candle[], o: Obs, sec: number): Candle[] {
  if (!usable(o)) return candles
  const time = Math.floor(o.t / 1000 / sec) * sec
  const last = candles[candles.length - 1]
  if (!last || time > last.time) return [...candles, { time, open: o.v, high: o.v, low: o.v, close: o.v, volume: o.size ?? 0 }]
  if (time < last.time) return candles
  const next = { ...last, high: Math.max(last.high, o.v), low: Math.min(last.low, o.v), close: o.v, volume: last.volume + (o.size ?? 0) }
  return [...candles.slice(0, -1), next]
}

/** The price scale the chart needs for a coin that trades at 0.000001: enough decimals to tell two prices apart. */
export function priceDecimals(prices: number[]): { precision: number; minMove: number } {
  const finite = prices.filter((p) => Number.isFinite(p) && p > 0)
  if (finite.length === 0) return { precision: 4, minMove: 0.0001 }
  const lo = Math.min(...finite)
  const mag = Math.floor(Math.log10(lo))
  const precision = Math.min(12, Math.max(2, 3 - mag))
  return { precision, minMove: Number((10 ** -precision).toFixed(precision)) }
}
