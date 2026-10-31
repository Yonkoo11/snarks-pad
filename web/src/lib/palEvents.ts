// What is worth Snarks' notice, read off records the pad already holds. Pure, so a test can read it. Nothing is guessed: each detector
// compares two readings and says nothing when it has only one.
import type { Coin, Epoch, FeedTrade } from './types'

/** A round newer than the last one seen. The first reading only sets the mark. */
export function newRound(seenId: string | null, epochs: Epoch[]): { id: string; n: number; paid: number } | null {
  const e = epochs[0]
  if (!e || seenId === null || e.id === seenId) return null
  return { id: e.id, n: epochs.length, paid: e.solanaPayouts.count + e.shielded.count }
}

/** Coins that graduated after `since` (ms) and were not announced yet. */
export function newGraduations(coins: Coin[], since: number, announced: ReadonlySet<string>): Coin[] {
  return coins.filter((c) => c.graduatedAt && Date.parse(c.graduatedAt) > since && !announced.has(c.mint))
}

/** Holders gained on a followed coin since the last time it was announced; null when nothing grew or a count is missing. */
export function holdersGained(before: number | null, now: number | null | undefined): number | null {
  if (before === null || now === null || now === undefined) return null
  return now > before ? now - before : null
}

/** The newest sell by the coin's creator after `sinceMs`, if any. */
export function creatorSell(trades: FeedTrade[], sinceMs: number): FeedTrade | null {
  return trades.filter((t) => t.side === 'sell' && t.tags.includes('dev') && Date.parse(t.at) > sinceMs).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
}
