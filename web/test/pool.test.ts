import { describe, expect, test } from 'bun:test'
import { walletActivity, type ChainTrade } from '../src/lib/pool'

const t = (side: 'buy' | 'sell', wallet: string, zec: number, tokens: number, at: number): ChainTrade => ({ sig: `${wallet}${at}`, at, side, wallet, zec, tokens, priceZec: zec / tokens })

describe('walletActivity', () => {
  const trades = [t('buy', 'A', 1, 100, 1), t('buy', 'A', 2, 150, 2), t('sell', 'A', 1.5, 120, 3), t('buy', 'B', 9, 900, 4)]
  test('sums only that wallet, in and out', () => {
    const a = walletActivity(trades, 'A')
    expect(a).toMatchObject({ n: 3, buys: 2, sells: 1, zecIn: 3, zecOut: 1.5, bought: 250, sold: 120, net: 130, first: 1, last: 3 })
  })
  test('average buy price is the ZEC paid over the tokens bought', () => {
    expect(walletActivity(trades, 'A').avgBuy).toBeCloseTo(3 / 250, 10)
  })
  test('a wallet with no trade here has nothing, not zeros that look like activity', () => {
    const z = walletActivity(trades, 'Z')
    expect(z.n).toBe(0)
    expect(z.avgBuy).toBeNull()
    expect(z.first).toBeNull()
  })
})
