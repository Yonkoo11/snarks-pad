import { describe, expect, test } from 'bun:test'
import { wasAway, AWAY_MS } from '../src/lib/returning'

describe('having been away', () => {
  const now = Date.UTC(2026, 9, 31, 12)
  test('a first visit, with no earlier mark, is not a return', () => {
    expect(wasAway(null, now)).toBe(false)
    expect(wasAway(0, now)).toBe(false)
    expect(wasAway(Number.NaN, now)).toBe(false)
  })
  test('a short gap is the same visit, a long one is a return', () => {
    expect(wasAway(now - 10 * 60_000, now)).toBe(false)
    expect(wasAway(now - AWAY_MS, now)).toBe(true)
    expect(wasAway(now - 5 * 3_600_000, now)).toBe(true)
  })
})
