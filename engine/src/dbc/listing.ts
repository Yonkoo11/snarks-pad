// GET /api/coins query: ?sort=new|mcap|volume|progress &stage=curve|graduated &q=<text> &limit=1..100 &offset=0.. (and
// the old &all=1), docs/API.md v2.5. Everything is validated before any chain read and applied in memory, so no
// parameter ever reaches SQL or a regular expression, and an error never echoes what was sent.
import { intParam, oneOfParam, single } from "../api/params";
import { ApiFail } from "../api/validate";
import type { CoinView, PublicCoinView } from "./read";

export const COIN_SORTS = ["new", "mcap", "volume", "progress"] as const;
export type CoinSort = (typeof COIN_SORTS)[number];
const STAGES = ["curve", "graduated"] as const;

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 1_000_000;
/** A mint is 44 characters, a name 32 and a symbol 10: a longer search can match nothing. */
export const MAX_SEARCH_CHARS = 64;

export interface CoinsQuery {
  all: boolean;
  sort: CoinSort;
  stage: CoinView["stage"] | null;
  /** Trimmed search text, "" for none. */
  q: string;
  limit: number;
  offset: number;
}

function searchParam(params: URLSearchParams): string {
  const v = single(params, "q");
  if (v === null) return "";
  if (v.length > MAX_SEARCH_CHARS || /[\u0000-\u001f\u007f]/.test(v)) throw new ApiFail(400, "bad_request", "q");
  return v.trim();
}

/** Throws ApiFail(400, "bad_request", <parameter>) for anything that is not valid. Unknown parameters are ignored. */
export function parseCoinsQuery(params: URLSearchParams): CoinsQuery {
  return {
    all: params.get("all") === "1",
    sort: oneOfParam(params, "sort", COIN_SORTS) ?? "new",
    stage: oneOfParam(params, "stage", STAGES),
    q: searchParam(params),
    limit: intParam(params, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT),
    offset: intParam(params, "offset", 0, MAX_OFFSET, 0),
  };
}

// `curveProgress` and `marketCapZec` are absent when the chain could not be read for the coin (contract v2.8.1): such a coin ranks as 0 on them.
export type ListedCoin = Pick<PublicCoinView, "mint" | "name" | "symbol" | "stage" | "createdAt" | "curveProgress" | "marketCapZec"> & { volume24hZats: string };

/** A search matches a name or a symbol containing it (any case), or a mint starting with it (a mint is case-sensitive). */
function matches(c: ListedCoin, q: string, lower: string): boolean {
  return c.name.toLowerCase().includes(lower) || c.symbol.toLowerCase().includes(lower) || c.mint.startsWith(q);
}

const zats = (s: string | undefined): bigint => (s !== undefined && /^[0-9]+$/.test(s) ? BigInt(s) : 0n);

type Rank = (c: ListedCoin) => bigint | number;
const byMcap: Rank = (c) => zats(c.marketCapZec);
const byVolume: Rank = (c) => zats(c.volume24hZats);
const onCurve: Rank = (c) => (c.stage === "curve" ? 1 : 0);
const byProgress: Rank = (c) => c.curveProgress ?? 0;

/**
 * What each sort ranks by, in order, biggest first; whatever is still tied falls to newest first, then to the mint, so the order is
 * total. `new` ranks by nothing. Volume ties (most coins of a young pad have none) go to the bigger market cap; `progress` puts the
 * coins still on a curve first, nearest graduation first, and the graduated ones after them.
 */
const SORT_RANKS: Record<CoinSort, Rank[]> = {
  new: [],
  mcap: [byMcap],
  volume: [byVolume, byMcap],
  progress: [onCurve, byProgress, byMcap],
};

/**
 * The coins of the query's stage and search in the query's order, then one page of them. The order is total, so paging through it
 * never repeats or skips a coin. `total` counts every match, before the page.
 */
export function selectCoins<T extends ListedCoin>(items: T[], query: CoinsQuery): { page: T[]; total: number } {
  const ranks = SORT_RANKS[query.sort];
  const lower = query.q.toLowerCase();
  const kept = items
    .filter((c) => (query.stage === null || c.stage === query.stage) && (query.q === "" || matches(c, query.q, lower)))
    .map((c) => ({ c, keys: ranks.map((rank) => rank(c)) }));
  kept.sort((a, b) => {
    for (let i = 0; i < ranks.length; i++) if (a.keys[i] !== b.keys[i]) return a.keys[i]! < b.keys[i]! ? 1 : -1;
    if (a.c.createdAt !== b.c.createdAt) return a.c.createdAt < b.c.createdAt ? 1 : -1;
    return a.c.mint < b.c.mint ? -1 : a.c.mint > b.c.mint ? 1 : 0;
  });
  return { page: kept.slice(query.offset, query.offset + query.limit).map((x) => x.c), total: kept.length };
}
