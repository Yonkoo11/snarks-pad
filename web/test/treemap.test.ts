import { describe, expect, test } from 'bun:test'
import { squarify } from '../src/lib/treemap'

describe('squarify', () => {
  const vals = [{ item: 'a', value: 6 }, { item: 'b', value: 6 }, { item: 'c', value: 4 }, { item: 'd', value: 3 }, { item: 'e', value: 2 }, { item: 'f', value: 2 }, { item: 'g', value: 1 }]
  test('the tiles fill the box exactly', () => {
    const t = squarify(vals, 600, 400)
    expect(t.reduce((a, x) => a + x.w * x.h, 0)).toBeCloseTo(600 * 400, 3)
  })
  test('each tile area is its share of the box', () => {
    const t = squarify(vals, 600, 400)
    const a = t.find((x) => x.item === 'a')!
    expect(a.w * a.h).toBeCloseTo((6 / 24) * 600 * 400, 3)
  })
  test('tiles stay inside the box and do not overlap', () => {
    const t = squarify(vals, 600, 400)
    for (const x of t) { expect(x.x).toBeGreaterThanOrEqual(-1e-9); expect(x.y).toBeGreaterThanOrEqual(-1e-9); expect(x.x + x.w).toBeLessThanOrEqual(600 + 1e-6); expect(x.y + x.h).toBeLessThanOrEqual(400 + 1e-6) }
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
      const p = t[i], q = t[j]
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y)
      expect(ox > 1e-6 && oy > 1e-6).toBe(false)
    }
  })
  test('zero, negative and non-finite values get no tile', () => {
    expect(squarify([{ item: 'z', value: 0 }, { item: 'n', value: -3 }, { item: 'x', value: NaN }, { item: 'ok', value: 2 }], 100, 100).map((t) => t.item)).toEqual(['ok'])
  })
  test('nothing to lay out gives nothing', () => {
    expect(squarify([], 100, 100)).toEqual([])
  })
})
