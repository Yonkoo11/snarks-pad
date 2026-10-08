// GET /api/coins/:mint/holders docs/API.md v2.6: a coin's holders as a ranked page with tags and the totals the coin page
// prints. `buildHoldersView` is pure (a book and the pool vaults in, the page out); `holdersOf` gathers them from the caches, none of
// which reads the chain inside the request (see holderBook.ts and poolVaults.ts). Since v2.9 nothing here says which wallets have
// shielded delivery on, by tag or by count: the view is built from balances and the creator alone.
import { config } from "../config";
import type { CoinRow } from "../db";
import { holderBooks, type HolderBook } from "./holderBook";
import { poolHoldings, type PoolHolding } from "./poolVaults";

export type HolderTag = "dev" | "pool";

export interface HolderRow {
  rank: number;
  wallet: string;
  balance: string;
  pct: number;
  tags: HolderTag[];
  label?: string;
}

export interface HoldersView {
  holders: HolderRow[];
  total: number;
  holdersCount: number;
  top10Pct: number;
  devPct: number;
  poolPct: number | null;
  supply: string;
  asOf: string;
  source: HolderBook["source"];
}

/** Rows beyond this many are counted in `total` but never listed (a book keeps this many wallets). */
export const MAX_HOLDER_OFFSET = 10_000;

/** `balance` as a share of `supply` in percent, rounded down to 4 decimals (12.3456). */
export function pctOf(balance: bigint, supply: bigint): number {
  return supply <= 0n ? 0 : Number((balance * 1_000_000n) / supply) / 10_000;
}

export interface HoldersInput {
  creator: string;
  supply: bigint;
  book: HolderBook;
  /** The pool vaults' holdings; null when they could not be read (their rows and share are then left out, not guessed). */
  pools: PoolHolding[] | null;
  limit: number;
  offset: number;
}

export function buildHoldersView(i: HoldersInput): HoldersView {
  const pools = i.pools ?? [];
  const rows = [
    ...i.book.rows.map((r) => ({ wallet: r.wallet, balance: r.balance, pool: null as PoolHolding | null })),
    ...pools.map((p) => ({ wallet: p.account, balance: p.balance, pool: p as PoolHolding | null })),
  ].sort((a, b) => (a.balance === b.balance ? (a.wallet < b.wallet ? -1 : 1) : a.balance > b.balance ? -1 : 1));

  const page = rows.slice(i.offset, i.offset + i.limit).map((r, k): HolderRow => {
    const tags: HolderTag[] = [];
    if (r.pool) tags.push("pool");
    else if (r.wallet === i.creator) tags.push("dev");
    return { rank: i.offset + k + 1, wallet: r.wallet, balance: r.balance.toString(), pct: pctOf(r.balance, i.supply), tags, ...(r.pool ? { label: r.pool.label } : {}) };
  });

  const top10 = i.book.rows.slice(0, 10).reduce((sum, r) => sum + r.balance, 0n);
  return {
    holders: page,
    total: i.book.count + pools.length,
    holdersCount: i.book.count,
    top10Pct: pctOf(top10, i.supply),
    devPct: pctOf(i.book.creatorBalance, i.supply),
    poolPct: i.pools === null ? null : pctOf(pools.reduce((sum, p) => sum + p.balance, 0n), i.supply),
    supply: i.supply.toString(),
    asOf: i.book.asOf,
    source: i.book.source,
  };
}

/** A coin's total supply in token base units. */
export function supplyRaw(coin: Pick<CoinRow, "mintDecimals">): bigint {
  return BigInt(config.solana.dbc.totalSupply) * 10n ** BigInt(coin.mintDecimals);
}

/**
 * The holders page of a coin. Rejects only when there is no book at all and the first on-chain read failed; a pool vault that cannot
 * be read just leaves its rows and `poolPct` out.
 */
export async function holdersOf(coin: CoinRow, query: { limit: number; offset: number }): Promise<HoldersView> {
  const book = await holderBooks.get(coin.mint);
  const pools = await poolHoldings(coin).catch((err: unknown): null => {
    console.error(`[api] pool vaults of ${coin.mint} unreadable, answering without them: ${(err as Error)?.message ?? err}`);
    return null;
  });
  return buildHoldersView({ creator: coin.creator, supply: supplyRaw(coin), book, pools, ...query });
}
