import { describe, expect, test } from 'bun:test'
import { remember, changedNote, MAX_SAID, type Said } from '../src/lib/palLog'

const said = (text: string, at: number, holders: number | null = null, mint: string | null = null): Said => ({ at, text, mint, holders })

describe('what Snarks said', () => {
  test('the newest line is first and only ten are kept', () => {
    let log: Said[] = []
    for (let i = 0; i < 14; i++) log = remember(log, said(`line ${i}`, i * 120_000))
    expect(log).toHaveLength(MAX_SAID)
    expect(log[0].text).toBe('line 13')
  })
  test('the same line within a minute is not written twice, a later repeat is', () => {
    let log = remember([], said('Round 7 paid 46 wallets.', 1000))
    log = remember(log, said('Round 7 paid 46 wallets.', 30_000))
    expect(log).toHaveLength(1)
    log = remember(log, said('Round 7 paid 46 wallets.', 200_000))
    expect(log).toHaveLength(2)
  })
  test('a quoted holder count is checked against the count now, and only when it differs', () => {
    const e = said('$SNRK: +12 holders since the last check.', 0, 2210, 'M')
    expect(changedNote(e, { mint: 'M', holders: 2198 })).toBe('Then 2,210 holders, now 2,198.')
    expect(changedNote(e, { mint: 'M', holders: 2210 })).toBeNull()
  })
  test('it says nothing about a line it cannot check: another coin, no count, no reading', () => {
    const e = said('x', 0, 2210, 'M')
    expect(changedNote(e, { mint: 'OTHER', holders: 5 })).toBeNull()
    expect(changedNote(e, { mint: 'M', holders: null })).toBeNull()
    expect(changedNote(e, null)).toBeNull()
    expect(changedNote(said('Round 7 paid 46 wallets.', 0), { mint: 'M', holders: 5 })).toBeNull()
  })
})
