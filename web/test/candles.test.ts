import { describe, expect, test } from 'bun:test'
import { toCandles, pushObs, priceDecimals, secOf } from '../src/lib/candles'

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0)

describe('toCandles', () => {
  test('groups observations by bucket with open, high, low, close and volume', () => {
    const c = toCandles([{ t: T0 + 1_000, v: 10, size: 1 }, { t: T0 + 20_000, v: 14, size: 2 }, { t: T0 + 40_000, v: 8, size: 3 }, { t: T0 + 59_000, v: 9, size: 4 }], 60)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ open: 10, high: 14, low: 8, close: 9, volume: 10 })
  })
  test('a bucket with no trade has no candle: the gap stays a gap', () => {
    const c = toCandles([{ t: T0, v: 1 }, { t: T0 + 600_000, v: 2 }], 60)
    expect(c.map((x) => x.time)).toEqual([T0 / 1000, T0 / 1000 + 600])
  })
  test('unsorted input is sorted; non-finite and non-positive prices are dropped, never drawn as zero', () => {
    const c = toCandles([{ t: T0 + 90_000, v: 3 }, { t: T0, v: 0 }, { t: T0, v: NaN }, { t: T0 + 10_000, v: 2 }], 60)
    expect(c.map((x) => x.close)).toEqual([2, 3])
  })
  test('volume is 0 when the source carries no size', () => {
    expect(toCandles([{ t: T0, v: 5 }], 60)[0].volume).toBe(0)
  })
})

describe('pushObs', () => {
  test('a live trade inside the last bucket moves that candle', () => {
    const base = toCandles([{ t: T0, v: 5, size: 1 }], 60)
    const next = pushObs(base, { t: T0 + 30_000, v: 7, size: 2 }, 60)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ open: 5, high: 7, close: 7, volume: 3 })
  })
  test('a trade in a later bucket opens a new candle; an older one is ignored', () => {
    const base = toCandles([{ t: T0, v: 5 }], 60)
    expect(pushObs(base, { t: T0 + 120_000, v: 6 }, 60)).toHaveLength(2)
    expect(pushObs(base, { t: T0 - 120_000, v: 6 }, 60)).toHaveLength(1)
  })
})

describe('priceDecimals', () => {
  test('a coin at 0.000001 gets enough decimals to tell prices apart', () => {
    expect(priceDecimals([0.000001, 0.0000012]).precision).toBeGreaterThanOrEqual(8)
  })
  test('a coin at 12 needs few', () => {
    expect(priceDecimals([12, 13]).precision).toBeLessThanOrEqual(4)
  })
  test('timeframes know their seconds', () => {
    expect(secOf('1h')).toBe(3600)
  })
})
