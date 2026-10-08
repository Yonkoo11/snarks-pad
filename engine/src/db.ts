// bun:sqlite persistence. Amounts are stored as TEXT (bigint-safe). One file per
// PAD_MODE (config.paths.dbFile), so local/devnet/mainnet never share state.
import { Database } from "bun:sqlite";
import { config } from "./config";
import type { RpcUsageRow } from "./rpcUsage";
import { redactSecrets } from "./util/redact";

export interface CoinRow {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string;
  description: string;
  creator: string;
  createdAt: string;
  feeBps: number;
  poolId: string | null;
  mintDecimals: number;
  status: "pending" | "launched";
  // Meteora DBC bookkeeping (optional so a row can be built without them).
  configId?: string | null; // the DBC config this coin was launched under
  dammPool?: string | null; // DAMM v2 pool, set once the coin has migrated
  positionNft?: string | null; // the partner's permanently locked LP position (fee_claimer owns it)
  migratedAt?: string | null;
  // The creator's links as JSON ({ website?, x?, telegram? }, each an https address), written at launch and never changed (contract v2.7);
  // null for a coin launched before then. Read it through readStoredSocials (src/socials.ts).
  socials?: string | null;
  // The Creator wallet asked for at launch (contract v2.8): the pool was handed to it in the launch transaction, so it receives the creator's share of the fee and is
  // the only wallet that can claim it. null when none was asked for (the launcher stays the pool's creator). The coin's view reads the pool's creator from the chain.
  creatorWallet?: string | null;
  // The launch window's facts (contract v2.8.1), so the window and the fee a trade pays now are worked out with no chain read: the base-fee schedule of the coin's
  // config as JSON (dbc/window.ts scheduleToJson; written at launch) and its pool's activation point as a decimal string (written at confirm). Neither ever changes;
  // a coin from before v2.8.1 gets them from its first chain read after (dbc/read.ts). null until then.
  feeSchedule?: string | null;
  activationPoint?: string | null;
}

export interface TradeRow {
  sig: string;
  mint: string;
  side: "buy" | "sell";
  wallet: string;
  amountToken: string;
  amountZec: string;
  at: string;
}

export interface OptinRow {
  wallet: string;
  zcashAddress: string;
  registeredAt: string;
  active: 0 | 1;
}

// "harvesting": draft epoch, still collecting per-coin fee claims
// (src/epoch/engine.ts claimRemainingCoins). Never shown on the public
// treasury/epochs endpoints until it leaves this state.
// "needs_attention": an epoch that stayed unfinished past the attempt/age bound (audit O-2). It is parked: its
// rows stay unsent and counted as owed, it is still progressed on every run, but it no longer blocks later
// epochs (src/epoch/engine.ts parkIfStuck / haltedByParkedEpochs).
export type EpochStatus = "harvesting" | "ok" | "partial" | "fallback_solana" | "needs_attention";
// Swap-leg state machine (src/epoch/engine.ts progressSwap):
//   none -> submitted(ref) -> settled(amountOut)
//               \-> (never falls back once submitted)
//   none -> failed_before_funds_moved (safe to fall back to Solana ZEC)
//   submitted -> returned_to_keeper (1Click refunded, and the refund is on chain: safe to fall back)
export type SwapState = "none" | "submitted" | "settled" | "failed_before_funds_moved" | "returned_to_keeper";

export interface EpochRow {
  id: string;
  at: string;
  coinMints: string; // json string[]
  harvestedZats: string;
  feeZats: string;
  status: EpochStatus;
  swapProvider: string | null;
  swapRef: string | null;
  swapState: SwapState;
  swapAmountOutZats: string | null;
  zcashTxids: string; // json string[]
  // Optional: managed by their own functions below, never overwritten by upsertEpoch's update half.
  attempts?: number; // runs that ended with this epoch still unfinished (audit O-2)
  unfinishedSince?: string | null; // when the first such run ended: the stuck age counts from here, not from the draft (audit S6)
  parkedAt?: string | null;
  attentionReason?: string | null;
  includeShielded?: number; // 1 = this epoch also runs the shielded leg; 0 = opted-in shares are carried (plan 4b: shielded weekly)
  // Business-model ledger (src/epoch/split.ts), written by setEpochTeamSplit / resolveEpochDelivery, never by upsertEpoch.
  teamGrossZats?: string; // the team's 25% of what this epoch claimed
  deliveryReserveZats?: string; // what the team put into the swap to cover shielded-delivery costs (0 when no shielded leg)
  deliveryCostZats?: string | null; // reserve - what came back as native ZEC; null until the delivery is resolved
  teamNativeZats?: string; // native ZEC left in the treasury wallet after delivery: the team's
  teamSolanaZats?: string | null; // the team's Solana ZEC from this epoch; null until the delivery is resolved
  holderShortfallZats?: string; // cost beyond the reserve, borne by shielded holders pro rata
}

export type PayoutKind = "solana" | "shielded" | "team";
export type CarryKind = "solana" | "shielded"; // team money is never carried per wallet: its ledger is on the epochs

export interface PayoutRow {
  epochId: string;
  wallet: string;
  kind: PayoutKind;
  amountZats: string;
  // Snapshotted at planning time for kind="shielded" (never re-read from the
  // live opt-in registry at send time): an opt-out mid-epoch must not change
  // where an already-planned payout goes (see engine/README.md).
  zcashAddress: string | null;
  // Set the moment a signature/txid is known -- BEFORE broadcast for Solana
  // (sign-then-store), right after devtool returns it for Zcash -- so a crash
  // between "sent" and "recorded" resumes by checking this signature's chain
  // status instead of blindly resending. sentAt is set only once that status
  // check (or the original send) confirms landing.
  sig: string | null;
  sentAt: string | null;
  // Solana rails only: the exact signed bytes behind a pending `sig` and their
  // blockhash's last valid block height (audit S2-01). Resume rebroadcasts these
  // bytes while the blockhash lives and clears the row only once it provably
  // cannot land, never on a single "not seen yet" status read.
  rawTx?: string | null;
  lastValidBlockHeight?: number | null;
  // "creator_first_buy" when the wallet is the creator of a coin in this
  // epoch: the creator is paid like any holder (plan decision), and this
  // flag is how the ledger shows it.
  flag?: string | null;
}

export interface DbcConfigRow {
  configId: string;
  feeBps: number;
  feeClaimer: string;
  migrationQuoteThreshold: string;
  dammConfig: string;
  poolCreationFeeLamports: string;
  createdAt: string;
}

export type ClaimKind = "trading" | "damm_position" | "surplus";

// sign -> persist -> broadcast (same pattern as the payouts): the claim's own
// signature and signed bytes are durable BEFORE it is broadcast, so a crash
// resumes by checking that signature's chain status instead of claiming twice.
export interface ClaimProgressRow {
  epochId: string;
  mint: string;
  kind: ClaimKind;
  sig: string;
  rawTx: string; // base64 of the fully signed transaction
  lastValidBlockHeight: number;
  status: "signed" | "confirmed";
  amountZats: string | null; // measured from the claim tx's own balance delta, set when confirmed
  // Which transaction `sig`/`rawTx` is. A keypair claimer has only "single"
  // (the claim itself). A Squads vault claim goes "propose" (the transaction
  // that creates the vault transaction + proposal) -> "await" (proposal is on
  // chain, owner approval pending, nothing in flight) -> "execute" (the
  // executing transaction); `ref` carries the proposal's transaction index and
  // a fingerprint of the message the keeper wrote (src/dbc/squads.ts).
  phase: ClaimPhase;
  ref: string | null;
}

export type ClaimPhase = "single" | "propose" | "await" | "execute";

export interface EpochCoinHarvestRow {
  epochId: string;
  mint: string;
  soldForZatsQuote: string; // what the coin claimed (plus any proceeds orphaned earlier): holders + team
  teamZats: string; // the team's share of it (src/epoch/split.ts); the holders' shares sum to soldForZatsQuote - teamZats
}

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  db = new Database(config.paths.dbFile, { create: true });
  // The keeper and the API are separate processes on this file: a write that meets the other's open write
  // transaction waits up to 15 s instead of failing at once with "database is locked" (stress run D5).
  db.exec("PRAGMA busy_timeout = 15000;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

/** Additive migration: adds `column` to `table` if an older database doesn't have it yet. */
function ensureColumn(d: Database, table: string, column: string, decl: string): void {
  const cols = d.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrate(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS coins (
      mint TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL,
      imageUrl TEXT NOT NULL, description TEXT NOT NULL, creator TEXT NOT NULL,
      createdAt TEXT NOT NULL, feeBps INTEGER NOT NULL, poolId TEXT,
      mintDecimals INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS trades (
      sig TEXT PRIMARY KEY, mint TEXT NOT NULL, side TEXT NOT NULL, wallet TEXT NOT NULL,
      amountToken TEXT NOT NULL, amountZec TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trades_mint ON trades(mint);
    CREATE INDEX IF NOT EXISTS trades_at ON trades(at);
    CREATE INDEX IF NOT EXISTS trades_mint_at ON trades(mint, at);
    CREATE INDEX IF NOT EXISTS trades_wallet_at ON trades(wallet, at);
    CREATE TABLE IF NOT EXISTS nonces (
      wallet TEXT NOT NULL, nonce TEXT NOT NULL, message TEXT NOT NULL,
      issuedAt TEXT NOT NULL, usedAt TEXT, PRIMARY KEY (wallet, nonce)
    );
    CREATE TABLE IF NOT EXISTS optins (
      wallet TEXT PRIMARY KEY, zcashAddress TEXT NOT NULL,
      registeredAt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS dbc_configs (
      configId TEXT PRIMARY KEY, feeBps INTEGER NOT NULL, feeClaimer TEXT NOT NULL,
      migrationQuoteThreshold TEXT NOT NULL, dammConfig TEXT NOT NULL,
      poolCreationFeeLamports TEXT NOT NULL DEFAULT '0', createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claim_progress (
      epochId TEXT NOT NULL, mint TEXT NOT NULL, kind TEXT NOT NULL,
      sig TEXT NOT NULL, rawTx TEXT NOT NULL, lastValidBlockHeight INTEGER NOT NULL,
      status TEXT NOT NULL, amountZats TEXT, at TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'single', ref TEXT,
      PRIMARY KEY (epochId, mint, kind)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS faucet_claims (
      wallet TEXT PRIMARY KEY, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS epochs (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, coinMints TEXT NOT NULL,
      harvestedZats TEXT NOT NULL, feeZats TEXT NOT NULL, status TEXT NOT NULL,
      swapProvider TEXT, swapRef TEXT, zcashTxids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS payouts (
      epochId TEXT NOT NULL, wallet TEXT NOT NULL, kind TEXT NOT NULL,
      amountZats TEXT NOT NULL, sig TEXT, sentAt TEXT,
      PRIMARY KEY (epochId, wallet, kind)
    );
    CREATE INDEX IF NOT EXISTS payouts_wallet ON payouts(wallet);
    CREATE TABLE IF NOT EXISTS carry (
      wallet TEXT NOT NULL, kind TEXT NOT NULL, amountZats TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (wallet, kind)
    );
    -- Per-coin harvest+sell result, persisted the moment that coin's sale
    -- lands (engine/README.md "Harvest resume"): a crash mid-epoch never
    -- loses which coins were already sold, and never re-snapshots a coin's
    -- holders (which would give a different, non-reproducible split).
    CREATE TABLE IF NOT EXISTS epoch_coin_harvests (
      epochId TEXT NOT NULL, mint TEXT NOT NULL, soldForZatsQuote TEXT NOT NULL,
      at TEXT NOT NULL, PRIMARY KEY (epochId, mint)
    );
    CREATE TABLE IF NOT EXISTS epoch_coin_shares (
      epochId TEXT NOT NULL, mint TEXT NOT NULL, wallet TEXT NOT NULL, amountZats TEXT NOT NULL,
      PRIMARY KEY (epochId, mint, wallet)
    );
    -- DB-backed exclusive lock with stale-lock takeover (src/epoch/engine.ts
    -- runEpoch): only one epoch run proceeds at a time.
    CREATE TABLE IF NOT EXISTS locks (
      name TEXT PRIMARY KEY, holder TEXT NOT NULL, acquiredAt TEXT NOT NULL
    );
    -- Adapter-side swap state, keyed by the swap's own ref (the Solana burn
    -- signature): persisted the instant the burn is SIGNED, before it is even
    -- broadcast, so a crash between signing and confirming can resume by
    -- re-broadcasting the exact same signed bytes (Solana dedups by
    -- signature, so replaying it can never cause a second burn) instead of
    -- risking a second, distinct burn. Lets SwapAdapter.status() be called any
    -- number of times without re-running the funds-settling side effect twice
    -- (src/swap/simulated.ts).
    CREATE TABLE IF NOT EXISTS swap_progress (
      ref TEXT PRIMARY KEY, status TEXT NOT NULL, amountInZats TEXT NOT NULL,
      rawTxBase64 TEXT, amountOutZats TEXT, payTxid TEXT, at TEXT NOT NULL
    );
    -- NEAR 1Click adapter state (src/swap/near1click.ts), keyed by the epoch id
    -- (the idempotency key), so a restart finds the swap it already started
    -- instead of asking for a second quote. Phases only move forward:
    -- quoted -> signed -> deposited -> settled | returned, or signed -> no_deposit.
    -- Nothing is ever deleted: the signed bytes are the proof a deposit may exist.
    CREATE TABLE IF NOT EXISTS near1click_swaps (
      key TEXT PRIMARY KEY, phase TEXT NOT NULL, amountInZats TEXT NOT NULL,
      keeper TEXT NOT NULL, recipient TEXT NOT NULL,
      quoteJson TEXT NOT NULL, depositAddress TEXT NOT NULL UNIQUE,
      requestDeadline TEXT NOT NULL, quoteDeadline TEXT NOT NULL,
      signature TEXT, rawTxBase64 TEXT, lastValidBlockHeight INTEGER, signedAt TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      amountOutZats TEXT, destinationTxids TEXT, refundSig TEXT, note TEXT,
      at TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    -- A coin whose holder snapshot came back empty (every holder excluded,
    -- e.g. all supply sits in pool vaults) still gets sold for real zats each
    -- epoch; with nobody to pay, those zats would otherwise be silently
    -- unattributed forever (finding 10). Held here and folded into that same
    -- coin's next harvest that DOES have eligible holders, instead of being
    -- recorded as paid to no one.
    CREATE TABLE IF NOT EXISTS coin_orphaned_zats (
      mint TEXT PRIMARY KEY, amountZats TEXT NOT NULL DEFAULT '0'
    );
    -- Holder samples taken at random times inside an epoch window (audit O-1,
    -- src/epoch/snapshots.ts): a holder's reward weight is the least balance
    -- it showed in any of them, so a buy just before the epoch run and a sell
    -- just after earns nothing. One row per coin per sample time; \`holders\`
    -- is JSON [[wallet, balance], ...] of the eligible holders at that instant.
    CREATE TABLE IF NOT EXISTS holder_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, takenAt TEXT NOT NULL, holders TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS holder_samples_mint ON holder_samples(mint, takenAt);
  `);
  ensureColumn(d, "epochs", "swapState", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(d, "epochs", "swapAmountOutZats", "TEXT");
  ensureColumn(d, "epochs", "attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(d, "epochs", "parkedAt", "TEXT");
  ensureColumn(d, "epochs", "unfinishedSince", "TEXT");
  ensureColumn(d, "epochs", "attentionReason", "TEXT");
  ensureColumn(d, "epochs", "includeShielded", "INTEGER NOT NULL DEFAULT 1");
  d.exec(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, epochId TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL, resolvedAt TEXT
  )`);
  // What each process's RPC guard counted, one row per UTC hour, process ("api" or "keeper") and method (src/rpcUsage.ts, src/rpcBudget.ts).
  d.exec(`CREATE TABLE IF NOT EXISTS rpc_usage (
    hour_utc TEXT NOT NULL, process TEXT NOT NULL, method TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_utc, process, method)
  )`);
  d.exec(`CREATE TABLE IF NOT EXISTS epoch_snapshots (
    epochId TEXT PRIMARY KEY, json TEXT NOT NULL, sha256 TEXT NOT NULL, shieldedWallets TEXT NOT NULL, createdAt TEXT NOT NULL,
    memoSig TEXT, memoRawTx TEXT, memoLastValidBlockHeight INTEGER, memoAt TEXT
  )`);
  ensureColumn(d, "epochs", "teamGrossZats", "TEXT NOT NULL DEFAULT '0'");
  ensureColumn(d, "epochs", "deliveryReserveZats", "TEXT NOT NULL DEFAULT '0'");
  ensureColumn(d, "epochs", "deliveryCostZats", "TEXT");
  ensureColumn(d, "epochs", "teamNativeZats", "TEXT NOT NULL DEFAULT '0'");
  ensureColumn(d, "epochs", "teamSolanaZats", "TEXT");
  ensureColumn(d, "epochs", "holderShortfallZats", "TEXT NOT NULL DEFAULT '0'");
  ensureColumn(d, "epoch_coin_harvests", "teamZats", "TEXT NOT NULL DEFAULT '0'");
  ensureColumn(d, "epoch_coin_shares", "weightRaw", "TEXT");
  ensureColumn(d, "payouts", "zcashAddress", "TEXT");
  ensureColumn(d, "payouts", "flag", "TEXT");
  ensureColumn(d, "payouts", "rawTx", "TEXT");
  ensureColumn(d, "payouts", "lastValidBlockHeight", "INTEGER");
  // Recipient token accounts whose rent the keeper paid (audit S2-04): a wallet
  // that closes one to pocket the rent is never given a second one.
  d.exec("CREATE TABLE IF NOT EXISTS keeper_funded_atas (ata TEXT PRIMARY KEY, wallet TEXT NOT NULL, at TEXT NOT NULL)");
  ensureColumn(d, "claim_progress", "phase", "TEXT NOT NULL DEFAULT 'single'");
  ensureColumn(d, "claim_progress", "ref", "TEXT");
  for (const col of ["configId", "dammPool", "positionNft", "migratedAt", "socials", "creatorWallet", "feeSchedule", "activationPoint"]) ensureColumn(d, "coins", col, "TEXT");
  // Since when a coin's orphaned bucket has held money (audit S6, product decision 1: released into a paying round after
  // config.epoch.orphanReleaseDays). A bucket that already holds money when this column arrives counts from now.
  ensureColumn(d, "coin_orphaned_zats", "sinceAt", "TEXT");
  d.query("UPDATE coin_orphaned_zats SET sinceAt = $now WHERE sinceAt IS NULL AND amountZats != '0'").run({ $now: new Date().toISOString() });
}

// ---- coins ----
export function upsertCoin(c: CoinRow): void {
  getDb()
    .query(
      `INSERT INTO coins (mint,name,symbol,imageUrl,description,creator,createdAt,feeBps,poolId,mintDecimals,status,configId,socials,creatorWallet,feeSchedule)
       VALUES ($mint,$name,$symbol,$imageUrl,$description,$creator,$createdAt,$feeBps,$poolId,$mintDecimals,$status,$configId,$socials,$creatorWallet,$feeSchedule)
       ON CONFLICT(mint) DO UPDATE SET poolId=excluded.poolId, status=excluded.status`,
    )
    .run({
      $mint: c.mint, $name: c.name, $symbol: c.symbol, $imageUrl: c.imageUrl, $description: c.description,
      $creator: c.creator, $createdAt: c.createdAt, $feeBps: c.feeBps, $poolId: c.poolId,
      $mintDecimals: c.mintDecimals, $status: c.status, $configId: c.configId ?? null, $socials: c.socials ?? null, $creatorWallet: c.creatorWallet ?? null,
      $feeSchedule: c.feeSchedule ?? null,
    });
}

/** Fills in a coin's launch-window facts where its row has none yet (contract v2.8.1). A stored fact is never overwritten: neither can change. */
export function fillCoinWindowFacts(mint: string, feeSchedule: string, activationPoint: string): void {
  getDb()
    .query("UPDATE coins SET feeSchedule = COALESCE(feeSchedule, $s), activationPoint = COALESCE(activationPoint, $a) WHERE mint = $m")
    .run({ $s: feeSchedule, $a: activationPoint, $m: mint });
}

export function getCoin(mint: string): CoinRow | null {
  return getDb().query("SELECT * FROM coins WHERE mint = $mint").get({ $mint: mint }) as CoinRow | null;
}

export function listCoins(): CoinRow[] {
  return getDb().query("SELECT * FROM coins ORDER BY createdAt DESC").all() as CoinRow[];
}

/** The launched coins a wallet launched or was named the Creator wallet of at launch (contract v2.8), newest first. Pending launches are never in it. */
export function listLaunchedCoinsOfWallet(wallet: string): CoinRow[] {
  return getDb()
    .query("SELECT * FROM coins WHERE status = 'launched' AND (creator = $w OR creatorWallet = $w) ORDER BY createdAt DESC, mint ASC")
    .all({ $w: wallet }) as CoinRow[];
}

/** Each coin's image address with its status and age: what decides whether an uploaded file is still in use (the sweep). */
export function listCoinImageRefs(): { imageUrl: string; status: CoinRow["status"]; createdAt: string }[] {
  return getDb().query("SELECT imageUrl, status, createdAt FROM coins").all() as { imageUrl: string; status: CoinRow["status"]; createdAt: string }[];
}

/** Launches prepared before `beforeIso` and never confirmed, oldest first: what the sweep drops (S4-05). */
export function listStalePendingCoins(beforeIso: string): { mint: string; createdAt: string }[] {
  return getDb().query("SELECT mint, createdAt FROM coins WHERE status = 'pending' AND createdAt < $b ORDER BY createdAt ASC").all({ $b: beforeIso }) as { mint: string; createdAt: string }[];
}

/** How many launches are prepared and not yet confirmed (the cap on POST /coins/launch-tx counts them). */
export function countPendingCoins(): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM coins WHERE status = 'pending'").get() as { n: number }).n;
}

/** Unconfirmed launches prepared at or after `sinceIso`: the ones whose transaction may still land (src/api/launchLimits.ts). */
export function countPendingCoinsSince(sinceIso: string): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM coins WHERE status = 'pending' AND createdAt >= $s").get({ $s: sinceIso }) as { n: number }).n;
}

/** Removes a coin row that is still unconfirmed; false when there was none to remove (it was confirmed meanwhile, or never existed). */
export function deleteUnconfirmedCoin(mint: string): boolean {
  return getDb().query("DELETE FROM coins WHERE mint = $m AND status = 'pending'").run({ $m: mint }).changes > 0;
}

/** The status and age of every coin whose picture is the stored upload `name` (a stored name is only ever 24 hex digits and an extension, so it is no LIKE pattern). */
export function listCoinsNamingImage(name: string): { status: CoinRow["status"]; createdAt: string }[] {
  return getDb().query("SELECT status, createdAt FROM coins WHERE imageUrl LIKE $p").all({ $p: `%/i/${name}` }) as { status: CoinRow["status"]; createdAt: string }[];
}

/** Records the DAMM v2 pool and the partner LP position once a coin has migrated. Idempotent. */
export function markCoinMigrated(mint: string, dammPool: string, positionNft: string | null): void {
  getDb()
    .query("UPDATE coins SET dammPool = $d, positionNft = $p, migratedAt = COALESCE(migratedAt, $at) WHERE mint = $m")
    .run({ $d: dammPool, $p: positionNft, $at: new Date().toISOString(), $m: mint });
}

/** `activationPoint`: the pool's, when the confirm could read it (contract v2.8.1); an activation point already stored is kept. */
export function markCoinLaunched(mint: string, poolId: string, activationPoint: string | null = null): void {
  getDb()
    .query("UPDATE coins SET status = 'launched', poolId = $poolId, activationPoint = COALESCE(activationPoint, $activation) WHERE mint = $mint")
    .run({ $poolId: poolId, $activation: activationPoint, $mint: mint });
}

// ---- trades ----
export function insertTrade(t: TradeRow): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO trades (sig,mint,side,wallet,amountToken,amountZec,at)
       VALUES ($sig,$mint,$side,$wallet,$amountToken,$amountZec,$at)`,
    )
    .run({
      $sig: t.sig, $mint: t.mint, $side: t.side, $wallet: t.wallet,
      $amountToken: t.amountToken, $amountZec: t.amountZec, $at: t.at,
    });
}

export function listTradesForMint(mint: string, limit = 20): TradeRow[] {
  return getDb()
    .query("SELECT * FROM trades WHERE mint = $mint ORDER BY at DESC LIMIT $limit")
    .all({ $mint: mint, $limit: limit }) as TradeRow[];
}

/** The newest `limit` trades of a coin, oldest first: what a price chart draws. */
export function listTradesAscending(mint: string, limit: number): TradeRow[] {
  return getDb()
    .query("SELECT * FROM (SELECT * FROM trades WHERE mint = $mint ORDER BY at DESC, sig DESC LIMIT $limit) ORDER BY at ASC, sig ASC")
    .all({ $mint: mint, $limit: limit }) as TradeRow[];
}

export type RecordedTrade = Pick<TradeRow, "mint" | "side" | "amountToken" | "amountZec" | "at">;

/**
 * Every recorded trade, of every coin, at or after `sinceIso`, oldest first (same order as the price chart: time, then
 * signature). `at` is always written with toISOString(), so an ISO time compares like the stored ones.
 */
export function listTradesSince(sinceIso: string): RecordedTrade[] {
  return getDb()
    .query("SELECT mint, side, amountToken, amountZec, at FROM trades WHERE at >= $since ORDER BY at ASC, sig ASC")
    .all({ $since: sinceIso }) as RecordedTrade[];
}

/** A recorded trade with its coin's symbol and creator, and its arrival number (the table's rowid: the order the engine recorded them in). */
export interface FeedTradeRow extends TradeRow {
  n: number;
  symbol: string;
  creator: string;
}

const FEED_COLUMNS =
  "t.rowid AS n, t.sig AS sig, t.mint AS mint, t.side AS side, t.wallet AS wallet, t.amountToken AS amountToken, t.amountZec AS amountZec, t.at AS at, c.symbol AS symbol, c.creator AS creator";

/** `AND t.mint IN (?, ...)` for a board filter, with its bound values; nothing for null (every coin). */
function mintFilter(mints: string[] | null): { sql: string; params: Record<string, string> } {
  if (mints === null) return { sql: "", params: {} };
  const params: Record<string, string> = {};
  mints.forEach((m, i) => (params[`$m${i}`] = m));
  return { sql: mints.length === 0 ? " AND 0" : ` AND t.mint IN (${mints.map((_, i) => `$m${i}`).join(",")})`, params };
}

/** The newest recorded trades of launched coins, newest first (by time, then signature). `mints` limits them to those coins, null = all. */
export function listRecentFeedTrades(limit: number, mints: string[] | null): FeedTradeRow[] {
  const f = mintFilter(mints);
  return getDb()
    .query(`SELECT ${FEED_COLUMNS} FROM trades t JOIN coins c ON c.mint = t.mint WHERE c.status = 'launched'${f.sql} ORDER BY t.at DESC, t.sig DESC LIMIT $limit`)
    .all({ ...f.params, $limit: limit }) as FeedTradeRow[];
}

/** One coin's newest recorded trades, newest first. */
export function listFeedTradesForMint(mint: string, limit: number): FeedTradeRow[] {
  return getDb()
    .query(`SELECT ${FEED_COLUMNS} FROM trades t JOIN coins c ON c.mint = t.mint WHERE t.mint = $mint AND c.status = 'launched' ORDER BY t.at DESC, t.sig DESC LIMIT $limit`)
    .all({ $mint: mint, $limit: limit }) as FeedTradeRow[];
}

/** The newest `limit` recorded trades the wallet made on launched coins, newest first (by time, then signature). `mints` limits them to those coins, null = all. */
export function listFeedTradesOfWallet(wallet: string, limit: number, mints: string[] | null): FeedTradeRow[] {
  const f = mintFilter(mints);
  return getDb()
    .query(`SELECT ${FEED_COLUMNS} FROM trades t JOIN coins c ON c.mint = t.mint WHERE t.wallet = $wallet AND c.status = 'launched'${f.sql} ORDER BY t.at DESC, t.sig DESC LIMIT $limit`)
    .all({ ...f.params, $wallet: wallet, $limit: limit }) as FeedTradeRow[];
}

/** When the wallet first traded on a launched coin (`mints` as above); null when it has not. */
export function firstTradeAtOfWallet(wallet: string, mints: string[] | null): string | null {
  const f = mintFilter(mints);
  const row = getDb()
    .query(`SELECT MIN(t.at) AS at FROM trades t JOIN coins c ON c.mint = t.mint WHERE t.wallet = $wallet AND c.status = 'launched'${f.sql}`)
    .get({ ...f.params, $wallet: wallet }) as { at: string | null };
  return row.at;
}

/** The arrival number of the newest recorded trade (0 when there is none). */
export function maxTradeArrival(): number {
  return (getDb().query("SELECT COALESCE(MAX(rowid), 0) AS n FROM trades").get() as { n: number }).n;
}

/** Trades recorded after arrival number `afterN`, in arrival order, at most `limit` (the oldest of them first). `mints` as above. */
export function listFeedTradesAfter(afterN: number, limit: number, mints: string[] | null): FeedTradeRow[] {
  const f = mintFilter(mints);
  return getDb()
    .query(`SELECT ${FEED_COLUMNS} FROM trades t JOIN coins c ON c.mint = t.mint WHERE t.rowid > $after AND c.status = 'launched'${f.sql} ORDER BY t.rowid ASC LIMIT $limit`)
    .all({ ...f.params, $after: afterN, $limit: limit }) as FeedTradeRow[];
}

/** The newest `limit` trades recorded after arrival number `afterN` and up to `upToN`, in arrival order: what a reconnecting stream replays. */
export function listFeedTradesBetween(afterN: number, upToN: number, limit: number, mints: string[] | null): FeedTradeRow[] {
  const f = mintFilter(mints);
  return getDb()
    .query(
      `SELECT * FROM (SELECT ${FEED_COLUMNS} FROM trades t JOIN coins c ON c.mint = t.mint WHERE t.rowid > $after AND t.rowid <= $upTo AND c.status = 'launched'${f.sql}
         ORDER BY t.rowid DESC LIMIT $limit) ORDER BY n ASC`,
    )
    .all({ ...f.params, $after: afterN, $upTo: upToN, $limit: limit }) as FeedTradeRow[];
}

// ---- nonces ----
export function createNonce(wallet: string, nonce: string, message: string): void {
  getDb()
    .query("INSERT INTO nonces (wallet,nonce,message,issuedAt) VALUES ($wallet,$nonce,$message,$issuedAt)")
    .run({ $wallet: wallet, $nonce: nonce, $message: message, $issuedAt: new Date().toISOString() });
}

/**
 * Bounds the nonces table (audit S2-09): drops every nonce past its useful age,
 * and keeps at most `perWallet` unused ones for `wallet` (newest kept).
 * Returns how many live (unexpired) nonces remain in total.
 */
/** Drops every nonce older than `maxAgeMs` (used or not) and returns how many rows remain in all. */
export function pruneExpiredNonces(maxAgeMs: number): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  getDb().query("DELETE FROM nonces WHERE issuedAt < $c").run({ $c: cutoff });
  return (getDb().query("SELECT COUNT(*) AS n FROM nonces").get() as { n: number }).n;
}

/** True iff `nonce` was issued to `wallet`, is unused and not older than `maxAgeMs`. Reads only. */
export function nonceUsable(wallet: string, nonce: string, maxAgeMs: number): boolean {
  const row = getDb().query("SELECT issuedAt, usedAt FROM nonces WHERE wallet = $wallet AND nonce = $nonce").get({ $wallet: wallet, $nonce: nonce }) as
    | { issuedAt: string; usedAt: string | null }
    | null;
  return !!row && !row.usedAt && Date.now() - Date.parse(row.issuedAt) <= maxAgeMs;
}

/** Consumes a nonce exactly once. Returns the message it was issued for, or null if unknown/used/stale. */
export function consumeNonce(wallet: string, nonce: string, maxAgeMs: number): string | null {
  const row = getDb()
    .query("SELECT message, issuedAt, usedAt FROM nonces WHERE wallet = $wallet AND nonce = $nonce")
    .get({ $wallet: wallet, $nonce: nonce }) as { message: string; issuedAt: string; usedAt: string | null } | null;
  if (!row || row.usedAt) return null;
  if (Date.now() - Date.parse(row.issuedAt) > maxAgeMs) return null;
  getDb()
    .query("UPDATE nonces SET usedAt = $now WHERE wallet = $wallet AND nonce = $nonce")
    .run({ $now: new Date().toISOString(), $wallet: wallet, $nonce: nonce });
  return row.message;
}

// ---- optins ----
export function upsertOptin(wallet: string, zcashAddress: string): void {
  getDb()
    .query(
      `INSERT INTO optins (wallet,zcashAddress,registeredAt,active) VALUES ($wallet,$addr,$at,1)
       ON CONFLICT(wallet) DO UPDATE SET zcashAddress=excluded.zcashAddress, registeredAt=excluded.registeredAt, active=1`,
    )
    .run({ $wallet: wallet, $addr: zcashAddress, $at: new Date().toISOString() });
}

export function deactivateOptin(wallet: string): void {
  getDb().query("UPDATE optins SET active = 0 WHERE wallet = $wallet").run({ $wallet: wallet });
}

export function getOptin(wallet: string): OptinRow | null {
  return getDb().query("SELECT * FROM optins WHERE wallet = $wallet").get({ $wallet: wallet }) as OptinRow | null;
}

export function listActiveOptins(): OptinRow[] {
  return getDb().query("SELECT * FROM optins WHERE active = 1").all() as OptinRow[];
}

/** How many wallets have shielded delivery on right now (a count only: the rows carry the Zcash addresses). */
export function countActiveOptins(): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM optins WHERE active = 1").get() as { n: number }).n;
}

// ---- dbc configs ----
export function insertDbcConfig(c: DbcConfigRow): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO dbc_configs (configId,feeBps,feeClaimer,migrationQuoteThreshold,dammConfig,poolCreationFeeLamports,createdAt)
       VALUES ($id,$fee,$claimer,$threshold,$damm,$creation,$at)`,
    )
    .run({
      $id: c.configId, $fee: c.feeBps, $claimer: c.feeClaimer, $threshold: c.migrationQuoteThreshold,
      $damm: c.dammConfig, $creation: c.poolCreationFeeLamports, $at: c.createdAt,
    });
}

export function getDbcConfig(configId: string): DbcConfigRow | null {
  return getDb().query("SELECT * FROM dbc_configs WHERE configId = $id").get({ $id: configId }) as DbcConfigRow | null;
}

export function listDbcConfigs(): DbcConfigRow[] {
  return getDb().query("SELECT * FROM dbc_configs ORDER BY createdAt DESC").all() as DbcConfigRow[];
}

/** The newest config: the one new launches use. */
export function getLatestDbcConfig(): DbcConfigRow | null {
  return getDb().query("SELECT * FROM dbc_configs ORDER BY createdAt DESC LIMIT 1").get() as DbcConfigRow | null;
}

// ---- claim progress (sign -> persist -> broadcast) ----
export function getClaimProgress(epochId: string, mint: string, kind: ClaimKind): ClaimProgressRow | null {
  return getDb()
    .query("SELECT * FROM claim_progress WHERE epochId = $e AND mint = $m AND kind = $k")
    .get({ $e: epochId, $m: mint, $k: kind }) as ClaimProgressRow | null;
}

/**
 * Durable BEFORE the transaction is broadcast. A call for a (epoch, coin, kind)
 * that already has a row REPLACES it only when the stored row is a "signed"
 * one for an earlier phase (propose -> execute); a confirmed row is never touched.
 */
export function recordClaimSigned(p: Omit<ClaimProgressRow, "status" | "amountZats" | "phase" | "ref"> & { phase?: ClaimPhase; ref?: string | null }): void {
  getDb()
    .query(
      `INSERT INTO claim_progress (epochId,mint,kind,sig,rawTx,lastValidBlockHeight,status,amountZats,at,phase,ref)
       VALUES ($e,$m,$k,$sig,$raw,$h,'signed',NULL,$at,$phase,$ref)
       ON CONFLICT(epochId,mint,kind) DO NOTHING`,
    )
    .run({
      $e: p.epochId, $m: p.mint, $k: p.kind, $sig: p.sig, $raw: p.rawTx, $h: p.lastValidBlockHeight,
      $at: new Date().toISOString(), $phase: p.phase ?? "single", $ref: p.ref ?? null,
    });
}

/** Replaces the transaction in flight for a claim that is not confirmed yet (propose -> execute). Never touches a confirmed row. */
export function replaceClaimTx(p: { epochId: string; mint: string; kind: ClaimKind; sig: string; rawTx: string; lastValidBlockHeight: number; phase: ClaimPhase }): void {
  getDb()
    .query(
      `UPDATE claim_progress SET sig = $sig, rawTx = $raw, lastValidBlockHeight = $h, phase = $phase, at = $at
       WHERE epochId = $e AND mint = $m AND kind = $k AND status = 'signed'`,
    )
    .run({ $sig: p.sig, $raw: p.rawTx, $h: p.lastValidBlockHeight, $phase: p.phase, $at: new Date().toISOString(), $e: p.epochId, $m: p.mint, $k: p.kind });
}

/** Moves a claim between phases without a new transaction (e.g. propose landed -> awaiting approval). */
export function setClaimPhase(epochId: string, mint: string, kind: ClaimKind, phase: ClaimPhase): void {
  getDb()
    .query("UPDATE claim_progress SET phase = $phase WHERE epochId = $e AND mint = $m AND kind = $k AND status = 'signed'")
    .run({ $phase: phase, $e: epochId, $m: mint, $k: kind });
}

export function recordClaimConfirmed(epochId: string, mint: string, kind: ClaimKind, amountZats: bigint): void {
  getDb()
    .query("UPDATE claim_progress SET status = 'confirmed', amountZats = $a WHERE epochId = $e AND mint = $m AND kind = $k")
    .run({ $a: amountZats.toString(), $e: epochId, $m: mint, $k: kind });
}

/** A signed, unconfirmed claim that can never land (blockhash expired, proposal rejected): forget it so a fresh one can be built. */
export function clearUnlandedClaim(epochId: string, mint: string, kind: ClaimKind): void {
  getDb()
    .query("DELETE FROM claim_progress WHERE epochId = $e AND mint = $m AND kind = $k AND status = 'signed'")
    .run({ $e: epochId, $m: mint, $k: kind });
}

/** Claims of this epoch whose ZEC may be on its way but is not yet measured: the epoch must not be finalized or discarded while any exist. */
export function listUnconfirmedClaims(epochId: string): ClaimProgressRow[] {
  return getDb().query("SELECT * FROM claim_progress WHERE epochId = $e AND status != 'confirmed'").all({ $e: epochId }) as ClaimProgressRow[];
}

/**
 * Claims of this epoch that landed and were measured, for a coin that has no harvest row yet (audit S6-A1): their ZEC is in
 * the keeper account and no share explains it. The epoch must not be finalized or discarded while any exist either.
 */
export function listMeasuredClaimsWithoutHarvest(epochId: string): ClaimProgressRow[] {
  return getDb()
    .query(
      `SELECT c.* FROM claim_progress c LEFT JOIN epoch_coin_harvests h ON h.epochId = c.epochId AND h.mint = c.mint
       WHERE c.epochId = $e AND c.status = 'confirmed' AND c.amountZats IS NOT NULL AND c.amountZats != '0' AND h.mint IS NULL`,
    )
    .all({ $e: epochId }) as ClaimProgressRow[];
}

/** True once any claim (of any kind, in any phase) was started for this coin in this epoch. */
export function hasClaimProgress(epochId: string, mint: string): boolean {
  return getDb().query("SELECT 1 FROM claim_progress WHERE epochId = $e AND mint = $m LIMIT 1").get({ $e: epochId, $m: mint }) !== null;
}

// ---- meta: public facts the keeper process records for the API to read ----
// The API process never loads a secret key (INV-17), so anything it needs to
// know about the keeper (its PUBLIC address, to keep it out of the holder
// count) is written here by the keeper-side scripts.
export function getMeta(key: string): string | null {
  const row = getDb().query("SELECT value FROM meta WHERE key = $k").get({ $k: key }) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb().query("INSERT INTO meta (key,value) VALUES ($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run({ $k: key, $v: value });
}

export function deleteMeta(key: string): void {
  getDb().query("DELETE FROM meta WHERE key = $k").run({ $k: key });
}

// ---- faucet (devnet only) ----
export function lastFaucetClaimAt(wallet: string): string | null {
  const row = getDb().query("SELECT at FROM faucet_claims WHERE wallet = $w").get({ $w: wallet }) as { at: string } | null;
  return row?.at ?? null;
}

export function deleteFaucetClaim(wallet: string): void {
  getDb().query("DELETE FROM faucet_claims WHERE wallet = $w").run({ $w: wallet });
}

export function countFaucetClaimsSince(sinceIso: string): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM faucet_claims WHERE at >= $s").get({ $s: sinceIso }) as { n: number }).n;
}

export function recordFaucetClaim(wallet: string): void {
  getDb()
    .query("INSERT INTO faucet_claims (wallet,at) VALUES ($w,$at) ON CONFLICT(wallet) DO UPDATE SET at=excluded.at")
    .run({ $w: wallet, $at: new Date().toISOString() });
}

// ---- epochs ----
export function upsertEpoch(e: EpochRow): void {
  getDb()
    .query(
      `INSERT INTO epochs (id,at,coinMints,harvestedZats,feeZats,status,swapProvider,swapRef,swapState,swapAmountOutZats,zcashTxids,includeShielded)
       VALUES ($id,$at,$coinMints,$harvestedZats,$feeZats,$status,$swapProvider,$swapRef,$swapState,$swapAmountOutZats,$zcashTxids,$includeShielded)
       ON CONFLICT(id) DO UPDATE SET coinMints=excluded.coinMints, harvestedZats=excluded.harvestedZats, feeZats=excluded.feeZats,
         status=excluded.status, swapProvider=excluded.swapProvider, swapRef=excluded.swapRef,
         swapState=excluded.swapState, swapAmountOutZats=excluded.swapAmountOutZats, zcashTxids=excluded.zcashTxids`,
    )
    .run({
      $id: e.id, $at: e.at, $coinMints: e.coinMints, $harvestedZats: e.harvestedZats, $feeZats: e.feeZats,
      $status: e.status, $swapProvider: e.swapProvider, $swapRef: e.swapRef,
      $swapState: e.swapState, $swapAmountOutZats: e.swapAmountOutZats, $zcashTxids: e.zcashTxids,
      $includeShielded: e.includeShielded ?? 1,
    });
}

export function getEpoch(id: string): EpochRow | null {
  return getDb().query("SELECT * FROM epochs WHERE id = $id").get({ $id: id }) as EpochRow | null;
}

/** The `at` of the newest epoch that is not a draft and started before `beforeIso`: where the next epoch's holder window begins. */
export function previousEpochAt(beforeIso: string): string | null {
  const row = getDb().query("SELECT MAX(at) AS at FROM epochs WHERE status != 'harvesting' AND at < $b").get({ $b: beforeIso }) as { at: string | null };
  return row.at;
}

// ---- holder samples (audit O-1) ----
export interface HolderSample {
  takenAt: string;
  holders: { wallet: string; balance: bigint }[];
}

export function insertHolderSample(mint: string, takenAt: string, holders: { wallet: string; balance: bigint }[]): void {
  getDb()
    .query("INSERT INTO holder_samples (mint,takenAt,holders) VALUES ($m,$t,$h)")
    .run({ $m: mint, $t: takenAt, $h: JSON.stringify(holders.map((h) => [h.wallet, h.balance.toString()])) });
}

/** The samples of `mint` taken after `afterIso` (exclusive) up to `untilIso` (inclusive), oldest first. */
export function listHolderSamples(mint: string, afterIso: string, untilIso: string): HolderSample[] {
  const rows = getDb()
    .query("SELECT takenAt, holders FROM holder_samples WHERE mint = $m AND takenAt > $a AND takenAt <= $u ORDER BY takenAt")
    .all({ $m: mint, $a: afterIso, $u: untilIso }) as { takenAt: string; holders: string }[];
  return rows.map((r) => ({
    takenAt: r.takenAt,
    holders: (JSON.parse(r.holders) as [string, string][]).map(([wallet, balance]) => ({ wallet, balance: BigInt(balance) })),
  }));
}

/** How many eligible holders the keeper's newest sample of `mint` found, or null when it has taken none. */
export function latestHolderSampleCount(mint: string): number | null {
  const row = getDb()
    .query("SELECT json_array_length(holders) AS n FROM holder_samples WHERE mint = $m ORDER BY takenAt DESC, id DESC LIMIT 1")
    .get({ $m: mint }) as { n: number } | null;
  return row ? row.n : null;
}

/** The keeper's newest holder sample of `mint` with every eligible holder in it, or null when it has taken none. */
export function latestHolderSample(mint: string): HolderSample | null {
  const row = getDb()
    .query("SELECT takenAt, holders FROM holder_samples WHERE mint = $m ORDER BY takenAt DESC, id DESC LIMIT 1")
    .get({ $m: mint }) as { takenAt: string; holders: string } | null;
  if (!row) return null;
  return {
    takenAt: row.takenAt,
    holders: (JSON.parse(row.holders) as [string, string][]).map(([wallet, balance]) => ({ wallet, balance: BigInt(balance) })),
  };
}

export function pruneHolderSamples(beforeIso: string): void {
  getDb().query("DELETE FROM holder_samples WHERE takenAt < $b").run({ $b: beforeIso });
}

/** Every non-draft epoch (never exposes a "harvesting" draft: it has no confirmed proceeds yet). */
export function listEpochs(): EpochRow[] {
  return getDb().query("SELECT * FROM epochs WHERE status != 'harvesting' ORDER BY at DESC").all() as EpochRow[];
}

/** A draft ("harvesting") epoch, if one is in progress -- at most one at a time (protected by the epoch lock). */
export function findDraftEpoch(): EpochRow | null {
  return getDb().query("SELECT * FROM epochs WHERE status = 'harvesting' ORDER BY at DESC LIMIT 1").get() as EpochRow | null;
}

/** When the newest epoch that ran the shielded leg started (plan 4b: the shielded batch is weekly), or null. */
export function lastShieldedEpochAt(): string | null {
  return (getDb().query("SELECT MAX(at) AS at FROM epochs WHERE includeShielded = 1 AND status != 'harvesting'").get() as { at: string | null }).at;
}

export function epochHasUnsentPayouts(epochId: string): boolean {
  return (["solana", "shielded", "team"] as const).some((k) => getUnsentPayouts(epochId, k).length > 0);
}

/** Any non-draft, non-parked epoch that still has work left: unsent payouts, or a swap leg not yet settled/failed. A parked one never blocks (audit O-2). */
export function findResumableSentEpoch(): EpochRow | null {
  const candidates = getDb()
    .query("SELECT * FROM epochs WHERE status NOT IN ('harvesting','needs_attention') ORDER BY at DESC")
    .all() as EpochRow[];
  // A "partial" epoch is resumed even with every row sent: a run can stop after the last send and before the
  // status is recorded, and only a resume moves it to its final status (devnet D-1).
  return candidates.find((e) => e.status === "partial" || epochHasUnsentPayouts(e.id)) ?? null;
}

// ---- stuck epochs (audit O-2) ----
/** Counts one more run that ended with the epoch unfinished; returns the new count. */
export function bumpEpochAttempts(epochId: string): number {
  // unfinishedSince: when the epoch first ended a run unfinished (its legs started), the base of the stuck age (audit S6, lens 3-3:
  // measured from the draft's creation, a round the owner approved a day later was parked on its first paying run).
  getDb().query("UPDATE epochs SET attempts = attempts + 1, unfinishedSince = COALESCE(unfinishedSince, $now) WHERE id = $id").run({ $id: epochId, $now: new Date().toISOString() });
  return (getDb().query("SELECT attempts FROM epochs WHERE id = $id").get({ $id: epochId }) as { attempts: number }).attempts;
}

/** Parks an epoch: it stops blocking later epochs, its rows stay unsent and owed. */
export function parkEpoch(epochId: string, reason: string): void {
  getDb()
    .query("UPDATE epochs SET status = 'needs_attention', parkedAt = COALESCE(parkedAt, $at), attentionReason = $r WHERE id = $id")
    .run({ $id: epochId, $at: new Date().toISOString(), $r: reason });
}

/** A parked epoch that has no work left: back to a normal status. */
export function unparkEpoch(epochId: string, status: Exclude<EpochStatus, "needs_attention" | "harvesting">): void {
  getDb().query("UPDATE epochs SET status = $s, parkedAt = NULL, attentionReason = NULL WHERE id = $id").run({ $id: epochId, $s: status });
}

export function listParkedEpochs(): EpochRow[] {
  return getDb().query("SELECT * FROM epochs WHERE status = 'needs_attention' ORDER BY at").all() as EpochRow[];
}

/**
 * What the KEEPER's Solana ZEC account must hold to pay everything that is owed from it: unsent Solana rows,
 * unsent shielded rows whose swap has not moved funds out of it (not yet submitted, or fallen back to Solana),
 * and every wallet's carry (carried shares were never swapped).
 */
export function sumOwedFromKeeper(): bigint {
  const rows = getDb()
    .query(
      `SELECT p.amountZats AS amountZats FROM payouts p JOIN epochs e ON e.id = p.epochId
       WHERE p.sentAt IS NULL AND (p.kind IN ('solana','team') OR e.swapState IN ('none','failed_before_funds_moved','returned_to_keeper'))`,
    )
    .all() as { amountZats: string }[];
  // Orphaned proceeds sit in the keeper account too, owed to their coin's future holders (audit S6, lens 2-4): without them the
  // isolation gate (src/epoch/stuck.ts) understated what the account must hold.
  return rows.reduce((acc, r) => acc + BigInt(r.amountZats), 0n) + sumCarry("solana") + sumCarry("shielded") + teamUnplannedZats() + sumOrphanedZats();
}

/** Every coin's orphaned proceeds (claimed with no eligible holder, held for the coin's next distribution), in all. */
export function sumOrphanedZats(): bigint {
  const rows = getDb().query("SELECT amountZats FROM coin_orphaned_zats").all() as { amountZats: string }[];
  return rows.reduce((acc, r) => acc + BigInt(r.amountZats), 0n);
}

/** What this epoch's claims measured on chain, every kind and coin summed: harvested plus what was newly orphaned (audit S6, lens 2-4). */
export function sumConfirmedClaims(epochId: string): bigint {
  const rows = getDb().query("SELECT amountZats FROM claim_progress WHERE epochId = $e AND status = 'confirmed'").all({ $e: epochId }) as { amountZats: string | null }[];
  return rows.reduce((acc, r) => acc + BigInt(r.amountZats ?? "0"), 0n);
}

/** Native ZEC owed from the treasury wallet: unsent shielded rows whose swap has settled. */
export function sumUnsentShieldedSettled(): bigint {
  const rows = getDb()
    .query("SELECT p.amountZats AS amountZats FROM payouts p JOIN epochs e ON e.id = p.epochId WHERE p.sentAt IS NULL AND p.kind = 'shielded' AND e.swapState = 'settled'")
    .all() as { amountZats: string }[];
  return rows.reduce((acc, r) => acc + BigInt(r.amountZats), 0n);
}

// ---- alerts: things a human must look at (parked epochs, halted runs) ----
export interface AlertRow {
  id: number;
  at: string;
  kind: string;
  epochId: string;
  message: string;
  resolvedAt: string | null;
}

/** Records an alert unless the same kind for the same epoch is already open. Returns true if it is new. */
export function recordAlert(kind: string, epochId: string, message: string): boolean {
  const open = getDb().query("SELECT 1 FROM alerts WHERE kind = $k AND epochId = $e AND resolvedAt IS NULL").get({ $k: kind, $e: epochId });
  if (open) return false;
  getDb().query("INSERT INTO alerts (at,kind,epochId,message) VALUES ($at,$k,$e,$m)").run({ $at: new Date().toISOString(), $k: kind, $e: epochId, $m: redactSecrets(message) });
  return true;
}

export function resolveAlerts(kind: string, epochId: string): void {
  getDb().query("UPDATE alerts SET resolvedAt = $at WHERE kind = $k AND epochId = $e AND resolvedAt IS NULL").run({ $at: new Date().toISOString(), $k: kind, $e: epochId });
}

/** Resolves every open alert of `kind`, whatever epoch it names: for a condition that one later event clears for all of them. */
export function resolveAlertsOfKind(kind: string): void {
  getDb().query("UPDATE alerts SET resolvedAt = $at WHERE kind = $k AND resolvedAt IS NULL").run({ $at: new Date().toISOString(), $k: kind });
}

export function listOpenAlerts(): AlertRow[] {
  return getDb().query("SELECT * FROM alerts WHERE resolvedAt IS NULL ORDER BY id").all() as AlertRow[];
}

// ---- RPC usage: what the RPC guard counted (src/rpcUsage.ts), flushed once an hour by the API and the keeper ----
/** Adds counted calls to the rows of their hour, process and method (a process that flushes twice in an hour, or restarts, adds to what it wrote). All or none. */
export function addRpcUsage(processName: string, rows: readonly RpcUsageRow[]): void {
  const add = getDb().query(
    `INSERT INTO rpc_usage (hour_utc,process,method,calls,failures) VALUES ($h,$p,$m,$c,$f)
     ON CONFLICT(hour_utc,process,method) DO UPDATE SET calls = calls + excluded.calls, failures = failures + excluded.failures`,
  );
  getDb().transaction(() => {
    for (const r of rows) add.run({ $h: r.hourUtc, $p: processName, $m: r.method, $c: r.calls, $f: r.failures });
  })();
}

/** Calls and failures per method, all processes together, of the hours starting at `sinceHourUtc` (an ISO hour start) or later. */
export function rpcUsageSince(sinceHourUtc: string): { method: string; calls: number; failures: number }[] {
  return getDb()
    .query("SELECT method, SUM(calls) AS calls, SUM(failures) AS failures FROM rpc_usage WHERE hour_utc >= $s GROUP BY method ORDER BY method")
    .all({ $s: sinceHourUtc }) as { method: string; calls: number; failures: number }[];
}

/** Discards a draft epoch that ended up with nothing sold (see runEpoch: "an epoch that sold nothing is not recorded"). */
export function deleteDraftEpoch(epochId: string): void {
  getDb().transaction(() => {
    getDb().query("DELETE FROM epochs WHERE id = $id AND status = 'harvesting'").run({ $id: epochId });
    getDb().query("DELETE FROM epoch_coin_harvests WHERE epochId = $id").run({ $id: epochId });
    getDb().query("DELETE FROM epoch_coin_shares WHERE epochId = $id").run({ $id: epochId });
  })();
}

// ---- per-coin harvest staging (see migrate()'s comment on epoch_coin_harvests) ----
export function listEpochCoinHarvests(epochId: string): EpochCoinHarvestRow[] {
  return getDb()
    .query("SELECT epochId, mint, soldForZatsQuote, teamZats FROM epoch_coin_harvests WHERE epochId = $e")
    .all({ $e: epochId }) as EpochCoinHarvestRow[];
}

/**
 * Persists one coin's completed harvest+sell (amount, and its already-computed
 * per-wallet shares) atomically. Called immediately after that coin's sale
 * lands, before moving to the next coin, so a crash never loses an already-
 * sold coin's attribution (engine/README.md "Harvest resume").
 */
export function recordEpochCoinHarvest(
  epochId: string,
  mint: string,
  soldForZatsQuote: bigint,
  shares: { wallet: string; amount: bigint; weight?: bigint }[],
  resetOrphanedZatsTo?: bigint,
  teamZats: bigint = 0n,
): void {
  getDb().transaction(() => {
    getDb()
      .query(
        `INSERT INTO epoch_coin_harvests (epochId,mint,soldForZatsQuote,teamZats,at) VALUES ($e,$m,$s,$t,$at)
         ON CONFLICT(epochId,mint) DO UPDATE SET soldForZatsQuote=excluded.soldForZatsQuote, teamZats=excluded.teamZats`,
      )
      .run({ $e: epochId, $m: mint, $s: soldForZatsQuote.toString(), $t: teamZats.toString(), $at: new Date().toISOString() });
    for (const s of shares) {
      getDb()
        .query(
          `INSERT INTO epoch_coin_shares (epochId,mint,wallet,amountZats,weightRaw) VALUES ($e,$m,$w,$a,$wt)
           ON CONFLICT(epochId,mint,wallet) DO UPDATE SET amountZats=excluded.amountZats, weightRaw=excluded.weightRaw`,
        )
        .run({ $e: epochId, $m: mint, $w: s.wallet, $a: s.amount.toString(), $wt: s.weight?.toString() ?? null });
    }
    // Same transaction as the harvest+shares write above (finding 10): a
    // crash between "shares recorded" and "orphaned bucket cleared" could
    // otherwise either double-pay from a stale orphaned balance (recorded
    // first, cleared never) or lose the just-distributed amount (cleared
    // first, recorded never).
    if (resetOrphanedZatsTo !== undefined) setOrphanedCoinProceeds(mint, resetOrphanedZatsTo);
  })();
}

/** Combines every coin's persisted per-wallet shares into one total per wallet. */
export function combineEpochCoinShares(epochId: string): Map<string, bigint> {
  const rows = getDb()
    .query("SELECT wallet, amountZats FROM epoch_coin_shares WHERE epochId = $e")
    .all({ $e: epochId }) as { wallet: string; amountZats: string }[];
  const combined = new Map<string, bigint>();
  for (const r of rows) combined.set(r.wallet, (combined.get(r.wallet) ?? 0n) + BigInt(r.amountZats));
  return combined;
}

// ---- the team's ledger (src/epoch/split.ts) ----
/** Records the team's gross share and the delivery reserve of a freshly finalized epoch. With no reserve there is nothing to wait for: the delivery is resolved at once. */
export function setEpochTeamSplit(epochId: string, teamGross: bigint, reserve: bigint): void {
  getDb()
    .query(
      `UPDATE epochs SET teamGrossZats = $g, deliveryReserveZats = $r,
         deliveryCostZats = CASE WHEN $r = '0' THEN '0' ELSE NULL END,
         teamSolanaZats = CASE WHEN $r = '0' THEN $g ELSE NULL END WHERE id = $id`,
    )
    .run({ $g: teamGross.toString(), $r: reserve.toString(), $id: epochId });
}

export interface DeliveryResolution {
  deliveryCost: bigint;
  teamNative: bigint;
  teamSolana: bigint;
  holderShortfall: bigint;
}

/** Fixes what delivering this epoch's shielded rewards cost. Once only: a resolved epoch is never rewritten. */
export function resolveEpochDelivery(epochId: string, r: DeliveryResolution): void {
  getDb()
    .query(
      `UPDATE epochs SET deliveryCostZats = $c, teamNativeZats = $n, teamSolanaZats = $s, holderShortfallZats = $h
       WHERE id = $id AND teamSolanaZats IS NULL`,
    )
    .run({ $c: r.deliveryCost.toString(), $n: r.teamNative.toString(), $s: r.teamSolana.toString(), $h: r.holderShortfall.toString(), $id: epochId });
}

/** Team payout rows that moved or may move Solana ZEC out of the keeper: everything except rows closed as carried. */
const TEAM_ROW_COMMITTED = "kind = 'team' AND (sig IS NULL OR sig NOT LIKE 'carried:%')";

function sumColumn(sql: string, params: Record<string, string> = {}): bigint {
  return (getDb().query(sql).all(params) as { v: string }[]).reduce((acc, r) => acc + BigInt(r.v), 0n);
}

/** Solana ZEC the team is owed from the keeper's account, whether swept already or not: resolved epochs' Solana share, plus what an unresolved epoch still holds. */
function teamKeeperEntitlementZats(): bigint {
  return sumColumn(
    `SELECT CAST(CASE WHEN teamSolanaZats IS NOT NULL THEN teamSolanaZats
                      WHEN swapState = 'submitted' THEN CAST(teamGrossZats AS INTEGER) - CAST(deliveryReserveZats AS INTEGER)
                      ELSE teamGrossZats END AS TEXT) AS v
     FROM epochs WHERE status != 'harvesting' AND teamGrossZats != '0'`,
  );
}

export function teamCommittedZats(): bigint {
  return sumColumn(`SELECT amountZats AS v FROM payouts WHERE ${TEAM_ROW_COMMITTED}`);
}

/** Team Solana ZEC sitting in the keeper with no payout row yet: held (no TEAM_WALLET) or waiting for the next sweep. */
export function teamUnplannedZats(): bigint {
  const v = teamKeeperEntitlementZats() - teamCommittedZats();
  return v > 0n ? v : 0n;
}

/** What the next team payout row may carry: only epochs whose delivery is resolved count, so a reserve still in a swap is never paid out. */
export function teamSweepableZats(): bigint {
  const v = sumColumn("SELECT teamSolanaZats AS v FROM epochs WHERE teamSolanaZats IS NOT NULL AND status != 'harvesting'") - teamCommittedZats();
  return v > 0n ? v : 0n;
}

export interface TeamTotals {
  grossZats: bigint;
  deliveryCostZats: bigint;
  nativeZats: bigint;
  heldInKeeperZats: bigint; // not yet sent to a team wallet (all of it when none is configured)
  sweptZats: bigint;
}

export function teamTotals(): TeamTotals {
  const sent = sumColumn(`SELECT amountZats AS v FROM payouts WHERE ${TEAM_ROW_COMMITTED} AND sentAt IS NOT NULL`);
  return {
    grossZats: sumColumn("SELECT teamGrossZats AS v FROM epochs WHERE status != 'harvesting'"),
    deliveryCostZats: sumColumn("SELECT deliveryCostZats AS v FROM epochs WHERE status != 'harvesting' AND deliveryCostZats IS NOT NULL"),
    nativeZats: sumColumn("SELECT teamNativeZats AS v FROM epochs WHERE status != 'harvesting'"),
    heldInKeeperZats: teamKeeperEntitlementZats() - sent,
    sweptZats: sent,
  };
}

// ---- payouts (idempotent: planned before sending, marked sent per recipient) ----
export function planPayout(p: Omit<PayoutRow, "sig" | "sentAt" | "zcashAddress"> & { zcashAddress?: string | null }): void {
  getDb()
    .query(
      `INSERT INTO payouts (epochId,wallet,kind,amountZats,zcashAddress,flag,sig,sentAt)
       VALUES ($epochId,$wallet,$kind,$amountZats,$zcashAddress,$flag,NULL,NULL)
       ON CONFLICT(epochId,wallet,kind) DO NOTHING`,
    )
    .run({
      $epochId: p.epochId, $wallet: p.wallet, $kind: p.kind, $amountZats: p.amountZats,
      $zcashAddress: p.zcashAddress ?? null, $flag: p.flag ?? null,
    });
}

/**
 * Records a signature/txid BEFORE the payout is considered sent: for Solana,
 * called right after the keeper signs a batch (so the txid is known before
 * broadcast); for Zcash, right after devtool's `pay` returns a txid. Leaves
 * sentAt null -- a crash here resumes by checking this signature's chain
 * status (checkSolanaSignatureLanded / zcashTxStatus), never by resending
 * blind (see engine/README.md "Payout resume").
 */
export function markPayoutPending(
  epochId: string, wallet: string, kind: PayoutKind, sig: string,
  signed?: { rawTx: string; lastValidBlockHeight: number },
): void {
  getDb()
    .query("UPDATE payouts SET sig = $sig, rawTx = $raw, lastValidBlockHeight = $h WHERE epochId = $e AND wallet = $w AND kind = $k AND sentAt IS NULL")
    .run({ $sig: sig, $raw: signed?.rawTx ?? null, $h: signed?.lastValidBlockHeight ?? null, $e: epochId, $w: wallet, $k: kind });
}

/** A pending signature turned out not to have landed (e.g. blockhash expired): clears it so the row is picked up fresh. */
export function clearPendingPayoutSig(epochId: string, wallet: string, kind: PayoutKind): void {
  getDb()
    .query("UPDATE payouts SET sig = NULL, rawTx = NULL, lastValidBlockHeight = NULL WHERE epochId = $e AND wallet = $w AND kind = $k AND sentAt IS NULL")
    .run({ $e: epochId, $w: wallet, $k: kind });
}

/**
 * Reprices an unsent payout (finding 7): the shielded leg plans from the
 * harvested-input estimate, but must actually pay from the swap's real
 * settled output minus the network fee. Called before anything is
 * pending/sent, so the amount the row ends up recording is always what was
 * really paid.
 */
export function setUnsentPayoutAmount(epochId: string, wallet: string, kind: PayoutKind, amountZats: bigint): void {
  getDb()
    .query("UPDATE payouts SET amountZats = $a WHERE epochId = $e AND wallet = $w AND kind = $k AND sentAt IS NULL")
    .run({ $a: amountZats.toString(), $e: epochId, $w: wallet, $k: kind });
}

export function markPayoutSent(epochId: string, wallet: string, kind: PayoutKind, sig: string): void {
  getDb()
    .query("UPDATE payouts SET sig = $sig, sentAt = $at, rawTx = NULL WHERE epochId = $e AND wallet = $w AND kind = $k AND sentAt IS NULL")
    .run({ $sig: sig, $at: new Date().toISOString(), $e: epochId, $w: wallet, $k: kind });
}

export function getPayouts(epochId: string): PayoutRow[] {
  return getDb().query("SELECT * FROM payouts WHERE epochId = $e").all({ $e: epochId }) as PayoutRow[];
}

/** Every Solana-rail and shielded payout row of one wallet, in no particular order (the caller orders them by their epoch's time). */
export function listPayoutsOfWallet(wallet: string): PayoutRow[] {
  return getDb().query("SELECT * FROM payouts WHERE wallet = $w AND kind IN ('solana','shielded')").all({ $w: wallet }) as PayoutRow[];
}

/** One wallet's per-coin shares of one epoch (what the snapshot lists for it). */
export function listEpochCoinSharesOfWallet(epochId: string, wallet: string): EpochCoinShareRow[] {
  return getDb()
    .query("SELECT mint, wallet, amountZats, weightRaw FROM epoch_coin_shares WHERE epochId = $e AND wallet = $w ORDER BY mint")
    .all({ $e: epochId, $w: wallet }) as EpochCoinShareRow[];
}

export function getUnsentPayouts(epochId: string, kind: PayoutKind): PayoutRow[] {
  return getDb()
    .query("SELECT * FROM payouts WHERE epochId = $e AND kind = $k AND sentAt IS NULL")
    .all({ $e: epochId, $k: kind }) as PayoutRow[];
}

/** Unsent rows with no signature yet: never attempted, or a prior attempt was cleared after not landing. */
export function getFreshUnsentPayouts(epochId: string, kind: PayoutKind): PayoutRow[] {
  return getDb()
    .query("SELECT * FROM payouts WHERE epochId = $e AND kind = $k AND sentAt IS NULL AND sig IS NULL")
    .all({ $e: epochId, $k: kind }) as PayoutRow[];
}

/** Unsent rows with a signature already recorded: a broadcast was attempted -- resume by checking its chain status, never resend blind. */
export function getPendingPayouts(epochId: string, kind: PayoutKind): PayoutRow[] {
  return getDb()
    .query("SELECT * FROM payouts WHERE epochId = $e AND kind = $k AND sentAt IS NULL AND sig IS NOT NULL")
    .all({ $e: epochId, $k: kind }) as PayoutRow[];
}

export function sumUnsentShielded(): bigint {
  const rows = getDb()
    .query("SELECT amountZats FROM payouts WHERE kind = 'shielded' AND sentAt IS NULL")
    .all() as { amountZats: string }[];
  return rows.reduce((acc, r) => acc + BigInt(r.amountZats), 0n);
}

// ---- carry (dust below the epoch floor rolls into next epoch's share) ----
export function getCarry(wallet: string, kind: CarryKind): bigint {
  const row = getDb()
    .query("SELECT amountZats FROM carry WHERE wallet = $w AND kind = $k")
    .get({ $w: wallet, $k: kind }) as { amountZats: string } | null;
  return row ? BigInt(row.amountZats) : 0n;
}

export function setCarry(wallet: string, kind: CarryKind, amountZats: bigint): void {
  getDb()
    .query(
      `INSERT INTO carry (wallet,kind,amountZats) VALUES ($w,$k,$a)
       ON CONFLICT(wallet,kind) DO UPDATE SET amountZats=excluded.amountZats`,
    )
    .run({ $w: wallet, $k: kind, $a: amountZats.toString() });
}

/** Every wallet with a nonzero carry on either rail (audit S2-07: carry is owed even after a wallet stops holding or switches rail). */
export function listCarryWallets(): string[] {
  return (getDb().query("SELECT DISTINCT wallet FROM carry WHERE amountZats != '0'").all() as { wallet: string }[]).map((r) => r.wallet);
}

/** Moves a skipped payout's amount into carry and closes its row, in one write: a crash between the two must never count it twice. */
export function carryAndClosePayout(epochId: string, wallet: string, kind: CarryKind, amountZats: bigint, marker: string): void {
  getDb().transaction(() => {
    setCarry(wallet, kind, getCarry(wallet, kind) + amountZats);
    markPayoutSent(epochId, wallet, kind, marker);
  })();
}

export function recordKeeperFundedAta(ata: string, wallet: string): void {
  getDb().query("INSERT OR IGNORE INTO keeper_funded_atas (ata,wallet,at) VALUES ($a,$w,$at)").run({ $a: ata, $w: wallet, $at: new Date().toISOString() });
}

export function keeperFundedAtas(atas: string[]): Set<string> {
  const out = new Set<string>();
  const q = getDb().query("SELECT 1 FROM keeper_funded_atas WHERE ata = $a");
  for (const a of atas) if (q.get({ $a: a })) out.add(a);
  return out;
}

export function sumCarry(kind: CarryKind): bigint {
  const rows = getDb().query("SELECT amountZats FROM carry WHERE kind = $k").all({ $k: kind }) as {
    amountZats: string;
  }[];
  return rows.reduce((acc, r) => acc + BigInt(r.amountZats), 0n);
}

// ---- locks (DB-backed exclusive lock with stale-lock takeover) ----
/**
 * Attempts to take `name`'s lock for `holder`. Succeeds if the lock is free,
 * already held by this exact `holder`, or held by anyone but stale (older
 * than `staleMs`: a prior run crashed without releasing it). sqlite is
 * single-writer, and the read-check + write happen inside one IMMEDIATE
 * transaction, so two processes racing this call can never both succeed.
 */
export function tryAcquireLock(name: string, holder: string, staleMs: number): boolean {
  return getDb().transaction(() => {
    const row = getDb().query("SELECT holder, acquiredAt FROM locks WHERE name = $n").get({ $n: name }) as
      | { holder: string; acquiredAt: string }
      | null;
    // A lock dated in the future by more than staleMs was written by a holder whose clock was wrong: stale, else a
    // fast-clocked keeper that died would block every run for its skew (stress run D10). An alive holder is fenced out.
    const age = row ? Date.now() - Date.parse(row.acquiredAt) : 0;
    const fresh = row && age < staleMs && age > -staleMs;
    if (fresh && row!.holder !== holder) return false;
    getDb()
      .query(
        `INSERT INTO locks (name,holder,acquiredAt) VALUES ($n,$h,$a)
         ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, acquiredAt=excluded.acquiredAt`,
      )
      .run({ $n: name, $h: holder, $a: new Date().toISOString() });
    return true;
  }).immediate();
}

/** Heartbeat + fencing check: true (and the lock's age reset) only while `holder` still holds `name`. */
export function refreshLock(name: string, holder: string): boolean {
  const r = getDb().query("UPDATE locks SET acquiredAt = $a WHERE name = $n AND holder = $h").run({ $a: new Date().toISOString(), $n: name, $h: holder });
  return r.changes === 1;
}

/** Releases `name`'s lock, but only if still held by `holder` (a stale takeover elsewhere must not be released out from under it). */
export function releaseLock(name: string, holder: string): void {
  getDb().query("DELETE FROM locks WHERE name = $n AND holder = $h").run({ $n: name, $h: holder });
}

// ---- swap_progress (adapter-side state machine; see migrate()) ----
export interface SwapProgressRow {
  ref: string;
  status: "submitted" | "settled";
  amountInZats: string;
  rawTxBase64: string | null;
  amountOutZats: string | null;
  payTxid: string | null;
}

export function getSwapProgress(ref: string): SwapProgressRow | null {
  return getDb().query("SELECT * FROM swap_progress WHERE ref = $r").get({ $r: ref }) as SwapProgressRow | null;
}

/** Persisted right after signing, BEFORE broadcasting: durable proof of intent + the exact bytes needed to safely resend. */
export function recordSwapSubmitted(ref: string, amountInZats: bigint, rawTxBase64: string): void {
  getDb()
    .query(
      `INSERT INTO swap_progress (ref,status,amountInZats,rawTxBase64,at) VALUES ($r,'submitted',$a,$raw,$at)
       ON CONFLICT(ref) DO NOTHING`,
    )
    .run({ $r: ref, $a: amountInZats.toString(), $raw: rawTxBase64, $at: new Date().toISOString() });
}

export function recordSwapSettled(ref: string, amountOutZats: bigint, payTxid: string): void {
  getDb()
    .query("UPDATE swap_progress SET status = 'settled', amountOutZats = $a, payTxid = $t WHERE ref = $r")
    .run({ $r: ref, $a: amountOutZats.toString(), $t: payTxid });
}

// ---- near1click_swaps (see migrate()) ----
export type Near1ClickPhase = "quoted" | "signed" | "deposited" | "settled" | "returned" | "no_deposit";

export interface Near1ClickSwapRow {
  key: string;
  phase: Near1ClickPhase;
  amountInZats: string;
  keeper: string;
  recipient: string;
  quoteJson: string;
  depositAddress: string;
  requestDeadline: string;
  quoteDeadline: string;
  signature: string | null;
  rawTxBase64: string | null;
  lastValidBlockHeight: number | null;
  signedAt: string | null;
  attempts: number;
  amountOutZats: string | null;
  destinationTxids: string | null; // json string[]
  refundSig: string | null;
  note: string | null;
  at: string;
  updatedAt: string;
}

export type NewNear1ClickQuote = Pick<Near1ClickSwapRow, "key" | "amountInZats" | "keeper" | "recipient" | "quoteJson" | "depositAddress" | "requestDeadline" | "quoteDeadline">;

export function getNear1ClickSwap(key: string): Near1ClickSwapRow | null {
  return getDb().query("SELECT * FROM near1click_swaps WHERE key = $k").get({ $k: key }) as Near1ClickSwapRow | null;
}

/** False if a row for this key already exists (the caller must resume it, never overwrite it). */
export function insertNear1ClickQuote(q: NewNear1ClickQuote): boolean {
  const now = new Date().toISOString();
  const r = getDb()
    .query(
      `INSERT INTO near1click_swaps (key,phase,amountInZats,keeper,recipient,quoteJson,depositAddress,requestDeadline,quoteDeadline,at,updatedAt)
       VALUES ($k,'quoted',$a,$kp,$r,$q,$d,$rd,$qd,$now,$now) ON CONFLICT(key) DO NOTHING`,
    )
    .run({ $k: q.key, $a: q.amountInZats, $kp: q.keeper, $r: q.recipient, $q: q.quoteJson, $d: q.depositAddress, $rd: q.requestDeadline, $qd: q.quoteDeadline, $now: now });
  return r.changes === 1;
}

/** Swaps an unusable quote for a fresh one. Only while no transaction has been signed (phase 'quoted'); false otherwise. */
export function replaceNear1ClickQuote(q: NewNear1ClickQuote): boolean {
  const r = getDb()
    .query(
      `UPDATE near1click_swaps SET amountInZats=$a, keeper=$kp, recipient=$r, quoteJson=$q, depositAddress=$d, requestDeadline=$rd, quoteDeadline=$qd,
         attempts = attempts + 1, updatedAt=$now WHERE key=$k AND phase='quoted'`,
    )
    .run({ $k: q.key, $a: q.amountInZats, $kp: q.keeper, $r: q.recipient, $q: q.quoteJson, $d: q.depositAddress, $rd: q.requestDeadline, $qd: q.quoteDeadline, $now: new Date().toISOString() });
  return r.changes === 1;
}

/** Durable proof a deposit may exist: the signed bytes, stored BEFORE they are broadcast. quoted -> signed only. */
export function recordNear1ClickSigned(key: string, s: { signature: string; rawTxBase64: string; lastValidBlockHeight: number }): boolean {
  const r = getDb()
    .query("UPDATE near1click_swaps SET phase='signed', signature=$s, rawTxBase64=$raw, lastValidBlockHeight=$h, signedAt=$now, updatedAt=$now WHERE key=$k AND phase='quoted'")
    .run({ $k: key, $s: s.signature, $raw: s.rawTxBase64, $h: s.lastValidBlockHeight, $now: new Date().toISOString() });
  return r.changes === 1;
}

export interface Near1ClickPhaseExtras {
  amountOutZats?: string;
  destinationTxids?: string[];
  refundSig?: string;
}

/** Compare-and-set phase change: only from one of `from`. Returns false if the row was not in one of those phases. */
export function advanceNear1ClickPhase(key: string, from: Near1ClickPhase[], to: Near1ClickPhase, extras: Near1ClickPhaseExtras = {}): boolean {
  const marks = from.map((_, i) => `$f${i}`).join(",");
  const params: Record<string, string | null> = { $k: key, $to: to, $now: new Date().toISOString(), $a: extras.amountOutZats ?? null, $t: extras.destinationTxids ? JSON.stringify(extras.destinationTxids) : null, $rs: extras.refundSig ?? null };
  from.forEach((f, i) => (params[`$f${i}`] = f));
  const r = getDb()
    .query(
      `UPDATE near1click_swaps SET phase=$to, amountOutZats=COALESCE($a,amountOutZats), destinationTxids=COALESCE($t,destinationTxids),
         refundSig=COALESCE($rs,refundSig), updatedAt=$now WHERE key=$k AND phase IN (${marks})`,
    )
    .run(params);
  return r.changes === 1;
}

/** The key of another swap that already settled with `txid` as its delivery, if any: one Zcash tx can fund only one epoch. */
export function findNear1ClickSwapByDestinationTxid(txid: string, exceptKey: string): string | null {
  const row = getDb()
    .query("SELECT key FROM near1click_swaps WHERE key != $k AND phase = 'settled' AND destinationTxids LIKE $p LIMIT 1")
    .get({ $k: exceptKey, $p: `%"${txid}"%` }) as { key: string } | null;
  return row?.key ?? null;
}

/** Why the swap is waiting (shown to the operator); never changes the phase. */
export function setNear1ClickNote(key: string, note: string): void {
  getDb().query("UPDATE near1click_swaps SET note=$n, updatedAt=$now WHERE key=$k").run({ $k: key, $n: note.slice(0, 500), $now: new Date().toISOString() });
}

// ---- coin_orphaned_zats (see migrate()'s comment) ----
export function getOrphanedCoinProceeds(mint: string): bigint {
  const row = getDb().query("SELECT amountZats FROM coin_orphaned_zats WHERE mint = $m").get({ $m: mint }) as { amountZats: string } | null;
  return row ? BigInt(row.amountZats) : 0n;
}

/** Sets a coin's bucket. `sinceAt` starts when the bucket goes from empty to holding money, stays while it holds, and clears when it empties. */
export function setOrphanedCoinProceeds(mint: string, amountZats: bigint): void {
  getDb()
    .query(
      `INSERT INTO coin_orphaned_zats (mint,amountZats,sinceAt) VALUES ($m,$a,CASE WHEN $a = '0' THEN NULL ELSE $now END)
       ON CONFLICT(mint) DO UPDATE SET amountZats=excluded.amountZats,
         sinceAt=CASE WHEN excluded.amountZats = '0' THEN NULL WHEN coin_orphaned_zats.sinceAt IS NULL THEN excluded.sinceAt ELSE coin_orphaned_zats.sinceAt END`,
    )
    .run({ $m: mint, $a: amountZats.toString(), $now: new Date().toISOString() });
}

export interface OrphanedCoinRow {
  mint: string;
  amountZats: string;
  /** When the bucket started holding money; null only for a row written before the column existed and emptied since. */
  sinceAt: string | null;
}

/** Every coin whose bucket holds money, oldest first. */
export function listOrphanedCoinProceeds(): OrphanedCoinRow[] {
  return getDb().query("SELECT mint, amountZats, sinceAt FROM coin_orphaned_zats WHERE amountZats != '0' ORDER BY sinceAt, mint").all() as OrphanedCoinRow[];
}

// ---- epoch snapshots (src/epoch/snapshotFile.ts, snapshotMemo.ts) ----
export interface EpochSnapshotRow {
  epochId: string;
  json: string; // the exact bytes that are hashed and served
  sha256: string;
  shieldedWallets: string; // JSON string[]: wallets on the shielded rail at planning; never published
  createdAt: string;
  memoSig: string | null;
  memoRawTx: string | null;
  memoLastValidBlockHeight: number | null;
  memoAt: string | null; // set once the memo transaction is confirmed
}

/** Stores the snapshot once; a second call for the same epoch keeps the first (the hash on chain must match what is served). */
export function insertEpochSnapshot(epochId: string, json: string, sha256: string, shieldedWallets: string[]): void {
  getDb()
    .query("INSERT OR IGNORE INTO epoch_snapshots (epochId,json,sha256,shieldedWallets,createdAt) VALUES ($e,$j,$h,$w,$at)")
    .run({ $e: epochId, $j: json, $h: sha256, $w: JSON.stringify(shieldedWallets), $at: new Date().toISOString() });
}

export function getEpochSnapshot(epochId: string): EpochSnapshotRow | null {
  return getDb().query("SELECT * FROM epoch_snapshots WHERE epochId = $e").get({ $e: epochId }) as EpochSnapshotRow | null;
}

/** Epochs whose snapshot memo has not landed, oldest first: retried on every run until it does. */
export function listSnapshotsAwaitingMemo(): string[] {
  return (getDb().query("SELECT epochId FROM epoch_snapshots WHERE memoAt IS NULL ORDER BY createdAt").all() as { epochId: string }[]).map((r) => r.epochId);
}

export function markSnapshotMemoPending(epochId: string, sig: string, rawTx: string, lastValidBlockHeight: number): void {
  getDb()
    .query("UPDATE epoch_snapshots SET memoSig = $s, memoRawTx = $r, memoLastValidBlockHeight = $h WHERE epochId = $e AND memoAt IS NULL")
    .run({ $s: sig, $r: rawTx, $h: lastValidBlockHeight, $e: epochId });
}

export function clearSnapshotMemoPending(epochId: string): void {
  getDb().query("UPDATE epoch_snapshots SET memoSig = NULL, memoRawTx = NULL, memoLastValidBlockHeight = NULL WHERE epochId = $e AND memoAt IS NULL").run({ $e: epochId });
}

export function markSnapshotMemoLanded(epochId: string): void {
  getDb().query("UPDATE epoch_snapshots SET memoAt = COALESCE(memoAt, $at), memoRawTx = NULL WHERE epochId = $e").run({ $at: new Date().toISOString(), $e: epochId });
}

export interface EpochCoinShareRow {
  mint: string;
  wallet: string;
  amountZats: string;
  weightRaw: string | null;
}

export function listEpochCoinShares(epochId: string): EpochCoinShareRow[] {
  return getDb().query("SELECT mint, wallet, amountZats, weightRaw FROM epoch_coin_shares WHERE epochId = $e").all({ $e: epochId }) as EpochCoinShareRow[];
}

/** The secret that salts shielded commitments in snapshots: random, created on first use, kept only in this database. */
export function snapshotSaltSecret(): string {
  const existing = getMeta("snapshot_salt_secret");
  if (existing) return existing;
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  getDb().query("INSERT OR IGNORE INTO meta (key,value) VALUES ('snapshot_salt_secret', $v)").run({ $v: fresh });
  return getMeta("snapshot_salt_secret")!;
}
