// The v2.6 routes docs/API.md "Trader panel, live trades, rewards and ledgers"): quote, holders, pot, what is fixed, the trades tape
// and its event stream, one wallet's rewards, the memo check and the epochs CSV. Read-only views: nothing here signs, claims or pays, and
// nothing imports the keeper side (INV-17). Every parameter is checked before any database or chain read.
import { config } from "../config";
import * as db from "../db";
import { isHidden, visibleCoins } from "../dbc/visible";
import { epochsCsv } from "../epochsCsv";
import { holdersOf, MAX_HOLDER_OFFSET } from "../dbc/holdersView";
import { fixedOf } from "../dbc/fixed";
import { clearPotCaches, padPotOf, potOf } from "../dbc/pot";
import { QuoteUnfillableError, clearQuoteCaches, quoteCoin } from "../dbc/quote";
import { checkMemo, MEMO_MAX_BYTES, REWARDS_DEFAULT_LIMIT, REWARDS_MAX_LIMIT, rewardsOf, type MemoProof } from "../rewards";
import {
  FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT, parseLastEventId, recentTrades, recentTradesOfCoin, streamLimiter, tradeEventStream, tradeHub,
} from "../tradeFeed";
import { makeTtlMemo } from "../util/memo";
import { STATS_MAX_AGE_MS } from "../dbc/marketStats";
import { withinDeadline } from "../rpcGuard";
import { CHAIN_ROUTE_DEADLINE_MS, CORS_HEADERS, chainRead, fail, json, launchedMint, type RequestContext } from "./common";
import { intParam, oneOfParam, single } from "./params";
import { ApiFail, amountField, decodeWallet, isPubkey, readJsonObject, signatureField, stringField } from "./validate";

const QUOTE_ROUTE = /^\/api\/coins\/([^/]+)\/quote$/;
const HOLDERS_ROUTE = /^\/api\/coins\/([^/]+)\/holders$/;
const POT_ROUTE = /^\/api\/coins\/([^/]+)\/pot$/;
const FIXED_ROUTE = /^\/api\/coins\/([^/]+)\/fixed$/;
const COIN_TRADES_ROUTE = /^\/api\/coins\/([^/]+)\/trades$/;
const REWARDS_ROUTE = /^\/api\/rewards\/([^/]+)$/;

/**
 * The coins the public board lists, for the trades routes: null = every launched coin (`all`, or no featured list is set). Hidden coins (moderation) are
 * not in this list: they are filtered out of what is sent (visible.ts isHidden), so the list never grows with the pad (audit S5-05).
 */
export function boardMints(all: boolean, featured: string[] = config.api.featuredMints): string[] | null {
  return all || featured.length === 0 ? null : featured;
}

function coinOf(rawMint: string): db.CoinRow {
  return db.getCoin(launchedMint(rawMint))!;
}

async function quoteRoute(rawMint: string, params: URLSearchParams): Promise<Response> {
  const coin = coinOf(rawMint);
  const side = oneOfParam(params, "side", ["buy", "sell"] as const);
  if (side === null) throw new ApiFail(400, "bad_request", "side");
  const amount = amountField({ amount: single(params, "amount") ?? undefined }, "amount");
  const slippageBps = intParam(params, "slippageBps", 0, 5000, 100);
  try {
    return json(await withinDeadline(quoteCoin(coin, side, amount, slippageBps), CHAIN_ROUTE_DEADLINE_MS));
  } catch (err) {
    if (err instanceof QuoteUnfillableError) throw new ApiFail(400, "bad_amount", "amount");
    console.error(`[api] quote of ${coin.mint} could not read the chain: ${(err as Error)?.message ?? err}`);
    throw new ApiFail(503, "chain_unavailable");
  }
}

function tradeLimit(params: URLSearchParams): number {
  return intParam(params, "limit", 1, FEED_MAX_LIMIT, FEED_DEFAULT_LIMIT);
}

/** GET /events/trades: the open stream, or 429 when this address (or the server) has no stream to spare. */
function tradeEvents(req: Request, params: URLSearchParams, ctx: RequestContext): Response {
  const mint = single(params, "mint");
  const mints = mint !== null ? [launchedMint(mint)] : boardMints(params.get("all") === "1");
  const release = streamLimiter.acquire(ctx.ip);
  if (!release) return fail(429, "rate_limited", undefined, { "retry-after": "5" });
  ctx.keepOpen?.();
  const stream = tradeEventStream({ hub: tradeHub, mints: mints ? new Set(mints) : null, lastEventId: parseLastEventId(req.headers.get("last-event-id")), onClose: release });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform keeps the reverse proxy from compressing (and so buffering) the stream; the second header says the same to nginx-style proxies.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-pad-mode": config.mode,
      ...CORS_HEADERS,
    },
  });
}

/** The memo check's body: a memo, an optional txid, and an optional proof that is all or nothing. */
async function memoCheckRoute(req: Request): Promise<Response> {
  const body = await readJsonObject(req);
  const memo = stringField({ memo: typeof body.memo === "string" ? body.memo.trim() : body.memo }, "memo", { min: 1, max: MEMO_MAX_BYTES });
  if (new TextEncoder().encode(memo).length > MEMO_MAX_BYTES) throw new ApiFail(400, "bad_request", "memo");
  let txid: string | null = null;
  if (body.txid !== undefined && body.txid !== null) {
    if (typeof body.txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(body.txid)) throw new ApiFail(400, "bad_request", "txid");
    txid = body.txid.toLowerCase();
  }
  const sentProof = ["wallet", "nonce", "signature"].some((k) => body[k] !== undefined && body[k] !== null);
  let proof: MemoProof | null = null;
  if (sentProof) {
    if (!isPubkey(body.wallet)) throw new ApiFail(400, "bad_wallet", "wallet");
    proof = { wallet: body.wallet, nonce: stringField(body, "nonce", { min: 1, max: 64 }), signature: signatureField(body, "signature", "invalid_signature") };
  }
  const result = checkMemo({ memo, txid, proof });
  return result.ok ? json(result.check) : fail(400, result.error);
}

/** The CSV of every published round, worked out at most once per few seconds like the other public totals. */
const epochsCsvText = makeTtlMemo(() => epochsCsv(db.listEpochs()), STATS_MAX_AGE_MS);

/** For tests: forget everything the v2.6 routes keep, so the next request works it out again. */
export function clearTraderCaches(): void {
  epochsCsvText.clear();
  clearPotCaches();
  clearQuoteCaches();
}

/** The route of this request if it is one of the v2.6 routes; null for any other (the caller carries on). */
export async function handleTraderRoute(req: Request, url: URL, ctx: RequestContext): Promise<Response | null> {
  const path = url.pathname;
  const params = url.searchParams;
  if (req.method === "POST" && path === "/api/rewards/verify-memo") return memoCheckRoute(req);
  if (req.method !== "GET") return null;

  const quote = QUOTE_ROUTE.exec(path);
  if (quote) return quoteRoute(quote[1]!, params);
  const holders = HOLDERS_ROUTE.exec(path);
  if (holders) {
    const coin = coinOf(holders[1]!);
    const page = { limit: intParam(params, "limit", 1, 100, 20), offset: intParam(params, "offset", 0, MAX_HOLDER_OFFSET, 0) };
    return json(await chainRead(`holders of ${coin.mint}`, () => holdersOf(coin, page)));
  }
  const pot = POT_ROUTE.exec(path);
  if (pot) {
    const coin = coinOf(pot[1]!);
    return json(await chainRead(`pot of ${coin.mint}`, () => potOf(coin)));
  }
  const fixed = FIXED_ROUTE.exec(path);
  if (fixed) {
    const coin = coinOf(fixed[1]!);
    return json(await chainRead(`what is fixed about ${coin.mint}`, () => fixedOf(coin)));
  }
  const coinTrades = COIN_TRADES_ROUTE.exec(path);
  if (coinTrades) {
    const mint = launchedMint(coinTrades[1]!);
    return json({ trades: recentTradesOfCoin(mint, tradeLimit(params)) });
  }
  // The pad's pot: the pots of the coins the board lists (the featured ones, or every coin with all=1), added up; one chain read per coin at most every 30 s.
  if (path === "/api/pot") return json(await chainRead("the pad's pot", () => padPotOf(visibleCoins(db.listCoins().filter((c) => c.status === "launched" && c.poolId), params.get("all") === "1"))));
  if (path === "/api/trades") return json({ trades: recentTrades(tradeLimit(params), boardMints(params.get("all") === "1")).filter((x) => !isHidden(x.mint)) });
  if (path === "/api/events/trades") return tradeEvents(req, params, ctx);

  const rewards = REWARDS_ROUTE.exec(path);
  if (rewards) {
    const wallet = decodeWallet(rewards[1]!);
    return json(rewardsOf(wallet, { limit: intParam(params, "limit", 1, REWARDS_MAX_LIMIT, REWARDS_DEFAULT_LIMIT), offset: intParam(params, "offset", 0, 1_000_000, 0) }));
  }
  if (path === "/api/epochs.csv") {
    return new Response(epochsCsvText.get(), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="snarks-epochs.csv"', "x-pad-mode": config.mode, ...CORS_HEADERS },
    });
  }
  return null;
}
