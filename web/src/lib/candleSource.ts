// Where the coin chart's candles come from. On mainnet: GeckoTerminal's public pool OHLCV (the pool's own on-chain trades, in the
// pool's quote token, which for this pad is ZEC, so prices and volume are already ZEC), read straight from the browser (the API
// answers any origin). Off mainnet, or when the provider cannot answer: the pad's own recorded trades, which are only the trades
// made through the pad's buy box, and the chart says so. The caller says which source it got; nothing here pretends to be another.
import { api } from './api'
import { toCandles, type Candle, type Timeframe } from './candles'
import type { PadMode } from './types'
import { ProviderDown, ProviderLimited } from './providerErrors'
import { poolProviderOn } from './chartSource'

export type SourceId = 'geckoterminal' | 'recorded'
export interface CandleResult { source: SourceId; candles: Candle[]; at: number; note?: string }

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools'
const UNIT: Record<Timeframe, { unit: 'minute' | 'hour' | 'day'; agg: number }> = {
  '1m': { unit: 'minute', agg: 1 }, '5m': { unit: 'minute', agg: 5 }, '15m': { unit: 'minute', agg: 15 },
  '1h': { unit: 'hour', agg: 1 }, '4h': { unit: 'hour', agg: 4 }, '1d': { unit: 'day', agg: 1 },
}

export { ProviderLimited, ProviderDown } from './providerErrors'

const TTL = 30_000 // the provider's own cache lasts 30 s and its free tier allows 30 reads a minute
const cache = new Map<string, { at: number; p: Promise<Candle[]> }>()

/** The provider's candles for a pool, oldest first. Same read inside 30 s shares one request. */
export function geckoCandles(pool: string, tf: Timeframe, before?: number): Promise<Candle[]> {
  const key = `${pool}:${tf}:${before ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.p
  const { unit, agg } = UNIT[tf]
  const url = `${GT}/${encodeURIComponent(pool)}/ohlcv/${unit}?aggregate=${agg}&limit=1000&currency=token${before ? `&before_timestamp=${before}` : ''}`
  const p = (async () => {
    let r: Response
    try { r = await fetch(url, { headers: { accept: 'application/json' } }) } catch { throw new ProviderDown('network') }
    if (r.status === 429) throw new ProviderLimited('rate limited')
    if (!r.ok) throw new ProviderDown(String(r.status))
    const body = await r.json() as { data?: { attributes?: { ohlcv_list?: number[][] } } }
    const list = body.data?.attributes?.ohlcv_list ?? []
    return list
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
      .sort((a, b) => a.time - b.time)
  })()
  cache.set(key, { at: Date.now(), p })
  p.catch(() => cache.delete(key))
  return p
}

/** The coin's candles from the best source this pad can honestly name. */
export async function loadCandles(opts: { mint: string; pool: string; tf: Timeframe; mode: PadMode | null }): Promise<CandleResult> {
  const { mint, pool, tf, mode } = opts
  if (poolProviderOn(mode) && pool) {
    try {
      const candles = await geckoCandles(pool, tf)
      return { source: 'geckoterminal', candles, at: Date.now() }
    } catch (e) {
      const why = e instanceof ProviderLimited ? 'The candle provider is rate limiting this browser, so the chart shows the pad\'s recorded trades.' : 'The candle provider did not answer, so the chart shows the pad\'s recorded trades.'
      return { ...(await recorded(mint, tf)), note: why }
    }
  }
  return recorded(mint, tf)
}

async function recorded(mint: string, tf: Timeframe): Promise<CandleResult> {
  const { points } = await api.priceHistory(mint)
  const obs = points.map((p) => ({ t: Date.parse(p.at), v: Number(p.priceZec) / 1e8 })) // zats per whole token to ZEC per token
  return { source: 'recorded', candles: toCandles(obs, { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }[tf]), at: Date.now() }
}
