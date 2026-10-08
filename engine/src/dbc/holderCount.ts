// A coin's holder count for the public views. A count is a getProgramAccounts over every token account of the coin, so a
// view must never wait for one (audit S2-11: one read per GET drained the shared RPC quota; stress D7: work per request
// does not survive API load). Cheapest source first:
//   1. the keeper's newest holder sample in the database (src/epoch/snapshots.ts): the same eligible-holder rules as an
//      epoch, taken a few times per epoch window, so on a quiet keeper it can be hours old;
//   2. else the engine's own on-chain count, read in the background at most once per HOLDER_COUNT_TTL_MS per coin, the
//      last count served meanwhile. Until the first one lands there is no number: the list says null, the coin page waits.
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import * as db from "../db";
import { recordedExcludedOwners, snapshotHolders } from "../holders";
import { isChainUnavailable } from "../rpcGuard";

/** What PAD_HOLDER_COUNT_TTL_MS gives when it is unset or not a number. */
export const HOLDER_COUNT_TTL_DEFAULT_MS = 60_000;
/** The shortest wait PAD_HOLDER_COUNT_TTL_MS can set: a count is a getProgramAccounts, 10 credits a call on Helius. */
export const HOLDER_COUNT_TTL_FLOOR_MS = 10_000;

/**
 * PAD_HOLDER_COUNT_TTL_MS in milliseconds: unset or blank gives 60 s, a number is raised to the 10 s floor (a wait of 0 would read the chain on every page view),
 * anything else is a typo, said once, and gives 60 s. Mainnet on a Helius free plan sets 600000 (ops/MAINNET-RUNBOOK.md G13).
 */
export function holderCountTtlMs(raw: string | undefined, warn: (line: string) => void = console.error): number {
  const text = raw?.trim() ?? "";
  if (text === "") return HOLDER_COUNT_TTL_DEFAULT_MS;
  const ms = Number(text);
  if (!Number.isFinite(ms)) {
    warn(`PAD_HOLDER_COUNT_TTL_MS=${JSON.stringify(text)} is not a number of milliseconds: using ${HOLDER_COUNT_TTL_DEFAULT_MS}`);
    return HOLDER_COUNT_TTL_DEFAULT_MS;
  }
  return Math.max(HOLDER_COUNT_TTL_FLOOR_MS, Math.floor(ms));
}

/** An on-chain count is read at most this often per coin (PAD_HOLDER_COUNT_TTL_MS; the holders table of src/dbc/holderBook.ts waits the same). */
export const HOLDER_COUNT_TTL_MS = holderCountTtlMs(process.env.PAD_HOLDER_COUNT_TTL_MS);
/** A failed read is tried again after this, not at once (the RPC is struggling) and not after a whole window. */
export const HOLDER_RETRY_MS = 5_000;
/** How long a database lookup is reused; the sample it finds changes a few times per epoch window. */
export const HOLDER_SAMPLE_REUSE_MS = 30_000;
/** On-chain reads the views have in flight at the same moment, all coins together. */
export const MAX_BACKGROUND_READS = 4;

export interface HolderCounterDeps {
  /** The on-chain count of a coin: one getProgramAccounts. */
  read: (mint: string) => Promise<number>;
  /** The keeper's newest holder sample of a coin, null when it has none. */
  sample: (mint: string) => number | null;
  now?: () => number;
}

export interface HolderCounter {
  /** What is known right now, never waiting: the keeper's sample, else the last on-chain count; null if neither exists yet (a read is started). */
  known(mint: string): number | null;
  /** known(), but waits for the first on-chain count when there is nothing yet: the coin page, which must show a number. */
  count(mint: string): Promise<number>;
  /** The on-chain count itself, read at most once per HOLDER_COUNT_TTL_MS per coin; the same promise is shared inside the window. */
  chain(mint: string): Promise<number>;
}

interface ChainEntry {
  /** End of this read's window; a failed read cuts it to HOLDER_RETRY_MS. */
  freshUntilMs: number;
  read: Promise<number>;
  pending: boolean;
  /** The newest count read successfully: this read's once it lands, the previous read's until then. */
  count: number | null;
}

export function makeHolderCounter(deps: HolderCounterDeps): HolderCounter {
  const now = deps.now ?? Date.now;
  const chainEntries = new Map<string, ChainEntry>();
  const sampleEntries = new Map<string, { untilMs: number; count: number | null }>();

  /** Inside its window; a clock that moved backwards past the window's whole length counts as outside it. */
  const inWindow = (untilMs: number, windowMs: number): boolean => now() < untilMs && untilMs - now() <= windowMs;
  /** Reads in flight. One still open after its window is taken as hung and stops counting, so a few hung reads cannot starve the others for good. */
  const reading = (): number => [...chainEntries.values()].filter((e) => e.pending && inWindow(e.freshUntilMs, HOLDER_COUNT_TTL_MS)).length;

  function sample(mint: string): number | null {
    const hit = sampleEntries.get(mint);
    if (hit && inWindow(hit.untilMs, HOLDER_SAMPLE_REUSE_MS)) return hit.count;
    const count = deps.sample(mint);
    sampleEntries.set(mint, { untilMs: now() + HOLDER_SAMPLE_REUSE_MS, count });
    return count;
  }

  function chain(mint: string): Promise<number> {
    const hit = chainEntries.get(mint);
    if (hit && inWindow(hit.freshUntilMs, HOLDER_COUNT_TTL_MS)) return hit.read;
    const entry: ChainEntry = { freshUntilMs: now() + HOLDER_COUNT_TTL_MS, read: deps.read(mint), pending: true, count: hit?.count ?? null };
    chainEntries.set(mint, entry);
    entry.read.then(
      (n) => {
        entry.count = n;
        entry.pending = false;
      },
      (err: unknown) => {
        entry.freshUntilMs = now() + HOLDER_RETRY_MS;
        entry.pending = false;
        // An unreachable chain is logged once by the RPC guard (src/rpcGuard.ts), not once per coin every few seconds.
        if (!isChainUnavailable(err)) console.error(`[api] holder count of ${mint} unreadable, trying again in ${HOLDER_RETRY_MS / 1000} s: ${(err as Error)?.message ?? err}`);
      },
    );
    return entry.read;
  }

  function known(mint: string): number | null {
    const fromSample = sample(mint);
    if (fromSample !== null) return fromSample;
    const hit = chainEntries.get(mint);
    if ((!hit || !inWindow(hit.freshUntilMs, HOLDER_COUNT_TTL_MS)) && reading() < MAX_BACKGROUND_READS) void chain(mint);
    return chainEntries.get(mint)?.count ?? null;
  }

  return { known, chain, count: async (mint) => known(mint) ?? (await chain(mint)) };
}

/** The on-chain count of a coin: its token accounts, under the same eligibility rules as an epoch's holders. */
async function readOnChain(mint: string): Promise<number> {
  const holders = await snapshotHolders({
    mint: new PublicKey(mint),
    excludeOwners: recordedExcludedOwners(),
    minBalance: config.epoch.minHolderBalanceRaw,
  });
  return holders.length;
}

export const holders = makeHolderCounter({ read: readOnChain, sample: db.latestHolderSampleCount });

/** The on-chain count of a coin, read at most once per HOLDER_COUNT_TTL_MS (audit S2-11). */
export const countHolders = (mint: string): Promise<number> => holders.chain(mint);
