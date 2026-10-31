// What the chain says about a coin's pool, from GeckoTerminal's public pool endpoints: the market numbers (price change, volume,
// buys and sells, buyers and sellers, liquidity) and the pool's own recent trades with the wallets that made them. Everything is
// priced in ZEC, the pool's quote token, so no figure here goes through a dollar rate. Same limits as the candle source: 30 reads
// a minute from one address, so every read is shared for 30 s. Mainnet only; the caller shows a plain line elsewhere.
import { ProviderDown, ProviderLimited } from './providerErrors'

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools'
export const WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const
export type Win = (typeof WINDOWS)[number]
export const WIN_LABEL: Record<Win, string> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' }

export interface Txns { buys: number; sells: number; buyers: number; sellers: number }
export interface PoolStats {
  priceChange: Record<Win, number | null> // percent
  volumeZec: Record<Win, number | null>
  txns: Record<Win, Txns | null>
  reserveZec: number | null // the pool's liquidity, both sides, in ZEC
  fdvZec: number | null
  createdAt: string | null
  graduationPct: number | null // the provider's reading of the curve, for a coin still on it
  graduated: boolean | null
  at: number
}

export interface ChainTrade { sig: string; at: number; side: 'buy' | 'sell'; wallet: string; zec: number; tokens: number; priceZec: number }

const num = (v: unknown): number | null => { const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const TTL = 30_000
const cache = new Map<string, { at: number; p: Promise<unknown> }>()
function shared<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.p as Promise<T>
  const p = make()
  cache.set(key, { at: Date.now(), p })
  p.catch(() => cache.delete(key))
  return p
}
async function get(url: string): Promise<unknown> {
  let r: Response
  try { r = await fetch(url, { headers: { accept: 'application/json' } }) } catch { throw new ProviderDown('network') }
  if (r.status === 429) throw new ProviderLimited('rate limited')
  if (!r.ok) throw new ProviderDown(String(r.status))
  return r.json()
}

export function poolStats(pool: string): Promise<PoolStats> {
  return shared(`stats:${pool}`, async () => {
    const body = (await get(`${GT}/${encodeURIComponent(pool)}`)) as { data?: { attributes?: Record<string, unknown> } }
    const a = body.data?.attributes
    if (!a) throw new ProviderDown('empty')
    const zecUsd = num(a.quote_token_price_usd)
    const usdToZec = (v: unknown) => { const n = num(v); return n !== null && zecUsd ? n / zecUsd : null }
    const pc = (a.price_change_percentage ?? {}) as Record<string, unknown>
    const vol = (a.volume_usd ?? {}) as Record<string, unknown>
    const tx = (a.transactions ?? {}) as Record<string, Txns | undefined>
    const launch = (a.launchpad_details ?? null) as { graduation_percentage?: number; completed?: boolean } | null
    const per = <T,>(f: (w: Win) => T) => Object.fromEntries(WINDOWS.map((w) => [w, f(w)])) as Record<Win, T>
    return {
      priceChange: per((w) => num(pc[w])),
      volumeZec: per((w) => usdToZec(vol[w])),
      txns: per((w) => tx[w] ?? null),
      reserveZec: usdToZec(a.reserve_in_usd),
      fdvZec: usdToZec(a.fdv_usd),
      createdAt: typeof a.pool_created_at === 'string' ? a.pool_created_at : null,
      graduationPct: launch?.graduation_percentage ?? null,
      graduated: launch?.completed ?? null,
      at: Date.now(),
    }
  })
}

/** The pool's newest trades (the provider keeps the last day, up to 300), newest first. */
export function poolTrades(pool: string, mint: string): Promise<ChainTrade[]> {
  return shared(`trades:${pool}`, async () => {
    const body = (await get(`${GT}/${encodeURIComponent(pool)}/trades`)) as { data?: { attributes?: Record<string, unknown> }[] }
    const out: ChainTrade[] = []
    for (const row of body.data ?? []) {
      const t = row.attributes ?? {}
      const sell = t.from_token_address === mint
      const from = num(t.from_token_amount), to = num(t.to_token_amount)
      const zec = sell ? to : from
      const tokens = sell ? from : to
      const at = typeof t.block_timestamp === 'string' ? Date.parse(t.block_timestamp) : NaN
      if (zec === null || tokens === null || tokens <= 0 || zec <= 0 || !Number.isFinite(at) || typeof t.tx_hash !== 'string' || typeof t.tx_from_address !== 'string') continue
      out.push({ sig: t.tx_hash, at, side: sell ? 'sell' : 'buy', wallet: t.tx_from_address, zec, tokens, priceZec: zec / tokens })
    }
    return out.sort((x, y) => y.at - x.at)
  })
}

/** What one wallet did in a set of trades: the sums and the span, nothing the trades do not say. */
export function walletActivity(trades: ChainTrade[], wallet: string) {
  const mine = trades.filter((t) => t.wallet === wallet)
  const buys = mine.filter((t) => t.side === 'buy'), sells = mine.filter((t) => t.side === 'sell')
  const sum = (xs: ChainTrade[], f: (t: ChainTrade) => number) => xs.reduce((a, t) => a + f(t), 0)
  const bought = sum(buys, (t) => t.tokens), sold = sum(sells, (t) => t.tokens)
  return {
    n: mine.length, buys: buys.length, sells: sells.length,
    zecIn: sum(buys, (t) => t.zec), zecOut: sum(sells, (t) => t.zec),
    bought, sold, net: bought - sold,
    avgBuy: bought > 0 ? sum(buys, (t) => t.zec) / bought : null,
    first: mine.length ? Math.min(...mine.map((t) => t.at)) : null,
    last: mine.length ? Math.max(...mine.map((t) => t.at)) : null,
  }
}

// ---- off mainnet: the same shapes from the trades the pad itself recorded, so every panel has one honest source to name

import type { FeedTrade } from './types'
const TOKEN_UNIT = 1e6 // the pad's tokens carry six decimals (lib/format TOKEN_DP)
const ZATS = 1e8
const WIN_MS: Record<Win, number> = { m5: 300_000, h1: 3_600_000, h6: 21_600_000, h24: 86_400_000 }

/** The pad's recorded trades as pool trades. They are only the trades made through the pad's own buy box. */
export function chainFromRecorded(trades: FeedTrade[]): ChainTrade[] {
  return trades.flatMap((t) => {
    const zec = Number(t.amountZec) / ZATS, tokens = Number(t.amountToken) / TOKEN_UNIT
    const at = Date.parse(t.at)
    return zec > 0 && tokens > 0 && Number.isFinite(at) ? [{ sig: t.sig, at, side: t.side, wallet: t.wallet, zec, tokens, priceZec: zec / tokens }] : []
  }).sort((x, y) => y.at - x.at)
}

/** The market numbers over the trades given: counts, volume and distinct wallets per window. Price change is not derivable from a few trades, so it is null here. */
export function statsFromTrades(trades: ChainTrade[], now: number): PoolStats {
  const per = <T,>(f: (w: Win) => T) => Object.fromEntries((['m5', 'h1', 'h6', 'h24'] as Win[]).map((w) => [w, f(w)])) as Record<Win, T>
  const inWin = (w: Win) => trades.filter((t) => now - t.at <= WIN_MS[w])
  return {
    priceChange: per(() => null),
    volumeZec: per((w) => inWin(w).reduce((a, t) => a + t.zec, 0)),
    txns: per((w) => {
      const xs = inWin(w), b = xs.filter((t) => t.side === 'buy'), s = xs.filter((t) => t.side === 'sell')
      return { buys: b.length, sells: s.length, buyers: new Set(b.map((t) => t.wallet)).size, sellers: new Set(s.map((t) => t.wallet)).size }
    }),
    reserveZec: null, fdvZec: null, createdAt: null, graduationPct: null, graduated: null, at: now,
  }
}
