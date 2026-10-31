import { describe, expect, test } from 'bun:test'
import { planHop, pathFrames, bodyFrames, springStep, lookAngle, cheerFrames } from '../src/lib/palMove'
import { newRound, newGraduations, holdersGained, creatorSell } from '../src/lib/palEvents'
import { poseSrc } from '../src/lib/palPoses'
import type { Coin, Epoch, FeedTrade } from '../src/lib/types'

describe('hop plan', () => {
  test('a short hop takes the minimum time and a small arc; a long one is capped', () => {
    const near = planHop({ x: 0, y: 0 }, { x: 50, y: 0 })
    expect(near.dur).toBeGreaterThanOrEqual(520)
    expect(near.dur).toBeLessThan(560)
    const far = planHop({ x: 0, y: 0 }, { x: 3000, y: 0 })
    expect(far.dur).toBe(1150)
    expect(far.arc).toBe(230)
    expect(far.leap).toBe(true)
    expect(near.leap).toBe(false)
  })
  test('the apex is above both ends, and the path ends on the target', () => {
    const h = planHop({ x: 0, y: 300 }, { x: 400, y: 100 })
    expect(h.mid.y).toBeLessThan(100)
    const f = pathFrames(h)
    expect(f[f.length - 1].transform).toBe('translate(400px, 100px)')
    expect(f[0].transform).toBe('translate(0px, 300px)')
  })
  test('it leans into the direction of travel and is never mirrored', () => {
    expect(planHop({ x: 0, y: 0 }, { x: 200, y: 0 }).tilt).toBeGreaterThan(0)
    expect(planHop({ x: 200, y: 0 }, { x: 0, y: 0 }).tilt).toBeLessThan(0)
    for (const k of [...bodyFrames(planHop({ x: 0, y: 0 }, { x: -300, y: 0 })), ...cheerFrames()]) expect(String(k.transform)).not.toMatch(/scaleX\(-|scale\(-/)
  })
  test('the body frames start and end at rest', () => {
    const b = bodyFrames(planHop({ x: 0, y: 0 }, { x: 100, y: 0 }))
    expect(b[0].transform).toBe('scale(1,1) rotate(0deg)')
    expect(b[b.length - 1].transform).toBe('scale(1,1) rotate(0deg)')
  })
})

describe('spring', () => {
  test('it settles on the target and does not blow up on a long frame', () => {
    let s = { pos: 0, vel: 0 }
    for (let i = 0; i < 120; i++) s = springStep(s.pos, s.vel, 10, 1 / 60)
    expect(s.pos).toBeCloseTo(10, 1)
    expect(Math.abs(springStep(0, 0, 10, 0.5).pos)).toBeLessThan(50)
  })
  test('it looks toward a near pointer and ignores a far one', () => {
    expect(lookAngle(100, 0)).toBe(5)
    expect(lookAngle(-100, 0)).toBe(-5)
    expect(lookAngle(500, 0)).toBe(0)
    expect(Math.abs(lookAngle(20, 0))).toBeLessThan(5)
  })
})

const ep = (id: string, sol = 3, shd = 1) => ({ id, solanaPayouts: { count: sol }, shielded: { count: shd } }) as unknown as Epoch
const coin = (mint: string, graduatedAt?: string) => ({ mint, symbol: mint.toUpperCase(), graduatedAt }) as unknown as Coin
const tr = (side: 'buy' | 'sell', dev: boolean, at: string) => ({ sig: at, side, tags: dev ? ['dev'] : [], at }) as unknown as FeedTrade

describe('what is worth noticing', () => {
  test('a round is news only against an earlier reading', () => {
    expect(newRound(null, [ep('r2')])).toBeNull()
    expect(newRound('r2', [ep('r2')])).toBeNull()
    expect(newRound('r1', [ep('r2'), ep('r1')])).toEqual({ id: 'r2', n: 2, paid: 4 })
  })
  test('a graduation is news once, and only after the visit began', () => {
    const cs = [coin('a', '2026-10-31T12:00:00Z'), coin('b', '2026-10-30T12:00:00Z'), coin('c')]
    expect(newGraduations(cs, Date.parse('2026-10-31T00:00:00Z'), new Set()).map((c) => c.mint)).toEqual(['a'])
    expect(newGraduations(cs, Date.parse('2026-10-31T00:00:00Z'), new Set(['a']))).toEqual([])
  })
  test('holders gained needs both counts and growth', () => {
    expect(holdersGained(10, 14)).toBe(4)
    expect(holdersGained(10, 10)).toBeNull()
    expect(holdersGained(10, 8)).toBeNull()
    expect(holdersGained(null, 8)).toBeNull()
    expect(holdersGained(10, null)).toBeNull()
  })
  test('only a creator sell after the mark counts', () => {
    const ts = [tr('sell', true, '2026-10-31T10:00:00Z'), tr('sell', false, '2026-10-31T11:00:00Z'), tr('buy', true, '2026-10-31T11:30:00Z')]
    expect(creatorSell(ts, Date.parse('2026-10-31T09:00:00Z'))?.sig).toBe('2026-10-31T10:00:00Z')
    expect(creatorSell(ts, Date.parse('2026-10-31T10:30:00Z'))).toBeNull()
  })
})

describe('poses', () => {
  test('every pose resolves to a drawing, falling back to the standing one', () => {
    expect(poseSrc('cheer')).toMatch(/mascot-cut/)
    expect(poseSrc('nope' as never)).toMatch(/mascot-cut/)
  })
})
