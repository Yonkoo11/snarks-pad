// The since-you-looked store: one snapshot per coin in THIS browser (holders, price, paid total),
// written when a page shows the coin, read to say what moved since. It is per-viewer by definition
// and every surface that uses it says so. Storage can be absent (private window, cleared site data):
// every read and write is guarded, and the page renders with no deltas when it is.
import type { Coin } from './types'

const KEY = 'snarks-looked' // { [mint]: Looked }
const WATCH_KEY = 'snarks-watch' // { [mint]: Looked } - the snapshot taken when the star went on

export interface Looked {
  holders: number | null
  priceZec: string | null
  paidZats: string // solana + shielded, zats
  at: number // ms epoch of the look
}

function read(key: string): Record<string, Looked> {
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' ? (v as Record<string, Looked>) : {}
  } catch {
    return {}
  }
}
function write(key: string, map: Record<string, Looked>): void {
  try { localStorage.setItem(key, JSON.stringify(map)) } catch { /* no storage, no deltas */ }
}

export function snapOf(c: Coin, now = Date.now()): Looked {
  const paid = BigInt(c.rewards.paidSolanaZec || '0') + BigInt(c.rewards.paidShieldedZec || '0')
  return { holders: c.holders ?? null, priceZec: c.priceZec ?? null, paidZats: paid.toString(), at: now }
}

/** The snapshot this browser last took of the coin, or null when it never looked (or storage is gone). */
export function lastLook(mint: string): Looked | null {
  return read(KEY)[mint] ?? null
}

/** Record the look. Call it when a page has actually shown the coin's numbers. */
export function recordLook(mint: string, snap: Looked): void {
  const map = read(KEY)
  map[mint] = snap
  write(KEY, map)
}

/** What moved between two looks, as short printable parts; [] when nothing moved or there is nothing to compare. */
export function lookDelta(before: Looked | null, nowSnap: Looked): string[] {
  if (!before) return []
  const parts: string[] = []
  if (before.holders != null && nowSnap.holders != null && nowSnap.holders !== before.holders) {
    const d = nowSnap.holders - before.holders
    parts.push(`${d > 0 ? '+' : ''}${d} holders`)
  }
  const paidD = BigInt(nowSnap.paidZats) - BigInt(before.paidZats)
  if (paidD > 0n) parts.push(`+${zecShort(paidD)} ZEC paid`)
  return parts
}

function zecShort(zats: bigint): string {
  const whole = zats / 100_000_000n
  const frac = ((zats % 100_000_000n) / 10_000n).toString().padStart(4, '0').replace(/0+$/, '')
  return `${whole}${frac ? '.' + frac : ''}`
}

// ---- the watchlist: a star stores the snapshot it was pressed on, so every watched row can say
// what changed since the star, with no server work.

export function watched(): Record<string, Looked> {
  return read(WATCH_KEY)
}
export function isWatched(mint: string): boolean {
  return mint in read(WATCH_KEY)
}
/** Toggle the star. Returns the new state. Starring stores the moment's snapshot. */
export function toggleWatch(mint: string, snap: Looked): boolean {
  const map = read(WATCH_KEY)
  const on = !(mint in map)
  if (on) map[mint] = snap
  else delete map[mint]
  write(WATCH_KEY, map)
  // anything showing the followed coins (the tape's Following chip) re-reads
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('snarks-watch'))
  return on
}
