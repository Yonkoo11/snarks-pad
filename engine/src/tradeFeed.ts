// The trades tape docs/API.md v2.6, "Trades: the tape"): recent recorded trades as JSON, and a Server-Sent Events stream that
// pushes each newly recorded trade. Only trades the engine has RECORDED are in either (a browser's trade-confirm, or the seed
// scripts), the rows behind volume24hZats. Read-only; nothing here touches the chain or a key.
//
// The stream does not depend on who wrote the row. One hub polls the trades table by arrival number (the table's rowid) at most once a
// second, and only while someone is listening, so a trade recorded by this process or by another one on the same database reaches every
// stream, and the cost does not grow with the number of streams. A trade-confirm in this process also pokes the hub so its own
// trade shows at once.
import * as db from "./db";
import { isHidden } from "./dbc/visible";
import type { FeedTradeRow } from "./db";

export const FEED_DEFAULT_LIMIT = 30;
export const FEED_MAX_LIMIT = 100;
/** How many missed trades a reconnecting stream is given back. */
export const REPLAY_MAX = 50;
/** The hub looks for new trades this often while anyone listens. */
export const HUB_POLL_MS = 1_000;
export const HEARTBEAT_MS = 15_000;
/** A stream is closed after this long; EventSource reconnects by itself (with Last-Event-ID, so nothing is lost). */
export const STREAM_MAX_LIFETIME_MS = 15 * 60_000;
/** A client that has this many events queued and unread is dropped (it is not reading). */
export const MAX_QUEUED_EVENTS = 200;
/**
 * How long a client whose queue is over MAX_QUEUED_EVENTS gets to drain it before it is dropped. A burst of trades in one poll queues more than a
 * reading client can have taken yet (S4 stress ST-SSE-05: a 2,000-trade burst dropped every listener, reading or not, at the 201st event).
 */
export const DROP_GRACE_MS = 1_000;
export const MAX_STREAMS_PER_IP = 4;
export const MAX_STREAMS_TOTAL = 400;

export interface FeedTrade {
  sig: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  wallet: string;
  amountToken: string;
  amountZec: string;
  at: string;
  tags: "dev"[];
}

export function toFeedTrade(r: FeedTradeRow): FeedTrade {
  return {
    sig: r.sig, mint: r.mint, symbol: r.symbol, side: r.side, wallet: r.wallet, amountToken: r.amountToken, amountZec: r.amountZec, at: r.at,
    tags: r.wallet === r.creator ? ["dev"] : [],
  };
}

/** The newest recorded trades of the coins in `mints` (null = every launched coin), newest first. */
export function recentTrades(limit: number, mints: string[] | null): FeedTrade[] {
  return db.listRecentFeedTrades(limit, mints).map(toFeedTrade);
}

export function recentTradesOfCoin(mint: string, limit: number): FeedTrade[] {
  return db.listFeedTradesForMint(mint, limit).map(toFeedTrade);
}

interface Subscriber {
  /** null = every coin. */
  mints: Set<string> | null;
  /** The highest arrival number this subscriber has been given or has no need of. */
  cursor: number;
  send: (n: number, trade: FeedTrade) => void;
}

export interface TradeHub {
  /** Starts a subscription; `lastEventId` (an arrival number the client last saw) replays what it missed. Returns the way to end it. */
  subscribe(mints: Set<string> | null, send: (n: number, trade: FeedTrade) => void, lastEventId: number | null): { close(): void };
  /** Looks for new trades now (a trade was just recorded in this process). */
  poke(): void;
  listeners(): number;
}

export function makeTradeHub(pollMs: number = HUB_POLL_MS): TradeHub {
  const subs = new Set<Subscriber>();
  let lastN = -1; // -1 = not read yet
  let timer: ReturnType<typeof setInterval> | null = null;

  function drop(sub: Subscriber): void {
    subs.delete(sub);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function tick(): void {
    if (lastN < 0) lastN = db.maxTradeArrival();
    for (;;) {
      const rows = db.listFeedTradesAfter(lastN, 200, null);
      for (const r of rows) {
        lastN = r.n;
        const trade = toFeedTrade(r);
        for (const s of [...subs]) {
          if (r.n <= s.cursor || (s.mints && !s.mints.has(r.mint)) || isHidden(r.mint)) continue; // hidden: read at send time, so a change applies to open streams
          s.cursor = r.n;
          try {
            s.send(r.n, trade);
          } catch {
            drop(s); // a listener that cannot be written to is gone; the others still hear this trade
          }
        }
      }
      if (rows.length < 200) return;
    }
  }

  return {
    subscribe(mints, send, lastEventId) {
      tick(); // lastN is current before this subscriber's cursor is taken: it hears only what is recorded after this, plus what it asked to have replayed
      const sub: Subscriber = { mints, cursor: lastN, send };
      if (lastEventId !== null && lastEventId < lastN) {
        for (const r of db.listFeedTradesBetween(lastEventId, lastN, REPLAY_MAX, mints ? [...mints] : null)) send(r.n, toFeedTrade(r));
      }
      subs.add(sub);
      if (!timer) {
        timer = setInterval(tick, pollMs);
        (timer as { unref?: () => void }).unref?.();
      }
      return { close: () => drop(sub) };
    },
    poke() {
      if (subs.size > 0) tick();
    },
    listeners: () => subs.size,
  };
}

export const tradeHub = makeTradeHub();

/** At most `perIp` open streams per client address and `total` in all. acquire() returns the way to give the slot back, or null when there is none. */
export function makeStreamLimiter(perIp: number = MAX_STREAMS_PER_IP, total: number = MAX_STREAMS_TOTAL) {
  const byIp = new Map<string, number>();
  let open = 0;
  return {
    acquire(ip: string | null): (() => void) | null {
      const key = ip ?? "unknown";
      if (open >= total || (byIp.get(key) ?? 0) >= perIp) return null;
      open++;
      byIp.set(key, (byIp.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        open--;
        const left = (byIp.get(key) ?? 1) - 1;
        if (left <= 0) byIp.delete(key);
        else byIp.set(key, left);
      };
    },
    open: () => open,
  };
}

export const streamLimiter = makeStreamLimiter();

/** An arrival number from a `Last-Event-ID` header: a plain decimal integer, else null (ignored). */
export function parseLastEventId(header: string | null): number | null {
  if (header === null || !/^[0-9]{1,15}$/.test(header)) return null;
  return Number(header);
}

export interface StreamOptions {
  hub: TradeHub;
  mints: Set<string> | null;
  lastEventId: number | null;
  /** Called once, when the stream ends for any reason: gives back the connection slot. */
  onClose: () => void;
  heartbeatMs?: number;
  maxLifetimeMs?: number;
  maxQueued?: number;
  dropGraceMs?: number;
}

/** The body of GET /events/trades: `retry`, the replayed trades, then one `trade` event per new trade and a comment every heartbeat. */
export function tradeEventStream(o: StreamOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const maxQueued = o.maxQueued ?? MAX_QUEUED_EVENTS;
  let end: () => void = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let sub: { close(): void } | null = null;
      let drop: ReturnType<typeof setTimeout> | null = null;
      const write = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          end();
          return;
        }
        // Over the limit: not dropped inside the burst that got it there (a reading client has had no turn to drain yet), but a moment later if it still is.
        if ((controller.desiredSize ?? 0) < -maxQueued && !drop) {
          drop = setTimeout(() => {
            drop = null;
            if ((controller.desiredSize ?? 0) < -maxQueued) end();
          }, o.dropGraceMs ?? DROP_GRACE_MS);
          (drop as { unref?: () => void }).unref?.();
        }
      };
      const beat = setInterval(() => write(": keep-alive\n\n"), o.heartbeatMs ?? HEARTBEAT_MS);
      const life = setTimeout(() => end(), o.maxLifetimeMs ?? STREAM_MAX_LIFETIME_MS);
      (beat as { unref?: () => void }).unref?.();
      (life as { unref?: () => void }).unref?.();
      end = () => {
        if (closed) return;
        closed = true;
        sub?.close();
        clearInterval(beat);
        clearTimeout(life);
        if (drop) clearTimeout(drop);
        try {
          controller.close();
        } catch {
          /* the client already closed it */
        }
        o.onClose();
      };
      write("retry: 3000\n\n");
      sub = o.hub.subscribe(o.mints, (n, trade) => write(`id: ${n}\nevent: trade\ndata: ${JSON.stringify(trade)}\n\n`), o.lastEventId);
      if (closed) sub.close(); // the replay itself failed to write: the subscription made after that must not outlive the stream
    },
    cancel() {
      end();
    },
  });
}
