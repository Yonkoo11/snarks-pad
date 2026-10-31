// What Snarks has said, kept for the visitor to read back: the last ten lines it spoke on its own, each with its time and, where the number it
// quoted can be checked again, what that number is now. It is the mascot held to "don't trust us, check": a line it said is never quietly
// replaced; the shelf shows it as said and says what changed. Per browser; nothing is sent. Pure functions here, so a test can read them.
export interface Said { at: number; text: string; mint: string | null; holders: number | null }
export const MAX_SAID = 10
const KEY = 'snarks-pal-log'

/** The log with a new line first, the same line within a minute not repeated, at most ten kept. */
export function remember(log: Said[], entry: Said): Said[] {
  if (log.some((x) => x.text === entry.text && Math.abs(entry.at - x.at) < 60_000)) return log
  return [entry, ...log].slice(0, MAX_SAID)
}

/** What changed since a line was said: only for a line that quoted a holder count of a coin, and only when the count is different now. */
export function changedNote(entry: Said, current: { mint: string | null; holders: number | null | undefined } | null): string | null {
  if (!current || entry.holders === null || entry.mint === null || entry.mint !== current.mint) return null
  if (current.holders === null || current.holders === undefined || current.holders === entry.holders) return null
  return `Then ${entry.holders.toLocaleString('en-US')} holders, now ${current.holders.toLocaleString('en-US')}.`
}

export function readLog(): Said[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is Said => x && typeof x.text === 'string' && typeof x.at === 'number').slice(0, MAX_SAID) : []
  } catch { return [] }
}
export function writeLog(log: Said[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(log)) } catch { /* private window: the shelf lasts this visit */ }
}
