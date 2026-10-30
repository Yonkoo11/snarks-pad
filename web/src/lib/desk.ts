// The ledger view's per-row reads: pot, holder aggregates and the last trades for the rows on
// screen, fetched lazily (never for the whole list), a few at a time, and kept for a minute.
// The engine serves all three from its own cache or keeper sample, so a page of rows costs
// cheap reads, not chain reads.
import { api } from './api'
import type { FeedTrade } from './types'

export interface RowExtras {
  // from /coins/:mint/holders (aggregates; one row asked for)
  top10Pct: number | null
  devPct: number | null
  poolPct: number | null
  holdersCount: number | null
  // from /coins/:mint/pot
  holdersPotZats: string | null // what the next round pays this coin's holders, if it closed now
  // from /coins/:mint/trades, oldest first
  trades: FeedTrade[] | null
}

const TTL = 60_000
const LIMIT = 4 // concurrent fetches; a page of rows queues behind these
const TRADES = 40

const cache = new Map<string, { at: number; p: Promise<RowExtras> }>()

let running = 0
const queue: (() => void)[] = []
function slot(): Promise<void> {
  if (running < LIMIT) { running++; return Promise.resolve() }
  return new Promise((res) => queue.push(res))
}
function release(): void {
  const next = queue.shift()
  if (next) next()
  else running--
}

async function fetchExtras(mint: string): Promise<RowExtras> {
  await slot()
  try {
    const [hold, pot, trades] = await Promise.all([
      api.holders(mint, { limit: 1 }).catch(() => null),
      api.pot(mint).catch(() => null),
      api.trades({ mint, limit: TRADES }).then((r) => [...r.trades].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), () => null),
    ])
    return {
      top10Pct: hold?.top10Pct ?? null,
      devPct: hold?.devPct ?? null,
      poolPct: hold?.poolPct ?? null,
      holdersCount: hold?.holdersCount ?? null,
      holdersPotZats: pot?.holdersZats ?? null,
      trades,
    }
  } finally {
    release()
  }
}

/** The row's extras, cached for a minute. Never rejects: absent pieces come back null and the cell shows the en dash. */
export function rowExtras(mint: string): Promise<RowExtras> {
  const hit = cache.get(mint)
  if (hit && Date.now() - hit.at < TTL) return hit.p
  const p = fetchExtras(mint)
  cache.set(mint, { at: Date.now(), p })
  return p
}
