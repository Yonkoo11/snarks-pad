import { describe, expect, test } from 'bun:test'
import { cardModel } from '../src/lib/followcard'
import type { Looked } from '../src/lib/looked'

const base: Looked = { holders: 100, priceZec: '0.5', paidZats: '10000000', at: Date.UTC(2026, 9, 28, 12) }

describe('follow card model', () => {
  test('rows carry the before and after of what the pad held, and no price', () => {
    const m = cardModel('SNRK', base, { holders: 112, paidZats: '45000000' }, { n: 7, sha256: 'ab'.repeat(32) }, null)
    expect(m.rows.map((r) => r.label)).toEqual(['Holders', 'Paid to its holders'])
    expect(m.rows[0].value).toBe('100 to 112 (+12)')
    expect(m.rows[1].value).toBe('0.1 to 0.45 ZEC (+0.35)')
    expect(JSON.stringify(m)).not.toMatch(/price|\$[0-9]/i)
  })
  test('a missing holder count leaves the holders row off instead of guessing it', () => {
    const m = cardModel('SNRK', { ...base, holders: null }, { holders: 112, paidZats: '45000000' }, null, null)
    expect(m.rows.map((r) => r.label)).toEqual(['Paid to its holders'])
    const n = cardModel('SNRK', base, { holders: null, paidZats: '45000000' }, null, null)
    expect(n.rows.map((r) => r.label)).toEqual(['Paid to its holders'])
  })
  test('a fall in holders reads as a fall; the card does not only print good news', () => {
    expect(cardModel('SNRK', base, { holders: 90, paidZats: '10000000' }, null, null).rows[0].value).toBe('100 to 90 (-10)')
  })
  test('a test network says so on its face and the round is optional', () => {
    const m = cardModel('SNRK', base, { holders: 100, paidZats: '10000000' }, null, 'Test network')
    expect(m.network).toBe('Test network'); expect(m.round).toBeNull()
  })
})
