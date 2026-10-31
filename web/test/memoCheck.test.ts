import { describe, expect, test } from 'bun:test'
import { memoVerdict, readMemo, snapshotMemoText } from '../src/lib/memoCheck'

const H = 'ab'.repeat(32)
const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
const tx = (parsed: unknown, err: unknown = null) => ({ result: { meta: { err }, transaction: { message: { instructions: [{ program: 'system' }, { program: 'spl-memo', parsed }] } } } })

describe('memo check', () => {
  test('the memo text is the one the engine writes', () => {
    expect(snapshotMemoText('epoch-1', H)).toBe(`snarks-pad snapshot epoch-1 sha256:${H}`)
  })
  test('a memo with the same epoch and hash matches, any other does not', () => {
    expect(memoVerdict({ kind: 'memo', text: snapshotMemoText('e1', H) }, 'e1', H)).toBe('match')
    expect(memoVerdict({ kind: 'memo', text: snapshotMemoText('e1', H) }, 'e2', H)).toBe('mismatch')
    expect(memoVerdict({ kind: 'memo', text: snapshotMemoText('e1', 'cd'.repeat(32)) }, 'e1', H)).toBe('mismatch')
  })
  test('an RPC that does not answer is unreadable, never a mismatch', async () => {
    expect(await readMemo('x', 's', (async () => { throw new Error('down') }) as unknown as typeof fetch)).toEqual({ kind: 'unreadable' })
    expect(await readMemo('x', 's', reply({}, false))).toEqual({ kind: 'unreadable' })
    expect(await readMemo('x', 's', reply({ error: { code: -32005 } }))).toEqual({ kind: 'unreadable' })
  })
  test('a missing or failed transaction, or one without a memo, is none', async () => {
    expect(await readMemo('x', 's', reply({ result: null }))).toEqual({ kind: 'none' })
    expect(await readMemo('x', 's', reply(tx('hi', { InstructionError: [0, 'x'] })))).toEqual({ kind: 'none' })
    expect(await readMemo('x', 's', reply({ result: { meta: { err: null }, transaction: { message: { instructions: [{ program: 'system' }] } } } }))).toEqual({ kind: 'none' })
  })
  test('the memo instruction text is read', async () => {
    expect(await readMemo('x', 's', reply(tx('hello')))).toEqual({ kind: 'memo', text: 'hello' })
  })
})
