// Filtering, sorting and paging of the coin list, in one place for the two callers that need the same answer: the
// in-browser mock (standing in for a v2.5 engine that takes ?sort=&stage=&q=&limit=&offset=) and the Explore page,
// which does the work itself when a v2.4 engine answers with the whole list and no `total`.
import type { Coin } from './types'

// `featured` is the web's own default order: coin #1 first, then market cap. The engine knows the other four; the page asks it for `mcap` and pins.
export type CoinSort = 'featured' | 'new' | 'mcap' | 'volume' | 'progress'
export type ServerSort = Exclude<CoinSort, 'featured'>
export type CoinStage = 'curve' | 'graduated'
/** `all`: every coin the pad has not hidden, not just the board's featured list (a wallet's holdings must find any pad coin). */
export interface CoinQuery { sort?: ServerSort; stage?: CoinStage; q?: string; limit?: number; offset?: number; all?: boolean }
export const FEATURED = 'SNARKS'
export const serverSort = (s: CoinSort): ServerSort => (s === 'featured' ? 'mcap' : s)

const big = (s?: string): bigint => { try { return BigInt(s || '0') } catch { return 0n } }
const desc = (a: bigint, b: bigint): number => (a < b ? 1 : a > b ? -1 : 0)

export function filterCoins(list: Coin[], q: CoinQuery): Coin[] {
  const s = q.q?.trim().toLowerCase()
  return list.filter((c) => (!q.stage || c.stage === q.stage) && (!s || c.name.toLowerCase().includes(s) || c.symbol.toLowerCase().includes(s)))
}

/** `progress` lists the coins still on a curve first, nearest graduation first; a coin without a v2.5 volume sorts as 0. */
export function sortCoins(list: Coin[], sort: CoinSort): Coin[] {
  const out = [...list]
  if (sort === 'featured') return pinFirst(sortCoins(out, 'mcap'), FEATURED)
  if (sort === 'new') return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  if (sort === 'volume') return out.sort((a, b) => desc(big(a.volume24hZats), big(b.volume24hZats)) || desc(big(a.marketCapZec), big(b.marketCapZec)))
  if (sort === 'progress') {
    return out.sort((a, b) => Number(a.stage === 'graduated') - Number(b.stage === 'graduated') || (b.curveProgress ?? 0) - (a.curveProgress ?? 0) || desc(big(a.marketCapZec), big(b.marketCapZec)))
  }
  return out.sort((a, b) => desc(big(a.marketCapZec), big(b.marketCapZec)))
}

/** The coin with this symbol moved to the front (the featured first card); the rest keep their order. */
export function pinFirst(list: Coin[], symbol: string): Coin[] {
  const i = list.findIndex((c) => c.symbol === symbol)
  return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)]
}
