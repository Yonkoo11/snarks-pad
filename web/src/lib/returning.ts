// Coming back: if the visitor has been away for a while and had a coin open when they left, Snarks can say what moved on it since. The baseline
// is read when the app starts, before any page records a fresh look over it. Per browser; nothing is sent anywhere.
import { lastLook, type Looked } from './looked'

const COIN = 'snarks-last-coin'
const SESSION = 'snarks-session-at'
export const AWAY_MS = 30 * 60_000

export interface Returning { mint: string; at: number; base: Looked }

/** Whether a gap since the last visit counts as having been away. Pure. */
export const wasAway = (lastSeen: number | null, now: number, gap = AWAY_MS): boolean => lastSeen !== null && Number.isFinite(lastSeen) && lastSeen > 0 && now - lastSeen >= gap

function read(): Returning | null {
  try {
    const now = Date.now()
    const seen = Number(localStorage.getItem(SESSION)) || null
    localStorage.setItem(SESSION, String(now))
    if (!wasAway(seen, now)) return null
    const c = JSON.parse(localStorage.getItem(COIN) ?? 'null') as { mint?: unknown; at?: unknown } | null
    if (!c || typeof c.mint !== 'string' || typeof c.at !== 'number') return null
    const base = lastLook(c.mint)
    return base ? { mint: c.mint, at: c.at, base } : null
  } catch { return null }
}
/** Read once, at import: before any page has recorded a new look. */
export const returning: Returning | null = read()

/** The coin page notes which coin is open, so the next visit can say what moved on it. */
export function rememberCoin(mint: string): void {
  try { localStorage.setItem(COIN, JSON.stringify({ mint, at: Date.now() })) } catch { /* private window: nothing to come back to */ }
}
/** Keeps "last seen" fresh while the tab is in use. */
export function touchSession(): void {
  try { localStorage.setItem(SESSION, String(Date.now())) } catch { /* private window */ }
}
