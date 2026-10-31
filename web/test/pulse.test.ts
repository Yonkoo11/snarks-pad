import { describe, expect, test } from 'bun:test'
import { bigAt, fromCoins, fromTrades, mergePulse, matches, type PulseItem } from '../src/lib/pulse'
import type { Coin, FeedTrade } from '../src/lib/types'

const NOW = Date.UTC(2026, 9, 31, 12)
const trade = (sig: string, zats: number, minsAgo: number, extra: Partial<FeedTrade> = {}): FeedTrade => ({ sig, side: 'buy', wallet: 'W', amountZec: String(zats), amountToken: '1', at: new Date(NOW - minsAgo * 60_000).toISOString(), mint: 'M', symbol: 'AAA', tags: [], ...extra } as FeedTrade)
const coin = (o: Partial<Coin>): Coin => ({ mint: 'M', symbol: 'AAA', name: 'Aaa', createdAt: new Date(NOW - 3_600_000).toISOString(), ...o } as Coin)

describe('pulse', () => {
  test('trades become items in ZEC; unusable ones are dropped', () => {
    const items = fromTrades([trade('a', 50_000_000, 1), trade('b', 0, 1), trade('c', 1, -1, { at: 'nope' })])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'trade', zec: 0.5 })
  })
  test('a coin launched or graduated inside two days is news, older is not', () => {
    const items = fromCoins([coin({ mint: 'new' }), coin({ mint: 'old', createdAt: new Date(NOW - 5 * 86_400_000).toISOString() }), coin({ mint: 'gr', createdAt: new Date(NOW - 9 * 86_400_000).toISOString(), graduatedAt: new Date(NOW - 7_200_000).toISOString() })], NOW)
    expect(items.map((i) => i.id).sort()).toEqual(['g:gr', 'l:new'])
  })
  test('merge sorts newest first, keeps one entry per id and the limit', () => {
    const a = fromTrades([trade('x', 1e8, 5), trade('y', 1e8, 1)])
    const merged = mergePulse([a, a, fromCoins([coin({})], NOW)], 3)
    expect(merged.map((i) => i.at)).toEqual([...merged.map((i) => i.at)].sort((p, q) => q - p))
    expect(new Set(merged.map((i) => i.id)).size).toBe(merged.length)
    expect(merged.length).toBeLessThanOrEqual(3)
  })
  test('big is the top tenth of the trades, and only once there are twenty', () => {
    const few = fromTrades(Array.from({ length: 19 }, (_, i) => trade(`s${i}`, (i + 1) * 1e6, i)))
    expect(bigAt(few)).toBe(Infinity)
    const many = fromTrades(Array.from({ length: 20 }, (_, i) => trade(`s${i}`, (i + 1) * 1e6, i)))
    expect(bigAt(many)).toBeCloseTo(19e6 / 1e8, 10)
  })
  test('filters read what the item says: dev sells, mine, following', () => {
    const t = fromTrades([trade('d', 1e8, 1, { side: 'sell', tags: ['dev'] }), trade('m', 1e8, 1, { wallet: 'ME' })]) as PulseItem[]
    const ctx = { wallet: 'ME', following: new Set(['M']), big: Infinity }
    expect(t.filter((x) => matches(x, 'dev', ctx)).map((x) => x.id)).toEqual(['t:d'])
    expect(t.filter((x) => matches(x, 'mine', ctx)).map((x) => x.id)).toEqual(['t:m'])
    expect(t.every((x) => matches(x, 'following', ctx))).toBe(true)
    expect(matches(t[0], 'mine', { ...ctx, wallet: null })).toBe(false)
  })
})
