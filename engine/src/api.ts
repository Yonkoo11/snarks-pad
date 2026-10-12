// HTTP API on :8787, implementing docs/API.md exactly.
import { config } from "./config";
import * as db from "./db";
import { coinViewWithin, COIN_VIEW_WAIT_MS, listCoinViews, type PublicCoinView, lastKnownView } from "./dbc/read";
import { isHidden, visibleCoins } from "./dbc/visible";
import { holders } from "./dbc/holderCount";
import { NO_TRADES, STATS_MAX_AGE_MS, priceChangeBps, windowStats, type WindowStats } from "./dbc/marketStats";
import { parseCoinsQuery, selectCoins } from "./dbc/listing";
import { buildLaunchTx, confirmLaunch, LaunchConfirmError, LaunchTxError, type LaunchParams, type LaunchTxResult } from "./dbc/launch";
import { startLaunchReconciler } from "./dbc/reconcile";
import { startMigrationReconciler } from "./dbc/graduation";
import { startTradeIndexer } from "./dbc/tradeIndex";
import { CosignError, cosignLaunch } from "./dbc/cosign";
import { buildTradeTx, confirmTrade, recordTradeFromTx, TradeError } from "./dbc/trade";
import { MAX_PRICE_POINTS, pricePoints } from "./dbc/priceHistory";
import {
  ApiFail, readJsonObject, isPubkey, pubkeyField, stringField, amountField, intField, oneOf, signatureField, imageUrlField, socialsField,
} from "./api/validate";
import { issueNonce, registerOptin, deregisterOptin, readOptinStatus, NonceLimitError } from "./optin/registry";
import { getTreasuryView } from "./ledger";
import { ConfigRefusedError, PadNotConfiguredError, TierNotAvailableError, buildConfigParams, requireDbcConfig, tiersAvailable } from "./dbc/config";
import { DEFAULT_TIER_BPS, TIER_MENU_BPS, reviewedTier } from "./dbc/reviewed";
import { roundTripCostBps, tierShares, tierWindow } from "./dbc/tiers";
import { CreatorClaimError, buildCreatorClaimTx, readCreatorFees, type CreatorClaimKind } from "./dbc/creatorClaim";
import { CreatorWalletError, requireCreatorWallet } from "./dbc/creatorWallet";
import { launchpadSignerAddress } from "./dbc/launchSigner";
import { liveFeeOf } from "./dbc/liveFee";
import { faucetFund, FaucetError } from "./faucet";
import { openReceipt } from "./epoch/receipt";
import { CHAIN_ROUTE_DEADLINE_MS, CORS_HEADERS, clientIp, fail, isLoopback, json, launchedMint, type RequestContext } from "./api/common";
import { clearTraderCaches, handleTraderRoute } from "./api/traderRoutes";
import { handleUploadRoute } from "./api/uploadRoutes";
import { handleWalletRoute } from "./api/walletRoutes";
import { launchLimiter, reserveLaunch } from "./api/launchLimits";
import { makeFloodAlert } from "./api/floodAlert";
import { makeWindowLimiter } from "./api/windowLimiter";
import { prepareHostedFiles } from "./publicFiles/ready";
import { servePublicFile } from "./publicFiles/serve";
import { startPublicFilesSweep } from "./publicFiles/sweep";
import { tradeHub } from "./tradeFeed";
import { makeTtlMemo } from "./util/memo";
import { isChainUnavailable, settleWithin, withinDeadline } from "./rpcGuard";
import { computeAllCoinRewards, computeCoinRewards, epochSplit, payoutRail, snapshotSummary, summarizePayouts, totalPaidToHolders, type CoinRewards } from "./epoch/publicView";

// Kept on this module: test/audit-api-limits.test.ts (audit S2-11b) reaches the holder count through it, and the payout view helpers
// (they moved to src/epoch/publicView.ts so the pot, rewards and CSV routes can share them without importing this file).
export { countHolders } from "./dbc/holderCount";
export { computeAllCoinRewards, computeCoinRewards, epochSplit, payoutRail, snapshotSummary, totalPaidToHolders };
export type { CoinRewards };

// Audit S2-11: POST /coins/confirm and trade-confirm poll the RPC for up to
// 20 s on a caller-chosen signature; past this many at once the route answers
// 429 instead of spending the shared RPC quota the keeper also needs.
export const MAX_CONCURRENT_SIG_WAITS = 8;
let sigWaits = 0;

async function withSigWaitSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (sigWaits >= MAX_CONCURRENT_SIG_WAITS) throw new ApiFail(429, "busy");
  sigWaits++;
  try {
    return await fn();
  } finally {
    sigWaits--;
  }
}

const MINT_ROUTE = /^\/api\/coins\/([^/]+)$/;
const PRICE_ROUTE = /^\/api\/coins\/([^/]+)\/price-history$/;
const TRADE_ROUTE = /^\/api\/coins\/([^/]+)\/trade-tx$/;
const TRADE_CONFIRM_ROUTE = /^\/api\/coins\/([^/]+)\/trade-confirm$/;
const CREATOR_FEES_ROUTE = /^\/api\/coins\/([^/]+)\/creator-fees$/;
const CREATOR_CLAIM_ROUTE = /^\/api\/coins\/([^/]+)\/creator-claim-tx$/;

/** A creator-claim refusal as an API answer: only the wallet that is the pool's creator on chain gets a transaction. */
function creatorClaimFail(e: unknown): never {
  if (!(e instanceof CreatorClaimError)) throw e;
  if (e.code === "unknown_mint") throw new ApiFail(404, "unknown_mint");
  if (e.code === "not_creator") throw new ApiFail(403, "not_creator", "wallet");
  throw new ApiFail(400, e.code);
}

/**
 * The Creator wallet of a launch request (contract v2.8): the address to hand the pool to, null for none, else `400 bad_creator_wallet`. Checked before any
 * chain read. On a tier whose creator share is 0 (mainnet's only tier) a different wallet is `400 creator_wallet_no_share` (audit S6, product decision 3):
 * there is nothing to hand over but a name, and the named wallet never signed for it.
 */
function creatorWalletField(body: Record<string, unknown>, creator: string): string | null {
  try {
    return requireCreatorWallet(body.creatorWallet, creator);
  } catch (e) {
    if (!(e instanceof CreatorWalletError)) throw e;
    console.error(`[api] creatorWallet refused (${e.reason})`);
    throw new ApiFail(400, "bad_creator_wallet", "creatorWallet");
  }
}

/** Decision 3's rule, applied once the tier is known: a handover on a tier with no creator share is `400 creator_wallet_no_share`. */
function requireCreatorShareFor(wallet: string | null, feeTier: number): void {
  if (wallet !== null && tierShares(feeTier, config.epoch.team.shareBps).creatorBps === 0) throw new ApiFail(400, "creator_wallet_no_share", "creatorWallet");
}

/** The coin page's holder count: what is known now, else the first on-chain count if it lands within the coin view's wait, else null (the chain cannot be read). */
async function holdersWithin(mint: string): Promise<number | null> {
  const known = holders.known(mint);
  if (known !== null) return known;
  const first = await settleWithin(holders.count(mint), COIN_VIEW_WAIT_MS);
  return first.ok ? first.value : null;
}

/** The launch transaction of a checked request: the tier's verified config, then the build. Both read the chain. */
async function launchTxFor(feeBps: number, p: LaunchParams): Promise<LaunchTxResult> {
  const cfg = await requireTierConfig(p.feeTier ?? DEFAULT_TIER_BPS);
  if (feeBps !== cfg.feeBps) throw new ApiFail(400, "bad_request", "feeBps");
  return buildLaunchTx(p, { cosign: true }); // the wallet signs first; POST /coins/launch-cosign adds the coin's signature (dbc/cosign.ts)
}

/** The verified config of a fee tier, or the API answer for why there is none: never a thrown 500. */
async function requireTierConfig(feeTier: number) {
  try {
    return await requireDbcConfig(feeTier);
  } catch (e) {
    if (e instanceof TierNotAvailableError || e instanceof ConfigRefusedError) {
      console.error(`[api] fee tier ${feeTier} refused: ${(e as Error).message}`);
      throw new ApiFail(503, "tier_unavailable", "feeTier");
    }
    throw e;
  }
}

const thresholdOfTier = new Map<number, string>();

/**
 * The ZEC (zats) a tier's curve must raise to graduate. It is what the reviewed config builds for the tier, which is also what every config the
 * pad records for it has to equal before it can be launched on (src/dbc/config.ts checks the chain's value against this one), so there is no
 * second source to ask. Built once per tier: the curve is arithmetic over fixed numbers.
 */
function migrationThresholdOf(bps: number): string {
  let built = thresholdOfTier.get(bps);
  if (built === undefined) {
    built = buildConfigParams(bps).migrationQuoteThreshold.toString();
    thresholdOfTier.set(bps, built);
  }
  return built;
}

/**
 * GET /api/tiers: the fee-tier menu with who gets what of each fee, from the engine's own reviewed numbers (src/dbc/tiers.ts), and (v2.7) the facts of the
 * tier's config the Launch page's preview prints: the ZEC the curve must raise to graduate, and how much of the graduated pool's liquidity is locked for
 * good. `quoteMint` is the token every coin of this pad is paired with on this network, so the page can read a wallet's balance of it.
 */
function tiersView() {
  const have = new Set(tiersAvailable());
  return TIER_MENU_BPS.map((bps) => {
    const t = reviewedTier(bps)!;
    const s = tierShares(bps, config.epoch.team.shareBps);
    return {
      feeBps: bps, available: have.has(bps), postGraduationFeeBps: t.postGraduationFeeBps, roundTripCostBps: roundTripCostBps(bps),
      meteoraShareBps: s.meteoraBps, creatorShareBps: s.creatorBps, holderShareBps: s.holdersBps, teamShareBps: s.teamBps, claimedShareBps: s.claimedBps,
      launchWindow: tierWindow(bps),
      migrationThresholdZats: migrationThresholdOf(bps),
      liquidity: { partnerLockedPct: t.partnerLockedLpPercentage, creatorLockedPct: t.creatorLockedLpPercentage, unlockedPct: 100 - t.partnerLockedLpPercentage - t.creatorLockedLpPercentage },
    };
  });
}

/**
 * The launch transaction of a checked request, inside the cap on unconfirmed launches (src/api/launchLimits.ts, S4-05): 429 for an address at its cap, 503 for the
 * pad at its own, each with `retry-after`; else the answer. A launch counts from the moment its transaction starts to be built.
 */
async function launchTxWithinCaps(feeBps: number, p: LaunchParams, ctx: RequestContext): Promise<Response> {
  const place = reserveLaunch(ctx.ip ?? "unknown");
  if (!place.ok) return fail(place.status, place.error, undefined, { "retry-after": String(place.retryAfter) });
  try {
    const result = await withinDeadline(launchTxFor(feeBps, p), CHAIN_ROUTE_DEADLINE_MS);
    place.slot.built(result.mint);
    return json({ tx: result.txBase64, mint: result.mint });
  } catch (err) {
    place.slot.abandon();
    // v2.9.1: refused before any wallet saw it: 400 with the reason, a wallet short of SOL or ZEC, or a launch that would fail.
    if (err instanceof LaunchTxError) throw new ApiFail(400, err.code);
    throw err;
  }
}

async function handleCoins(req: Request, url: URL, ctx: RequestContext): Promise<Response> {
  if (req.method === "GET" && url.pathname === "/api/coins") {
    const query = parseCoinsQuery(url.searchParams); // before any chain read: a bad parameter costs the RPC nothing
    const views = await listCoinViews(query.all); // the database first; the chain only if it answers within COIN_VIEW_WAIT_MS (v2.8.1)
    const rewards = coinRewards.get();
    const market = windowStats.get();
    const { page, total } = selectCoins(views.map((v) => withMarket(v, market.get(v.mint) ?? NO_TRADES)), query);
    // Holders only for the page that is sent: a read for every coin of a long board would be wasted.
    return json({ coins: page.map((c) => ({ ...c, holders: holders.known(c.mint), rewards: rewards.get(c.mint) ?? NO_REWARDS })), total });
  }
  if (req.method === "GET" && url.pathname === "/api/coins/index") {
    // v2.9.1 (audit S5-07): every coin the pad has not hidden, from the database and the last price the engine read, with no chain read: what a wallet's
    // holdings are matched against. GET /coins?all=1 read every pool to answer the same question.
    const coins = visibleCoins(db.listCoins().filter((c) => c.status === "launched"), true).map((c) => {
      const priceZec = lastKnownView(c)?.priceZec;
      return { mint: c.mint, name: c.name, symbol: c.symbol, imageUrl: c.imageUrl, ...(priceZec ? { priceZec } : {}) };
    });
    return json({ coins });
  }
  const detailMatch = MINT_ROUTE.exec(url.pathname);
  if (req.method === "GET" && detailMatch && detailMatch[1] !== "launch-tx" && detailMatch[1] !== "confirm") {
    const mint = launchedMint(detailMatch[1]!);
    const coin = db.getCoin(mint)!;
    const [view, holderCount] = await Promise.all([coinViewWithin(coin), holdersWithin(coin.mint)]);
    if (!view) throw new ApiFail(404, "unknown_mint");
    const rewards = coinRewards.get().get(coin.mint) ?? NO_REWARDS;
    const recentTrades = db.listTradesForMint(coin.mint).map(({ sig, side, wallet, amountToken, amountZec, at }) => ({ sig, side, wallet, amountToken, amountZec, at }));
    const market = windowStats.get().get(coin.mint) ?? NO_TRADES;
    return json({ ...withMarket(view, market), ...liveFeeOf(coin, view.stage), holders: holderCount, recentTrades, rewards, ...(isHidden(coin.mint) ? { hidden: true } : {}) });
  }
  const priceMatch = PRICE_ROUTE.exec(url.pathname);
  if (req.method === "GET" && priceMatch) {
    const coin = db.getCoin(launchedMint(priceMatch[1]!))!;
    return json({ points: pricePoints(coin, db.listTradesAscending(coin.mint, MAX_PRICE_POINTS), db.firstTradeSig(coin.mint)) });
  }
  if (req.method === "POST" && url.pathname === "/api/coins/launch-tx") {
    const wait = launchLimiter.take(ctx.ip ?? "unknown"); // before the body is read: a call that is refused costs nothing
    if (wait !== null) return fail(429, "rate_limited", undefined, { "retry-after": String(wait) });
    const body = await readJsonObject(req);
    const creator = pubkeyField(body, "creator");
    const name = stringField(body, "name", { min: 1, max: 32 });
    const symbol = stringField(body, "symbol", { min: 1, max: 10 });
    if (!/^[A-Za-z0-9]+$/.test(symbol)) throw new ApiFail(400, "bad_request", "symbol");
    const description = stringField(body, "description", { max: 280, optional: true });
    const imageUrl = imageUrlField(body);
    const socials = socialsField(body);
    // The trading fee is fixed per DBC config, and a config is one fee tier (contract v2.3): `feeTier` picks the tier (default 1%,
    // the SNARKS config). `feeBps` is the old optional echo of the fee and, if sent, must equal the tier's curve fee.
    const creatorWallet = creatorWalletField(body, creator) ?? undefined; // the wallet's shape before the tier (the order the contract states)
    const feeTier = intField(body, "feeTier", 1, 10_000, DEFAULT_TIER_BPS);
    if (!reviewedTier(feeTier)) throw new ApiFail(400, "bad_request", "feeTier");
    requireCreatorShareFor(creatorWallet ?? null, feeTier);
    const feeBps = intField(body, "feeBps", 100, 1_000, feeTier);
    const initialBuyZats = body.initialBuyZec === undefined || body.initialBuyZec === null ? undefined : amountField(body, "initialBuyZec");
    return launchTxWithinCaps(feeBps, { creator, name, symbol, description, imageUrl, initialBuyZats, feeTier, socials, creatorWallet }, ctx);
  }
  if (req.method === "POST" && url.pathname === "/api/coins/launch-cosign") {
    // v2.9.1: the creator's wallet signed first; the engine checks the transaction against what it built and adds the coin's signature (dbc/cosign.ts)
    const body = await readJsonObject(req);
    const mint = pubkeyField(body, "mint", "unknown_launch");
    if (typeof body.tx !== "string" || body.tx.length > 2_400 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.tx)) throw new ApiFail(400, "bad_request", "tx");
    try {
      return json({ tx: cosignLaunch(mint, body.tx) });
    } catch (e) {
      if (e instanceof CosignError) {
        if (e.code === "tx_mismatch") console.error(`[api] launch-cosign refused ${mint}: ${e.detail}`);
        throw e.code === "unknown_launch" ? new ApiFail(404, "unknown_launch") : e.code === "bad_tx" ? new ApiFail(400, "bad_request", "tx") : new ApiFail(400, "tx_mismatch");
      }
      throw e;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/coins/confirm") {
    const body = await readJsonObject(req);
    const sig = signatureField(body, "sig");
    const mint = pubkeyField(body, "mint", "unknown_mint");
    try {
      // The launch's own first buy is a trade (GAP-AUDIT G44), read from the same transaction, once, inside the same wait slot (audit S5-02), and only
      // when this call is the one that recorded the launch: a repeated confirm costs no chain read.
      const { poolId } = await withSigWaitSlot(async () => {
        const r = await confirmLaunch(sig, mint);
        if (r.newlyLaunched) await recordTradeFromTx(sig, mint).catch(() => null);
        return r;
      });
      return json({ ok: true, poolId });
    } catch (e) {
      if (e instanceof LaunchConfirmError) throw new ApiFail(e.code === "unknown_mint" ? 404 : 400, e.code);
      throw e;
    }
  }
  const feesMatch = CREATOR_FEES_ROUTE.exec(url.pathname);
  if (req.method === "GET" && feesMatch) {
    const refused = chainReadRefusal(ctx);
    if (refused) return refused;
    const f = await readCreatorFees(launchedMint(feesMatch[1]!)).catch(creatorClaimFail);
    return json({ creator: f.creator, creatorShareBps: f.creatorShareBps, curveZats: f.curveZats.toString(), poolZats: f.poolZats.toString(), graduated: f.graduated });
  }
  const claimMatch = CREATOR_CLAIM_ROUTE.exec(url.pathname);
  if (req.method === "POST" && claimMatch) {
    const refused = chainReadRefusal(ctx);
    if (refused) return refused;
    const mint = launchedMint(claimMatch[1]!);
    const body = await readJsonObject(req);
    const wallet = pubkeyField(body, "wallet");
    const kind = body.kind === undefined ? undefined : oneOf(body, "kind", ["curve", "pool"] as const satisfies readonly CreatorClaimKind[]);
    const r = await buildCreatorClaimTx(mint, wallet, kind).catch(creatorClaimFail);
    return json({ tx: r.txBase64, kind: r.kind, claimableZats: r.claimableZats });
  }
  const tradeMatch = TRADE_ROUTE.exec(url.pathname);
  if (req.method === "POST" && tradeMatch) {
    const refused = chainReadRefusal(ctx);
    if (refused) return refused;
    const mint = launchedMint(tradeMatch[1]!);
    const body = await readJsonObject(req);
    const params = {
      wallet: pubkeyField(body, "wallet"),
      mint,
      side: oneOf(body, "side", ["buy", "sell"] as const),
      amount: amountField(body, "amount"),
      slippageBps: intField(body, "slippageBps", 0, 5000, 100),
      referrer: body.referrer === undefined || body.referrer === null ? undefined : pubkeyField(body, "referrer"),
    };
    try {
      const result = await withinDeadline(buildTradeTx(params), CHAIN_ROUTE_DEADLINE_MS);
      return json({ tx: result.txBase64, quote: result.quote });
    } catch (e) {
      if (isChainUnavailable(e)) throw e; // 503 chain_unavailable (v2.8.1), never a bad_amount the caller did not send
      if (e instanceof TradeError && e.code === "bad_referral") throw new ApiFail(400, "bad_referral", "referrer");
      if (e instanceof TradeError) throw new ApiFail(404, e.code);
      // The SDK throws on amounts the curve cannot fill (e.g. selling more than
      // the curve holds, or a buy past the fundraising target).
      throw new ApiFail(400, "bad_amount", "amount");
    }
  }
  const confirmMatch = TRADE_CONFIRM_ROUTE.exec(url.pathname);
  if (req.method === "POST" && confirmMatch) {
    const mint = launchedMint(confirmMatch[1]!);
    const body = await readJsonObject(req);
    const sig = signatureField(body, "sig");
    try {
      const t = await withSigWaitSlot(() => confirmTrade(sig, mint));
      tradeHub.poke(); // the event streams hear this trade now, not at the next poll
      return json({ ok: true, trade: { sig: t.sig, side: t.side, wallet: t.wallet, amountToken: t.amountToken, amountZec: t.amountZec, at: t.at } });
    } catch (e) {
      if (e instanceof TradeError) throw new ApiFail(e.code === "unknown_mint" ? 404 : 400, e.code);
      throw e;
    }
  }
  return fail(404, "not_found");
}

const NO_REWARDS: CoinRewards = { paidSolanaZec: "0", paidShieldedZec: "0", epochs: 0 };

/** A coin's pool view with its 24-hour numbers (contract v2.5). The price change is the pool's price now against the first trade of the window; null with no price. */
function withMarket(view: PublicCoinView, w: WindowStats) {
  const priceChange24hBps = view.priceZec === undefined ? null : priceChangeBps(w.firstPriceZec, view.priceZec);
  return { ...view, volume24hZats: w.volume24hZats, trades24h: w.trades24h, priceChange24hBps };
}

// Adding up every epoch's payout rows costs about 3 ms at the stress run's size (4,000 rows), and every coin list and coin page did it
// per request. The rows change once per epoch, so the routes serve the sums from the same few-second window as the 24-hour numbers.
const coinRewards = makeTtlMemo(() => computeAllCoinRewards(), STATS_MAX_AGE_MS);

/** Nonces one client address may ask for in a minute (audit S6, lens 1-02): a wallet needs one per signed action, a stranger needs many to crowd a victim's out. */
export const NONCES_PER_MINUTE = 10;
const nonceLimiter = makeWindowLimiter(NONCES_PER_MINUTE, 60_000);

/**
 * Chain reads one client address may trigger in a minute through trade-tx, creator-claim-tx and creator-fees (audit S6, lenses 4-1,
 * 5-3, 6-5): each builds from several uncached RPC calls on the same key and budget the keeper's payout rounds use, so a flood of
 * them could burn the plan and fail a round. A trader needs one per trade. Loopback and direct calls are not counted.
 */
export const CHAIN_READS_PER_MINUTE = 60; // a creator's profile reads creator-fees once per coin: room for a launcher with many coins
const chainReadLimiter = makeWindowLimiter(CHAIN_READS_PER_MINUTE, 60_000);
// Audit S6, product decision 5: past an hourly ceiling the chain routes together answer 503 (database views keep serving), so a flood
// from many addresses costs at most that much of the API's own RPC budget; the operator hears of it once per episode.
let chainRouteCeilingMax = config.api.chainRouteCeilingPerHour;
let chainRouteCeiling = makeWindowLimiter(chainRouteCeilingMax, 3_600_000);
const chainCeilingAlert = makeFloodAlert("api_chain_ceiling");
function chainReadRefusal(ctx: RequestContext): Response | null {
  if (ctx.ip === null || isLoopback(ctx.ip)) return null;
  const wait = chainReadLimiter.take(ctx.ip);
  if (wait !== null) return fail(429, "rate_limited", undefined, { "retry-after": String(wait) });
  const now = Date.now();
  chainCeilingAlert.settle(now);
  const ceiling = chainRouteCeiling.take("pad");
  if (ceiling === null) return null;
  chainCeilingAlert.refused(now, `the API's chain routes reached ${chainRouteCeilingMax} reads this hour (PAD_API_CHAIN_ROUTE_CEILING_PER_HOUR); trade, claim and fee reads answer 503 for ${ceiling} s`);
  return fail(503, "busy", undefined, { "retry-after": String(ceiling) });
}

/** For tests: a ceiling of `max` reads an hour, counted from nothing. */
export function setChainRouteCeilingForTests(max: number): void {
  chainRouteCeilingMax = max;
  chainRouteCeiling = makeWindowLimiter(max, 3_600_000);
  chainCeilingAlert.reset();
}

async function handleOptin(req: Request, url: URL, ctx: RequestContext): Promise<Response> {
  if (req.method === "GET" && url.pathname === "/api/optin/nonce") {
    const wallet = url.searchParams.get("wallet");
    if (!isPubkey(wallet)) throw new ApiFail(400, "bad_wallet", "wallet");
    // Behind Caddy every client arrives with the proxy header, so a loopback address (or no socket at all: a direct call in a test) is an operator's or a test's own call: not limited.
    const wait = ctx.ip === null || isLoopback(ctx.ip) ? null : nonceLimiter.take(ctx.ip);
    if (wait !== null) return fail(429, "rate_limited", undefined, { "retry-after": String(wait) });
    try {
      return json(issueNonce(wallet));
    } catch (e) {
      if (e instanceof NonceLimitError) throw new ApiFail(429, "rate_limited");
      throw e;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/optin") {
    const body = await readJsonObject(req);
    const wallet = pubkeyField(body, "wallet");
    if (typeof body.zcashAddress !== "string" || body.zcashAddress.length > 2000) throw new ApiFail(400, "bad_address", "zcashAddress");
    const nonce = stringField(body, "nonce", { min: 1, max: 64 });
    const signature = signatureField(body, "signature", "invalid_signature");
    const result = registerOptin(wallet, body.zcashAddress, nonce, signature);
    return result.ok ? json({ ok: true, registeredAt: result.registeredAt }) : fail(400, result.error);
  }
  if (req.method === "DELETE" && url.pathname === "/api/optin") {
    const body = await readJsonObject(req);
    const wallet = pubkeyField(body, "wallet");
    const nonce = stringField(body, "nonce", { min: 1, max: 64 });
    const signature = signatureField(body, "signature", "invalid_signature");
    const result = deregisterOptin(wallet, nonce, signature);
    return result.ok ? json({ ok: true }) : fail(400, result.error);
  }
  // v2.9 (signed reads): whether a wallet opted in, its masked address, what is pending and the shielded rounds it was paid in are shown only to a request that
  // carries the wallet's fresh signature over its own purpose's text. There is no unsigned status route: `GET /api/optin/<wallet>` is a 404 like any unknown path,
  // so nothing about opt-in can be learned from the API by someone who only knows a public key.
  if (req.method === "POST" && url.pathname === "/api/optin/status") {
    const body = await readJsonObject(req);
    const wallet = pubkeyField(body, "wallet");
    const nonce = stringField(body, "nonce", { min: 1, max: 64 });
    const signature = signatureField(body, "signature", "invalid_signature");
    const result = readOptinStatus(wallet, nonce, signature);
    if (!result.ok) return fail(400, result.error);
    const res = json(result.status);
    res.headers.set("cache-control", "no-store");
    return res;
  }
  return fail(404, "not_found");
}

/** Devnet only: anywhere else this route does not exist. */
async function handleFaucet(req: Request): Promise<Response> {
  if (config.mode !== "devnet" || req.method !== "POST") return fail(404, "not_found");
  const body = await readJsonObject(req);
  const wallet = pubkeyField(body, "wallet");
  try {
    return json({ ok: true, ...(await faucetFund(wallet)) });
  } catch (e) {
    if (e instanceof FaucetError && e.code === "bad_wallet") return fail(400, "bad_wallet", "wallet");
    if (e instanceof FaucetError) return fail(e.code === "faucet_cooldown" ? 429 : 503, e.code);
    throw e;
  }
}

function handleEpochs(url: URL): Response {
  const epochs = db.listEpochs().map((e) => {
    const split = epochSplit(e);
    return {
      id: e.id, at: e.at, coinMints: JSON.parse(e.coinMints),
      harvestedZats: e.harvestedZats,
      // What the claims measured on chain this epoch: harvestedZats plus what was held as orphaned proceeds for a coin with no
      // eligible holder (audit S6, lens 2-4: the public record used to show less than the chain showed claimed).
      claimedZats: db.sumConfirmedClaims(e.id).toString(),
      solanaPayouts: summarizePayouts(e.id, "solana"),
      shielded: { ...summarizePayouts(e.id, "shielded"), swap: { provider: e.swapProvider, ref: e.swapRef } },
      feeZats: e.feeZats,
      // Contract v2.6: the two delivery-ledger numbers also at the top level (split carries them as before).
      deliveryCostZats: split.deliveryCostZats,
      teamNetZats: split.teamNetZats,
      status: e.status,
      split,
      snapshot: snapshotSummary(e.id),
    };
  });
  return json({ epochs });
}

const SNAPSHOT_ROUTE = /^\/api\/epochs\/([^/]+)\/snapshot$/;
const RECEIPT_ROUTE = /^\/api\/epochs\/([^/]+)\/receipt$/;

/** GET /api/epochs/:id/snapshot: the stored file byte for byte (its sha256 is the one on chain), or GET .../receipt for a holder's own opening. */
function handleEpochFiles(req: Request, url: URL): Response | null {
  if (req.method !== "GET") return null;
  const file = SNAPSHOT_ROUTE.exec(url.pathname);
  if (file) {
    const snap = db.getEpochSnapshot(decodeURIComponent(file[1]!));
    if (!snap) return fail(404, "no_snapshot");
    return new Response(snap.json, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-snapshot-sha256": snap.sha256, "x-pad-mode": config.mode, ...CORS_HEADERS } });
  }
  const receipt = RECEIPT_ROUTE.exec(url.pathname);
  if (!receipt) return null;
  const wallet = url.searchParams.get("wallet");
  const nonce = url.searchParams.get("nonce");
  const signature = url.searchParams.get("signature");
  if (!isPubkey(wallet)) throw new ApiFail(400, "bad_wallet", "wallet");
  if (!nonce || nonce.length > 64) throw new ApiFail(400, "bad_request", "nonce");
  if (!signature || signature.length > 200) throw new ApiFail(400, "invalid_signature", "signature");
  const result = openReceipt(decodeURIComponent(receipt[1]!), wallet, nonce, signature);
  return result.ok ? json({ rows: result.rows }) : fail(result.error === "no_snapshot" ? 404 : 400, result.error);
}

const paidTotals = makeTtlMemo(() => totalPaidToHolders(), STATS_MAX_AGE_MS);

/** For tests: forget the kept public numbers (24-hour trade stats, paid totals, per-coin rewards, the CSV) so the next request works them out again. */
export function clearStatsCache(): void {
  windowStats.clear();
  paidTotals.clear();
  coinRewards.clear();
  clearTraderCaches();
}

/**
 * GET /api/stats. `coins`, `graduated` and `volume24hZats` are about the coins the board lists (every coin with ?all=1), so the header
 * agrees with the grid under it; the paid totals and `optIns` are the pad's own. A coin counts as graduated once the pad has recorded
 * its move to DAMM v2. Everything comes from the database or a few-second cache, never from the chain.
 */
export function statsView(all: boolean, featured: string[] = config.api.featuredMints) {
  const coins = visibleCoins(db.listCoins().filter((c) => c.status === "launched"), all, featured);
  const market = windowStats.get();
  const volume = coins.reduce((sum, c) => sum + BigInt(market.get(c.mint)?.volume24hZats ?? "0"), 0n);
  return {
    coins: coins.length,
    // A coin counts as graduated once the chain says so (its last view), even before its DAMM pool is recorded (2026-10-12: the header said 0 with a GRADUATED badge on the board).
    graduated: coins.filter((c) => !!c.dammPool || lastKnownView(c)?.stage === "graduated").length,
    volume24hZats: volume.toString(),
    ...paidTotals.get(),
    optIns: db.countActiveOptins(),
  };
}

/** The whole API as one fetch handler (exported so tests can call it without a port). `ctx` says what the server knows about the connection. */
export async function handleRequest(req: Request, ctx: RequestContext = { ip: null }): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    const hosted = servePublicFile(req, url);
    if (hosted) return hosted;
    const upload = await handleUploadRoute(req, url, ctx);
    if (upload) return upload;
    const trader = await handleTraderRoute(req, url, ctx);
    if (trader) return trader;
    const profile = handleWalletRoute(req, url);
    if (profile) return profile;
    if (url.pathname.startsWith("/api/coins")) return await handleCoins(req, url, ctx);
    if (url.pathname.startsWith("/api/optin")) return await handleOptin(req, url, ctx);
    // v2.9.2: `launchpadSigner` is the pad's launch signer, the key every launch carries so terminals can attribute it (null when this instance has none).
    if (url.pathname === "/api/tiers" && req.method === "GET") return json({ tiers: tiersView(), quoteMint: config.solana.dbc.quoteMint.toBase58(), launchpadSigner: launchpadSignerAddress() });
    if (url.pathname === "/api/stats" && req.method === "GET") return json(statsView(url.searchParams.get("all") === "1"));
    if (url.pathname === "/api/faucet") return await handleFaucet(req);
    if (url.pathname === "/api/treasury" && req.method === "GET") return json(await getTreasuryView());
    if (url.pathname === "/api/epochs" && req.method === "GET") return handleEpochs(url);
    if (url.pathname.startsWith("/api/epochs/")) return handleEpochFiles(req, url) ?? fail(404, "not_found");
    return fail(404, "not_found");
  } catch (err) {
    if (err instanceof ApiFail) return fail(err.status, err.code, err.field);
    if (err instanceof PadNotConfiguredError) return fail(503, "not_configured");
    // The RPC answered 429 or 5xx, did not answer in time, or its circuit breaker is open (src/rpcGuard.ts logs that once): never a bare 500 (v2.8.1).
    if (isChainUnavailable(err)) return fail(503, "chain_unavailable");
    // Never send the message or stack: it can carry user input (a Zcash
    // address) or internals. Logged server-side only.
    console.error(`[api] ${req.method} ${url.pathname} failed:`, (err as Error)?.stack ?? err);
    return fail(500, "internal_error");
  }
}

/** After a restart the first coin list should not show holders as unknown: read the board's counts now, in the background. */
function warmHolderCounts(): void {
  for (const c of visibleCoins(db.listCoins().filter((x) => x.status === "launched"), false)) holders.known(c.mint);
}

export function startApiServer(port: number = config.api.port) {
  prepareHostedFiles(); // before listening: a mainnet start with no https PUBLIC_BASE_URL stops here
  const server = Bun.serve({
    port,
    // Default: every interface (a phone on the LAN can reach the devnet demo). On a server set PAD_API_HOST=127.0.0.1
    // so only the reverse proxy on the same machine can reach it (ops/DEPLOY.md).
    hostname: process.env.PAD_API_HOST ?? "0.0.0.0",
    // Bodies are streamed with a 16 KiB cap (validate.ts readCapped), which
    // answers with a JSON body_too_large. Bun's own transport cap (default
    // 128 MiB) only matters above that and answers a bare 413.
    fetch: (req, srv) => handleRequest(req, { ip: clientIp(req.headers.get("x-forwarded-for"), srv.requestIP(req)?.address ?? null), keepOpen: () => srv.timeout(req, 0) }),
    error() {
      return fail(500, "internal_error");
    },
  });
  warmHolderCounts();
  startPublicFilesSweep();
  startLaunchReconciler();
  startMigrationReconciler();
  startTradeIndexer();
  return server;
}
