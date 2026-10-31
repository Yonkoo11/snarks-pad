// Where you were: a drill into a coin remembers the ledger's scroll position and the row you left, so coming back lands on the
// same row and the row says what moved while you were away. Held for this tab only, and only for a short while.
const KEY = 'snarks-spot'
const FRESH_MS = 30 * 60_000

export interface Spot { mint: string; scrollY: number; at: number }

export function leaveSpot(mint: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ mint, scrollY: window.scrollY, at: Date.now() } satisfies Spot)) } catch { /* private window: the ledger opens at the top */ }
}

/** The spot to return to, once. */
export function takeSpot(): Spot | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Spot
    return typeof s.mint === 'string' && typeof s.at === 'number' && Date.now() - s.at < FRESH_MS ? s : null
  } catch { return null }
}
