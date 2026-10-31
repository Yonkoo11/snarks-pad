import { describe, expect, test } from 'bun:test'
import { envelopePose, type EnvState } from '../src/lib/envelope'

const base: EnvState = { connected: false, ready: false, holdK: 0, busy: false, done: false, failed: false }

describe('envelope pose', () => {
  test('before anything is done only the horns show, the flap half open', () => {
    const p = envelopePose(base)
    expect(p.mood).toBe('asleep'); expect(p.rise).toBeLessThan(0.2); expect(p.flap).toBeLessThan(1)
  })
  test('a connected wallet wakes it, a valid address makes it ready, and each rises a little', () => {
    const a = envelopePose({ ...base, connected: true }), b = envelopePose({ ...base, connected: true, ready: true })
    expect(a.mood).toBe('wait'); expect(b.mood).toBe('ready')
    expect(b.rise).toBeGreaterThan(a.rise)
  })
  test('the hold lifts it as it goes, and never to the top', () => {
    const r = [0.1, 0.5, 1].map((k) => envelopePose({ ...base, connected: true, ready: true, holdK: k }).rise)
    expect(r[0]).toBeLessThan(r[1]); expect(r[1]).toBeLessThan(r[2])
    expect(Math.max(...r)).toBeLessThan(1)
  })
  test('a pending request keeps it halfway: only the pad confirming lets it out', () => {
    const p = envelopePose({ ...base, connected: true, ready: true, busy: true })
    expect(p.mood).toBe('work'); expect(p.rise).toBe(0.5); expect(p.sealed).toBe(false)
    const d = envelopePose({ ...base, connected: true, ready: true, busy: true, done: true })
    expect(d.rise).toBe(1); expect(d.sealed).toBe(true)
  })
  test('a refusal ducks it in and nearly shuts the flap, and nothing is sealed', () => {
    const p = envelopePose({ ...base, connected: true, ready: true, failed: true })
    expect(p.mood).toBe('duck'); expect(p.rise).toBe(0); expect(p.flap).toBeLessThan(0.3); expect(p.sealed).toBe(false)
  })
})
