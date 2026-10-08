// One live trades feed for the home tape and the coin page: the newest rows from GET /trades (or GET /coins/:mint/trades),
// then new rows from the SSE stream GET /events/trades when the engine has one, else a poll on the same cadence as the
// page. The browser's EventSource reconnects by itself (the server sends `retry: 3000` and replays what was missed from
// Last-Event-ID); only a stream that closes for good falls back to polling (contract v2.6). An engine without /trades
// (v2.5) answers 404 and the feed says `absent`, so the caller hides the tape or falls back to what it already has.
import { api, routeAbsent } from './api'
import { poll } from './poll'
import type { FeedTrade } from './types'

export type FeedState = 'loading' | 'live' | 'polling' | 'lost' | 'absent'

export interface FeedOptions {
  mint?: string
  limit: number
  everyMs: number
  onRows: (rows: FeedTrade[]) => void
  onState: (s: FeedState) => void
}

/** Starts the feed; returns the stop function (`$effect(() => tradeFeed(...))` cleans up on its own). */
export function tradeFeed(o: FeedOptions): () => void {
  let rows: FeedTrade[] = []
  let stopPoll: (() => void) | null = null
  let es: EventSource | null = null
  let stopped = false
  const emit = () => o.onRows(rows.slice(0, o.limit))
  const merge = (fresh: FeedTrade[]) => {
    const seen = new Set(rows.map((r) => r.sig))
    const add = fresh.filter((r) => !seen.has(r.sig))
    if (add.length === 0) return
    rows = [...add, ...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, o.limit)
    emit()
  }
  async function read(): Promise<boolean> {
    try {
      const r = await api.trades({ limit: o.limit, mint: o.mint })
      if (stopped) return false
      merge(r.trades)
      return true
    } catch (e) {
      if (stopped) return false
      if (routeAbsent(e)) { o.onState('absent'); stop(); return false }
      o.onState('lost')
      return false
    }
  }
  function startPolling() {
    if (stopPoll || stopped) return
    o.onState('polling')
    stopPoll = poll(async () => { if (await read()) o.onState('polling') }, o.everyMs)
  }
  function startStream(url: string) {
    es = new EventSource(url)
    es.addEventListener('trade', (ev) => {
      try { merge([JSON.parse((ev as MessageEvent).data) as FeedTrade]); o.onState('live') } catch { /* a row the feed cannot read is skipped */ }
    })
    es.onopen = () => o.onState('live')
    es.onerror = () => {
      // CLOSED = the browser gave up (the route refused, or too many streams): poll from here on. CONNECTING = a reconnect is under way; catch up once.
      if (!es || es.readyState === EventSource.CLOSED) { es?.close(); es = null; startPolling() } else read()
    }
  }
  function stop() { stopped = true; stopPoll?.(); stopPoll = null; es?.close(); es = null }

  o.onState('loading')
  read().then((ok) => {
    if (stopped || !ok) return
    const url = api.tradeStreamUrl(o.mint)
    if (url && typeof EventSource === 'function') { o.onState('live'); startStream(url) } else startPolling()
  })
  return stop
}
