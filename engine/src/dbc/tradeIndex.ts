// The trades tape fills itself from the chain. A sweep in the API process lists each board coin's pool signatures (the curve, and the DAMM v2 pool once it
// has migrated) and records every trade it has not looked at yet through recordTradeFromTx, the same reader the browser's trade-confirm uses. Written
// 2026-10-12: on mainnet most trades of the first coins came through terminals and aggregators, never through the site, so the tape, the 24h volume and
// the trade counts stayed at the few trades the site itself confirmed. Read-only; no key is loaded. Its limits are the reader's (dbc/trade.ts tradeFromTx): a transaction
// that names the pool and moves ZEC into its vault and the coin out (or the reverse) counts as a trade; one that moves both the same way (liquidity added or removed) does not.
//
// Bookkeeping per pool, in the meta table: `trade_cursor:<pool>` is the newest signature such that it and everything older has been looked at. A round
// lists what is newer than the cursor (newest first, as the RPC gives it), records oldest first within a cap of transactions shared fairly by the round's
// pools, and moves the cursor to the last one looked at, so a backlog continues where it stopped on the next round and no trade is skipped. A pool with nothing new is
// looked at less often (the wait doubles, up to ten minutes) so an idle pad costs a few RPC calls an hour; a pool with trades is looked at every round.
import { PublicKey } from "@solana/web3.js";
import * as db from "../db";
import type { CoinRow } from "../db";
import { getConnection } from "../solana";
import { isChainUnavailable } from "../rpcGuard";
import { TradeError, recordTradeFromTx } from "./trade";
import { isHidden } from "./visible";

export interface SignatureInfo {
  signature: string;
  err: unknown;
}
export interface SignatureQuery {
  until?: string;
  before?: string;
  limit: number;
}
/** How the sweep looks at the chain, replaceable in tests: a pool's signatures newest first, and the trade reader. */
export interface TradeIndexLook {
  signatures: (address: string, q: SignatureQuery) => Promise<SignatureInfo[]>;
  record: (sig: string, mint: string) => Promise<unknown>;
}
const chainLook: TradeIndexLook = {
  signatures: (address, q) => getConnection().getSignaturesForAddress(new PublicKey(address), q, "confirmed"),
  record: recordTradeFromTx,
};

export const TRADE_INDEX_EVERY_MS = 60_000;
/** Signatures per listing call (the RPC's maximum) and listing calls per pool per round: past that the oldest of the backlog are skipped, and logged. */
export const TRADE_INDEX_PAGE = 1_000;
export const TRADE_INDEX_MAX_PAGES = 5;
/** Transactions read per round, over every pool (`PAD_TRADE_INDEX_MAX_TX_PER_ROUND`): two a second at the round's pace, under the API's RPC pacing. */
export const TRADE_INDEX_MAX_TX_PER_ROUND = envNumber("PAD_TRADE_INDEX_MAX_TX_PER_ROUND", 120);
export const TRADE_INDEX_IDLE_MAX_MS = 10 * 60_000;

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const tradeCursorKey = (pool: string): string => `trade_cursor:${pool}`;

/** Every signature on `address` newer than `cursor`, newest first; `reached` is false when the cursor (or the pool's start) was not within the pages read. */
async function newerThan(look: TradeIndexLook, address: string, cursor: string | null): Promise<{ sigs: SignatureInfo[]; reached: boolean }> {
  const sigs: SignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < TRADE_INDEX_MAX_PAGES; page++) {
    const got = await look.signatures(address, { until: cursor ?? undefined, before, limit: TRADE_INDEX_PAGE });
    sigs.push(...got);
    if (got.length < TRADE_INDEX_PAGE) return { sigs, reached: true };
    before = got[got.length - 1]!.signature;
  }
  return { sigs, reached: false };
}

export interface PoolIndexResult {
  /** Signatures newer than the cursor the listing returned (failed ones included). */
  listed: number;
  /** Transactions read. */
  looked: number;
  recorded: number;
  /** True when every listed signature was looked at; false when the round's cap stopped it. */
  caughtUp: boolean;
}

/** A reader's refusal that is not a trade: the transaction touched the pool without moving the coin (a migration, a claim), or the node no longer has it. */
const notATrade = (err: unknown): boolean => err instanceof TradeError && (err.code === "not_a_trade" || err.code === "tx_not_found");

/** Records one pool's trades newer than its cursor, oldest first, reading at most `budget` transactions; the cursor moves to the last one looked at. */
export async function indexPool(look: TradeIndexLook, coin: CoinRow, pool: string, budget: number): Promise<PoolIndexResult> {
  const key = tradeCursorKey(pool);
  const { sigs, reached } = await newerThan(look, pool, db.getMeta(key));
  if (!reached) console.error(`[trades] ${coin.symbol} pool ${pool}: over ${TRADE_INDEX_PAGE * TRADE_INDEX_MAX_PAGES} signatures since the last look; the oldest are skipped`);
  const oldestFirst = sigs.reverse();
  let looked = 0;
  let recorded = 0;
  let done: string | null = null;
  for (const s of oldestFirst) {
    if (!s.err) {
      if (looked >= budget) break;
      looked++;
      try {
        await look.record(s.signature, coin.mint);
        recorded++;
      } catch (err) {
        if (isChainUnavailable(err)) {
          if (done) db.setMeta(key, done);
          throw err;
        }
        if (!notATrade(err)) console.error(`[trades] ${coin.symbol} ${s.signature}: ${(err as Error)?.message ?? err}`);
      }
    }
    done = s.signature;
  }
  if (done) db.setMeta(key, done);
  const last = oldestFirst.length ? oldestFirst[oldestFirst.length - 1]!.signature : null;
  return { listed: sigs.length, looked, recorded, caughtUp: done === last };
}

/** Pools with nothing new, and when they are next looked at. */
const idle = new Map<string, { until: number; wait: number }>();

function noteIdle(pool: string, listed: number, now: number): void {
  if (listed > 0) {
    idle.delete(pool);
    return;
  }
  const wait = Math.min((idle.get(pool)?.wait ?? TRADE_INDEX_EVERY_MS) * 2, TRADE_INDEX_IDLE_MAX_MS);
  idle.set(pool, { until: now + wait, wait });
}

export interface IndexRoundResult {
  looked: number;
  recorded: number;
  /** "SYMBOL n" for every pool that recorded something, for the log. */
  lines: string[];
}

/** The pools a round looks at, in board order: each launched, visible coin's curve pool and, once migrated, its DAMM v2 pool. */
function poolsToIndex(now: number): { coin: CoinRow; pool: string }[] {
  const out: { coin: CoinRow; pool: string }[] = [];
  for (const coin of db.listCoins()) {
    if (coin.status !== "launched" || !coin.poolId || isHidden(coin.mint)) continue;
    for (const pool of coin.dammPool ? [coin.poolId, coin.dammPool] : [coin.poolId]) {
      if ((idle.get(pool)?.until ?? 0) <= now) out.push({ coin, pool });
    }
  }
  return out;
}

/**
 * One round over every launched coin on the board (hidden coins are left out): its curve pool and, once migrated, its DAMM v2 pool. The round's
 * transaction budget is shared fairly: a first pass gives each pool an equal share of what is left (so one pool with a long backlog cannot use the
 * whole round and leave the pools after it unread, which it did before 2026-10-12), then a second pass hands what the first left over to the pools
 * the first pass capped, in order. A chain outage ends the round (the cursors already moved stay); any other failure on one pool is logged and the
 * next pool is looked at.
 */
export async function indexTrades(look: TradeIndexLook = chainLook, opts: { now?: number; budget?: number } = {}): Promise<IndexRoundResult> {
  const now = opts.now ?? Date.now();
  let budget = opts.budget ?? TRADE_INDEX_MAX_TX_PER_ROUND;
  const out: IndexRoundResult = { looked: 0, recorded: 0, lines: [] };
  const pools = poolsToIndex(now);
  const capped: { coin: CoinRow; pool: string }[] = [];
  const sweep = async (coin: CoinRow, pool: string, quota: number, pass: 1 | 2): Promise<void> => {
    try {
      const r = await indexPool(look, coin, pool, quota);
      budget -= r.looked;
      out.looked += r.looked;
      out.recorded += r.recorded;
      if (r.recorded) out.lines.push(`${coin.symbol} ${r.recorded}`);
      if (pass === 1) noteIdle(pool, r.listed, now);
      if (!r.caughtUp && pass === 1) capped.push({ coin, pool });
    } catch (err) {
      if (isChainUnavailable(err)) throw err;
      console.error(`[trades] ${coin.symbol} pool ${pool} not indexed: ${(err as Error)?.message ?? err}`);
    }
  };
  for (let i = 0; i < pools.length && budget > 0; i++) await sweep(pools[i]!.coin, pools[i]!.pool, Math.ceil(budget / (pools.length - i)), 1);
  for (const { coin, pool } of capped) {
    if (budget <= 0) break;
    await sweep(coin, pool, budget, 2);
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the sweep in the API process: a first round a few seconds after start, then one a minute. A failed round is a log line; the next one tries again. */
export function startTradeIndexer(): void {
  if (timer) return;
  // Off switch for an instance (`PAD_TRADE_INDEX=0`). Off under `bun test` too (Bun sets NODE_ENV=test): several test files start the API server, and the
  // sweep would record the real first buys of coins whose tapes the tests fill by hand, changing the counts they check.
  if (process.env.PAD_TRADE_INDEX === "0" || process.env.NODE_ENV === "test") return;
  const round = () =>
    indexTrades().then(
      (r) => { if (r.recorded) console.log(`[trades] recorded ${r.recorded} of ${r.looked} transactions read (${r.lines.join(", ")})`); },
      (err) => console.error(`[trades] round failed: ${(err as Error)?.message ?? err}`),
    );
  setTimeout(round, 5_000).unref?.();
  timer = setInterval(round, TRADE_INDEX_EVERY_MS);
  timer.unref?.();
}
