import { describe, expect, test } from 'bun:test'
import { nearestIndex, plot, sinceOf, toChartPoints } from '../src/lib/chart'

const pt = (at: string, priceZec: string) => ({ at, priceZec })

describe('toChartPoints', () => {
  test('keeps finite positive prices, in time order', () => {
    const out = toChartPoints([pt('2026-10-02T00:00:00Z', '2'), pt('2026-10-01T00:00:00Z', '1')])
    expect(out.map((p) => p.v)).toEqual([1, 2])
    expect(out[0].t).toBeLessThan(out[1].t)
  })
  test('drops zero, negative, NaN prices and unreadable dates instead of drawing them as 0', () => {
    const out = toChartPoints([
      pt('2026-10-01T00:00:00Z', '0'),
      pt('2026-10-01T00:01:00Z', '-1'),
      pt('2026-10-01T00:02:00Z', 'not a number'),
      pt('not a date', '1'),
      pt('2026-10-01T00:03:00Z', '3'),
    ])
    expect(out.map((p) => p.v)).toEqual([3])
  })
})

describe('plot', () => {
  test('no points gives no plot', () => {
    expect(plot([], 600, 200)).toBeNull()
  })
  test('one trade draws a flat line across the full width', () => {
    const p = plot([{ t: 1, v: 5 }], 600, 200)!
    expect(p.xs).toEqual([0, 600])
    expect(p.ys[0]).toBe(p.ys[1])
    expect(p.min).toBe(5)
    expect(p.max).toBe(5)
  })
  test('points spread evenly by trade, not by time, and the area closes to the floor', () => {
    const p = plot([{ t: 0, v: 1 }, { t: 1_000_000, v: 2 }, { t: 1_000_001, v: 3 }], 600, 200)!
    expect(p.xs).toEqual([0, 300, 600])
    expect(p.area.endsWith('Z')).toBe(true)
    // higher price sits higher on the box (smaller y)
    expect(p.ys[2]).toBeLessThan(p.ys[0])
    expect(p.min).toBe(1)
    expect(p.max).toBe(3)
  })
  test('every y stays inside the box, with the pad ratio applied', () => {
    const p = plot([{ t: 0, v: 1 }, { t: 1, v: 100 }], 600, 200)!
    for (const y of p.ys) {
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(200)
    }
  })
})

describe('sinceOf', () => {
  const now = 1_000_000_000_000
  test('all means no cut-off', () => expect(sinceOf('all', now)).toBeNull())
  test('24h and 7d cut from now', () => {
    expect(sinceOf('24h', now)).toBe(now - 24 * 3_600_000)
    expect(sinceOf('7d', now)).toBe(now - 7 * 24 * 3_600_000)
  })
})

describe('nearestIndex', () => {
  test('finds the closest drawn point', () => {
    expect(nearestIndex([0, 300, 600], 290)).toBe(1)
    expect(nearestIndex([0, 300, 600], 10)).toBe(0)
    expect(nearestIndex([0, 300, 600], 599)).toBe(2)
  })
})
