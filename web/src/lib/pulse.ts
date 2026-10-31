// The pad's pulse: trades, launches, graduations and payout rounds as one list, newest first. Pure, so a test can read it. Every item
// is a record the pad or the pool already holds; nothing here is estimated, and a kind with no source (no launches in the window) is
// simply absent.
import type { Coin, Epoch, FeedTrade } from './types'

export type PulseItem =
  | { id: string; kind: 'trade'; at: number; mint: string; symbol: string; side: 'buy' | 'sell'; zec: number; wallet: string; dev: boolean }
  | { id: string; kind: 'launch'; at: number; mint: string; symbol: string; name: string }
  | { id: string; kind: 'grad'; at: number; mint: string; symbol: string }
  | { id: string; kind: 'round'; at: number; n: number; paid: number; holdersZats: string }
export type PulseKind = PulseItem['kind']

export type PulseFilter = 'all' | 'trades' | 'big' | 'dev' | 'launches' | 'grads' | 'rounds' | 'mine' | 'following'
export const FILTERS: { id: PulseFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'trades', label: 'Trades' }, { id: 'big', label: 'Big' }, { id: 'dev', label: 'Dev sells' },
  { id: 'launches', label: 'Launches' }, { id: 'grads', label: 'Graduations' }, { id: 'rounds', label: 'Rounds' }, { id: 'mine', label: 'Mine' }, { id: 'following', label: 'Following' },
]

const ZATS = 1e8
export const WINDOW_MS = 48 * 3_600_000 // a launch or graduation is news for two days

export function fromTrades(feed: FeedTrade[]): PulseItem[] {
  return feed.flatMap((t) => {
    const at = Date.parse(t.at), zec = Number(t.amountZec) / ZATS
    return Number.isFinite(at) && zec > 0 ? [{ id: `t:${t.sig}`, kind: 'trade' as const, at, mint: t.mint, symbol: t.symbol, side: t.side, zec, wallet: t.wallet, dev: t.tags.includes('dev') }] : []
  })
}

export function fromCoins(coins: Coin[], now: number): PulseItem[] {
  const out: PulseItem[] = []
  for (const c of coins) {
    const born = Date.parse(c.createdAt)
    if (Number.isFinite(born) && now - born <= WINDOW_MS) out.push({ id: `l:${c.mint}`, kind: 'launch', at: born, mint: c.mint, symbol: c.symbol, name: c.name })
    const grad = c.graduatedAt ? Date.parse(c.graduatedAt) : NaN
    if (Number.isFinite(grad) && now - grad <= WINDOW_MS) out.push({ id: `g:${c.mint}`, kind: 'grad', at: grad, mint: c.mint, symbol: c.symbol })
  }
  return out
}

/** Rounds, newest first as the engine serves them; `n` counts from the first round. */
export function fromEpochs(epochs: Epoch[], max = 3): PulseItem[] {
  return epochs.slice(0, max).flatMap((e, i) => {
    const at = Date.parse(e.at)
    return Number.isFinite(at) ? [{ id: `r:${e.id}`, kind: 'round' as const, at, n: epochs.length - i, paid: e.solanaPayouts.count + e.shielded.count, holdersZats: e.split.holdersZats }] : []
  })
}

/** One list, newest first, one entry per id, at most `limit`. */
export function mergePulse(lists: PulseItem[][], limit: number): PulseItem[] {
  const seen = new Set<string>()
  return lists.flat().sort((a, b) => b.at - a.at).filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))).slice(0, limit)
}

/** What counts as big on this tape: the largest tenth of the trades in it, once there are twenty to say so. Infinity until then. */
export function bigAt(items: PulseItem[]): number {
  const z = items.flatMap((x) => (x.kind === 'trade' ? [x.zec] : [])).sort((a, b) => a - b)
  return z.length < 20 ? Infinity : z[Math.floor(z.length * 0.9)]
}

export interface PulseCtx { wallet: string | null; following: ReadonlySet<string>; big: number }
export function matches(x: PulseItem, f: PulseFilter, ctx: PulseCtx): boolean {
  switch (f) {
    case 'all': return true
    case 'trades': return x.kind === 'trade'
    case 'big': return x.kind === 'trade' && x.zec >= ctx.big
    case 'dev': return x.kind === 'trade' && x.dev && x.side === 'sell'
    case 'launches': return x.kind === 'launch'
    case 'grads': return x.kind === 'grad'
    case 'rounds': return x.kind === 'round'
    case 'mine': return x.kind === 'trade' && ctx.wallet !== null && x.wallet === ctx.wallet
    case 'following': return x.kind !== 'round' && ctx.following.has(x.mint)
  }
}
