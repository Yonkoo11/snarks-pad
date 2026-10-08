// The holders behind GET /api/coins/:mint/holders docs/API.md v2.6: the wallets that hold a coin, largest first, with the time
// their balances were taken. Balances are never read inside a request. Two sources, the newer one wins:
//   1. the keeper's newest holder sample (src/epoch/snapshots.ts): the eligible holders at a random moment inside the epoch window, so
//      it can be hours old;
//   2. an on-chain read (a getProgramAccounts over the coin's token accounts, the same eligibility rules as an epoch) that the API
//      starts in the background at most once per HOLDER_BOOK_TTL_MS per coin while the route is being asked, the last result served
//      meanwhile. Only the very first request for a coin that has neither waits for it.
// A book keeps the BOOK_ROWS largest wallets (with their balances), the exact count of all of them, and the creator's balance, which is
// taken from the whole list.
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import * as db from "../db";
import { recordedExcludedOwners, snapshotHolders } from "../holders";
import { isChainUnavailable } from "../rpcGuard";
import { HOLDER_COUNT_TTL_MS } from "./holderCount";

/** An on-chain read is started at most this often per coin: the holder count's wait (PAD_HOLDER_COUNT_TTL_MS, 60 s unless set), since both are one getProgramAccounts per coin. */
export const HOLDER_BOOK_TTL_MS = HOLDER_COUNT_TTL_MS;
/** A failed read is tried again after this, not at once and not after a whole window. */
export const HOLDER_BOOK_RETRY_MS = 5_000;
/** How long a database lookup (and the parse of a large sample) is reused. */
export const HOLDER_BOOK_SAMPLE_REUSE_MS = 30_000;
/** On-chain reads the books have started in the background at the same moment, all coins together. */
export const MAX_BOOK_READS = 4;
/** How many of the largest wallets a book keeps. */
export const BOOK_ROWS = 1_000;

export interface BookRow {
  wallet: string;
  balance: bigint;
}

export interface HolderBook {
  /** When the balances were taken (ISO): the sample's time, or when the on-chain read finished. */
  asOf: string;
  source: "keeper_sample" | "chain";
  /** Every eligible wallet, not only the kept ones. */
  count: number;
  /** The BOOK_ROWS largest, biggest first (ties by wallet). */
  rows: BookRow[];
  /** The creator's balance among the eligible holders (0 when it holds none), from the whole list. */
  creatorBalance: bigint;
}

/** Biggest first, ties by wallet so the order is total. */
const bigger = (a: BookRow, b: BookRow): number => (a.balance === b.balance ? (a.wallet < b.wallet ? -1 : 1) : a.balance > b.balance ? -1 : 1);

export function makeBook(all: BookRow[], asOf: string, source: HolderBook["source"], creator: string | null): HolderBook {
  const creatorBalance = all.reduce((sum, r) => (r.wallet === creator ? sum + r.balance : sum), 0n);
  return { asOf, source, count: all.length, rows: [...all].sort(bigger).slice(0, BOOK_ROWS), creatorBalance };
}

export interface HolderBooksDeps {
  /** The keeper's newest holder sample of a coin, null when it has none. */
  sample: (mint: string) => { takenAt: string; holders: BookRow[] } | null;
  /** Every eligible holder of a coin, read from the chain. */
  read: (mint: string) => Promise<BookRow[]>;
  /** The creator the pad recorded for a coin. */
  creatorOf: (mint: string) => string | null;
  now?: () => number;
}

export interface HolderBooks {
  /** What is known right now, never waiting; null when there is neither a sample nor a finished read (a read is started). */
  known(mint: string): HolderBook | null;
  /** known(), but waits for the first on-chain read when there is nothing yet. Rejects when that read fails. */
  get(mint: string): Promise<HolderBook>;
}

interface ChainEntry {
  /** End of the window: no new read starts before it; a failed read cuts it to HOLDER_BOOK_RETRY_MS. */
  freshUntilMs: number;
  read: Promise<HolderBook>;
  pending: boolean;
  /** The newest book read successfully: this read's once it lands, the previous one's until then. */
  book: HolderBook | null;
}

export function makeHolderBooks(deps: HolderBooksDeps): HolderBooks {
  const now = deps.now ?? Date.now;
  const chainEntries = new Map<string, ChainEntry>();
  const sampleEntries = new Map<string, { untilMs: number; book: HolderBook | null }>();

  /** Inside its window; a clock that moved backwards past the window's whole length counts as outside it. */
  const inWindow = (untilMs: number, windowMs: number): boolean => now() < untilMs && untilMs - now() <= windowMs;
  /** Reads in flight. One still open after its window is taken as hung and stops counting, so a few hung reads cannot starve the others for good. */
  const reading = (): number => [...chainEntries.values()].filter((e) => e.pending && inWindow(e.freshUntilMs, HOLDER_BOOK_TTL_MS)).length;

  function sampleBook(mint: string): HolderBook | null {
    const hit = sampleEntries.get(mint);
    if (hit && inWindow(hit.untilMs, HOLDER_BOOK_SAMPLE_REUSE_MS)) return hit.book;
    const s = deps.sample(mint);
    const book = s ? makeBook(s.holders, s.takenAt, "keeper_sample", deps.creatorOf(mint)) : null;
    sampleEntries.set(mint, { untilMs: now() + HOLDER_BOOK_SAMPLE_REUSE_MS, book });
    return book;
  }

  function chain(mint: string): Promise<HolderBook> {
    const hit = chainEntries.get(mint);
    if (hit && inWindow(hit.freshUntilMs, HOLDER_BOOK_TTL_MS)) return hit.read;
    const read = deps.read(mint).then((all) => makeBook(all, new Date(now()).toISOString(), "chain", deps.creatorOf(mint)));
    const entry: ChainEntry = { freshUntilMs: now() + HOLDER_BOOK_TTL_MS, read, pending: true, book: hit?.book ?? null };
    chainEntries.set(mint, entry);
    read.then(
      (book) => {
        entry.book = book;
        entry.pending = false;
      },
      (err: unknown) => {
        entry.freshUntilMs = now() + HOLDER_BOOK_RETRY_MS;
        entry.pending = false;
        // An unreachable chain is logged once by the RPC guard (src/rpcGuard.ts), not once per coin every few seconds.
        if (!isChainUnavailable(err)) console.error(`[api] holders of ${mint} unreadable, trying again in ${HOLDER_BOOK_RETRY_MS / 1000} s: ${(err as Error)?.message ?? err}`);
      },
    );
    return read;
  }

  function known(mint: string): HolderBook | null {
    const fromSample = sampleBook(mint);
    const hit = chainEntries.get(mint);
    if ((!hit || !inWindow(hit.freshUntilMs, HOLDER_BOOK_TTL_MS)) && reading() < MAX_BOOK_READS) void chain(mint).catch(() => undefined);
    const fromChain = chainEntries.get(mint)?.book ?? null;
    if (fromSample && fromChain) return fromChain.asOf >= fromSample.asOf ? fromChain : fromSample;
    return fromChain ?? fromSample;
  }

  return { known, get: async (mint) => known(mint) ?? (await chain(mint)) };
}

/** Every eligible holder of a coin from the chain, under the same rules as an epoch's holders. */
async function readOnChain(mint: string): Promise<BookRow[]> {
  const holders = await snapshotHolders({ mint: new PublicKey(mint), excludeOwners: recordedExcludedOwners(), minBalance: config.epoch.minHolderBalanceRaw });
  return holders.map((h) => ({ wallet: h.wallet, balance: h.balance }));
}

export const holderBooks = makeHolderBooks({
  sample: db.latestHolderSample,
  read: readOnChain,
  creatorOf: (mint) => db.getCoin(mint)?.creator ?? null,
});
