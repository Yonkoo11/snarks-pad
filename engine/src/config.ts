// Central config: mode selection, network endpoints, program ids, filesystem paths.
// Never reads secret values here beyond a filesystem PATH to a keypair file.
import { PublicKey } from "@solana/web3.js";
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, DYNAMIC_BONDING_CURVE_PROGRAM_ID, MigrationFeeOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClaimKind } from "./db";
import { PERMANENT_VALUE_ENV_VARS, REVIEWED_CONFIG } from "./dbc/reviewed";
import { installRedaction, loadSecretEnvFile } from "./util/redact";

/** Every claim kind a round can make (db.ClaimKind), for PAD_HELD_CLAIM_KINDS. Declared before the config object that reads it. */
const CLAIM_KINDS: readonly ClaimKind[] = ["trading", "damm_position", "surplus"];

export type PadMode = "local" | "devnet" | "mainnet";
export type ZcashNetwork = "regtest" | "test" | "main";

const MODE = (process.env.PAD_MODE ?? "local") as PadMode;
if (!["local", "devnet", "mainnet"].includes(MODE)) {
  throw new Error(`invalid PAD_MODE ${MODE}; expected local|devnet|mainnet`);
}

// Devnet and mainnet read their private RPC key from a file outside the repo (PAD_ENV_FILE, default
// ~/.config/snarks-pad/rpc.env) into this process only. Everything printed from here on is masked (src/util/redact.ts).
installRedaction();
if (MODE !== "devnet" && process.env.DEVNET_OWNER_KEYPAIR?.trim()) console.error(`DEVNET_OWNER_KEYPAIR is set but PAD_MODE=${MODE}: ignored; the keeper co-signs its own claims on the test network only`);
if (MODE === "devnet" && process.env.NODE_ENV !== "test") loadSecretEnvFile();

// engine/ is the cwd root for all relative paths below
const ENGINE_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(ENGINE_ROOT, "..");
const DATA_DIR = join(ENGINE_ROOT, "data");
const KEYS_DIR = join(ENGINE_ROOT, "keys");
const API_PORT = safeInt("PAD_API_PORT", 8787, 0, 65_535); // 0 = any free port (tests)
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(KEYS_DIR, { recursive: true });

// Meteora Dynamic Bonding Curve (DBC) + DAMM v2.
// The program ids and the DAMM v2 migration-fee config come from the SDK's own
// constants (never hand-typed). Local mode clones the MAINNET binaries and
// accounts into solana-test-validator, so the same ids work in local/mainnet.
export const ZEC_MINT_MAINNET = new PublicKey(REVIEWED_CONFIG.quoteMintMainnet);
// Devnet has no real ZEC: an 8-decimal stand-in mint (F-036 Q5). DBC has no quote whitelist.
const ZEC_MINT_DEVNET_STANDIN = new PublicKey("7gfeb6ysdFk7QmBp37nKZaYGHeJaoBccTd3QVAXh85vR");

// The DAMM v2 config a migrated pool uses is chosen at DBC-config creation
// time and is permanent for that config: FixedBps100 = 1% pool fee, so the
// post-migration holder income does not drop fourfold (plan 2d). Key read
// from the SDK: DAMM_V2_MIGRATION_FEE_ADDRESS[2] = Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp.
const MIGRATION_FEE_OPTION: MigrationFeeOption = REVIEWED_CONFIG.migrationFeeOption;

interface DbcNetConfig {
  programId: PublicKey;
  dammProgramId: PublicKey;
  dammConfig: PublicKey;
  migrationFeeOption: MigrationFeeOption;
  quoteMint: PublicKey;
  quoteDecimals: number;
  baseDecimals: number;
  totalSupply: number; // whole tokens
  feeBps: number; // pool trading fee, flat, fixed per config docs/API.md v2.0
  holderShareBps: number; // of the total fee: Meteora keeps 20%, the rest is claimed and paid out
  initialMarketCapZec: number; // whole ZEC; DBC_INITIAL_MCAP_ZEC
  migrationMarketCapZec: number; // whole ZEC; DBC_MIGRATION_MCAP_ZEC (local default: threshold 6.67 ZEC)
  configId: PublicKey | null; // an already-created config (mainnet: the owner creates it); null = keeper creates one
  // The fee claimer a NEW config is created with. null = the keeper key
  // (custody Option A). Set it to the Squads vault address for Option B.
  feeClaimer: PublicKey | null;
  // The Squads v4 multisig whose vault 0 is the fee claimer of Option-B
  // configs; the keeper must be one of its members. null = no Squads custody.
  squadsMultisig: PublicKey | null;
  // How final a claim must be before the ZEC it moved is counted as owed to
  // holders. A single local validator finalizes after 32 slots, so locally
  // "confirmed" keeps the suite fast; on a real cluster it is "finalized".
  claimCommitment: "confirmed" | "finalized";
}

/**
 * The permanent values (fee, curve market caps) come from dbc/reviewed.ts. Outside mainnet an env var may
 * override them for experiments; on mainnet a stray one is refused, because a config created with it is
 * permanent and the read-back would compare it against the same changed builder (CONFIG-REVIEW S1-L2).
 */
function reviewedOrEnv(mode: PadMode, name: (typeof PERMANENT_VALUE_ENV_VARS)[number], reviewed: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return reviewed;
  if (mode === "mainnet") {
    throw new Error(`${name} is set, but PAD_MODE=mainnet only accepts the reviewed value (${reviewed}): unset ${name}. A DBC config is permanent (audit/CONFIG-REVIEW.md S1-L2)`);
  }
  return Number(raw);
}

function dbcFor(mode: PadMode): DbcNetConfig {
  return {
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    dammProgramId: DAMM_V2_PROGRAM_ID,
    dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION]!,
    migrationFeeOption: MIGRATION_FEE_OPTION,
    quoteMint: mode === "devnet" ? (process.env.DEVNET_QUOTE_MINT ? new PublicKey(process.env.DEVNET_QUOTE_MINT) : ZEC_MINT_DEVNET_STANDIN) : ZEC_MINT_MAINNET,
    quoteDecimals: REVIEWED_CONFIG.quoteDecimals,
    baseDecimals: REVIEWED_CONFIG.baseDecimals,
    totalSupply: REVIEWED_CONFIG.totalSupply,
    feeBps: reviewedOrEnv(mode, "DBC_FEE_BPS", REVIEWED_CONFIG.feeBps),
    holderShareBps: REVIEWED_CONFIG.holderShareBps,
    initialMarketCapZec: reviewedOrEnv(mode, "DBC_INITIAL_MCAP_ZEC", REVIEWED_CONFIG.initialMarketCapZec),
    migrationMarketCapZec: reviewedOrEnv(mode, "DBC_MIGRATION_MCAP_ZEC", REVIEWED_CONFIG.migrationMarketCapZec),
    configId: process.env.DBC_CONFIG_ID ? new PublicKey(process.env.DBC_CONFIG_ID) : null,
    feeClaimer: process.env.FEE_CLAIMER_PUBKEY ? new PublicKey(process.env.FEE_CLAIMER_PUBKEY) : null,
    squadsMultisig: process.env.SQUADS_MULTISIG ? new PublicKey(process.env.SQUADS_MULTISIG) : null,
    claimCommitment: (process.env.PAD_CLAIM_COMMITMENT as "confirmed" | "finalized" | undefined) ?? (mode === "local" ? "confirmed" : "finalized"),
  };
}

/**
 * The devnet RPC URL. SOLANA_DEVNET_RPC wins: a full URL from any provider (QuickNode, Alchemy, ...), which is itself the secret because the
 * provider's key sits in its path or its query, so it lives only in this process and is masked in every log (src/util/redact.ts). Else the Helius
 * devnet endpoint when HELIUS_API_KEY is set; else the public endpoint, which rate-limits. An empty or blank SOLANA_DEVNET_RPC counts as not set
 * (a systemd EnvironmentFile line `SOLANA_DEVNET_RPC=`). A value that is not an http(s) URL stops startup, without printing it.
 * web3.js derives the websocket address its confirmations use from this URL: the same host, path and query over wss (test/rpc-url.test.ts).
 */
export function devnetRpc(env: NodeJS.ProcessEnv = process.env): string {
  const full = env.SOLANA_DEVNET_RPC?.trim();
  if (full) {
    if (!isHttpUrl(full)) throw new Error("SOLANA_DEVNET_RPC must be an http(s) URL (its value is not shown: it carries the provider's key)");
    return full;
  }
  if (env.HELIUS_API_KEY) return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`;
  return "https://api.devnet.solana.com";
}

function isHttpUrl(text: string): boolean {
  try {
    return /^https?:$/.test(new URL(text).protocol);
  } catch {
    return false;
  }
}

/** The host (and port) of an RPC URL: all a log line may say of it, because a keyed URL keeps its key in the path or the query. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
}

// Only the running mode's settings are read: a stray SOLANA_DEVNET_RPC cannot stop a mainnet start.
const RPC_BY_MODE: Record<PadMode, () => string> = {
  // SOLANA_LOCAL_RPC: the stress harness routes the engine through a fault-injecting proxy (engine/stress/fault-proxy.ts).
  local: () => process.env.SOLANA_LOCAL_RPC ?? "http://127.0.0.1:8899",
  devnet: () => devnetRpc(),
  mainnet: () => process.env.SOLANA_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com",
};
const SOLANA_RPC = RPC_BY_MODE[MODE]();

const ZCASH_NETWORK_BY_MODE: Record<PadMode, ZcashNetwork> = {
  local: "regtest",
  devnet: "test",
  mainnet: "main",
};

export const config = {
  mode: MODE,
  isLocal: MODE === "local",
  paths: {
    engineRoot: ENGINE_ROOT,
    repoRoot: REPO_ROOT,
    dataDir: DATA_DIR,
    keysDir: KEYS_DIR,
    // `bun test` sets NODE_ENV=test: a bare `bun test` (without the npm script's
    // PAD_DB_FILE) used to write test rows into the live data/local.sqlite.
    dbFile: process.env.PAD_DB_FILE ?? join(DATA_DIR, process.env.NODE_ENV === "test" ? "test.sqlite" : `${MODE}.sqlite`),
    keeperKeypair: process.env.KEEPER_KEYPAIR_PATH ?? join(KEYS_DIR, `keeper-${MODE}.json`),
    // The pad's launch signer (src/dbc/launchSigner.ts): read by the API, made by ops/keys-setup.sh <instance> signer; local mode makes its own.
    launchpadSigner: process.env.LAUNCHPAD_SIGNER_PATH ?? join(KEYS_DIR, `launchpad-signer-${MODE}.json`),
    // The kill switch (src/pause.ts): this file existing pauses every claim and payout, like PAYOUTS_PAUSED=1.
    pauseFile: process.env.PAD_PAUSE_FILE ?? join(DATA_DIR, "PAUSED"),
    // The keeper loop's one-line-per-tick health log (src/scheduler.ts).
    keeperHealthLog: process.env.PAD_KEEPER_HEALTH_LOG ?? join(DATA_DIR, "keeper-health.log"),
    // reused, already-working probe assets
    probeDbcDir: join(REPO_ROOT, "probe", "meteora-dbc"),
    probeZcashBatchDir: join(REPO_ROOT, "probe", "zcash-batch"),
    zcashDevtoolBin:
      process.env.ZCASH_DEVTOOL_BIN ?? join(REPO_ROOT, "probe", "zcash-batch", "work", "bin", "zcash-devtool"),
    zebradBin: process.env.ZEBRAD_BIN ?? join(REPO_ROOT, "probe", "zcash-batch", "work", "bin", "zebrad"),
    zainodBin: process.env.ZAINOD_BIN ?? join(REPO_ROOT, "probe", "zcash-batch", "work", "bin", "zainod"),
    zebradConfig: join(REPO_ROOT, "probe", "zcash-batch", "config", "zebrad.toml"),
    zainodConfig: join(REPO_ROOT, "probe", "zcash-batch", "config", "zainod.toml"),
    activationHeights: join(REPO_ROOT, "probe", "zcash-batch", "config", "activation-heights.toml"),
    zcashWorkDir: join(DATA_DIR, "zcash"),
    validatorLedger: join(DATA_DIR, "validator-ledger"),
    validatorLog: join(DATA_DIR, "validator.log"),
    validatorPid: join(DATA_DIR, "validator.pid"),
    zebradLog: join(DATA_DIR, "zcash", "zebrad.log"),
    zainodLog: join(DATA_DIR, "zcash", "zainod.log"),
    zebradPid: join(DATA_DIR, "zcash", "zebrad.pid"),
    zainodPid: join(DATA_DIR, "zcash", "zainod.pid"),
  },
  solana: {
    rpc: SOLANA_RPC,
    // What startup lines say of the RPC (never the URL itself).
    rpcHost: rpcHost(SOLANA_RPC),
    dbc: dbcFor(MODE),
  },
  zcash: {
    network: ZCASH_NETWORK_BY_MODE[MODE],
    rpcUrl: process.env.ZCASH_RPC_URL ?? "http://127.0.0.1:18232",
    // Regtest: our own zainod. Testnet (devnet mode): the public zec.rocks testnet server (devtool's built-in "zecrocks"
    // alias, verified 2026-10-01 to answer get-info/sync for chain "test"). Mainnet: set ZCASH_LIGHTWALLETD.
    lightwalletdServer: process.env.ZCASH_LIGHTWALLETD ?? (MODE === "devnet" ? "zecrocks" : "127.0.0.1:8137"),
    // sha256 of the zcash-devtool binary the operator built and copied here (scripts/build-devtool.sh prints it).
    // When set, every use of the binary first checks it (src/zcash/devtool.ts): it holds the treasury key.
    devtoolSha256: process.env.ZCASH_DEVTOOL_SHA256 ? process.env.ZCASH_DEVTOOL_SHA256.trim().toLowerCase() : null,
  },
  // The devnet test-money faucet (src/faucet.ts). Both amounts are SOL and both are safety knobs: a bad value stops startup (audit S3-03).
  faucet: {
    // What one fill pays out of the faucet key's own balance. A judge's session needs well under 0.01 SOL (one token account's rent,
    // 0.00204, and a few fees). Below 0.003 a buyer cannot open that account; above 1 is a typo, the faucet key holds about 1 SOL in all.
    devnetSol: safeSol("PAD_FAUCET_SOL", 0.02),
    // What the faucet key must still hold after a fill: the recipient's ZEC token-account rent (0.00204) + three fees (0.000015) + the
    // key's own rent-exempt floor (0.00089) is 0.00295, so below 0.003 a fill can run the key dry between its three transactions.
    minReserveSol: safeSol("PAD_FAUCET_MIN_RESERVE_SOL", 0.01),
  },
  api: {
    port: API_PORT,
    // Mints GET /api/coins lists by default (comma separated). Unset = every launched coin. `?all=1` lists them all either way;
    // a coin's own page and API route work whether it is listed or not. Used to keep QA and tier-showcase coins off a devnet board.
    featuredMints: (process.env.PAD_FEATURED_MINTS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    // Moderation (GAP-AUDIT G42): coins the pad keeps off every list (board, all=1, stats, trades, profiles), whatever the featured list says. Their own page
    // still opens, marked hidden, and their holders are still paid: nothing on chain changes.
    hiddenMints: (process.env.PAD_HIDDEN_MINTS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    // The API's chain routes together (trade-tx, creator-claim-tx, creator-fees) make at most this many chain reads an hour; past it they answer 503 and
    // the database views keep serving (audit S6, product decision 5: a public flood is bounded to this much of the API's own RPC budget, ops/DEPLOY.md 15).
    chainRouteCeilingPerHour: safeInt("PAD_API_CHAIN_ROUTE_CEILING_PER_HOUR", 3_000, 1),
  },
  // Files this engine hosts itself docs/API.md v2.7: uploaded coin images under <dir>/i and every coin's metadata JSON under <dir>/m.
  // On a server Caddy serves both directories as static files (ops/templates/Caddyfile.site); in dev and in tests the engine serves them.
  publicFiles: {
    dir: process.env.PUBLIC_DIR ?? join(DATA_DIR, process.env.NODE_ENV === "test" ? "public-test" : "public"),
    // The origin every file address starts with: written into each coin's on-chain metadata uri, so on mainnet it must be https
    // (the API refuses to start without it, src/publicFiles/ready.ts). The dev default is this engine's own address.
    baseUrl: parsePublicBaseUrl(process.env.PUBLIC_BASE_URL, API_PORT),
  },
  near1click: {
    baseUrl: "https://1click.chaindefuser.com/v0",
    // Optional partner key (header X-API-Key). Quotes, status and tokens work without one (PORT-ASSUMPTIONS N10). Never logged.
    apiKey: process.env.NEAR1CLICK_API_KEY ?? null,
    // Per-epoch swap size (plan P3): below the floor the epoch carries, above the cap the epoch pays Solana ZEC instead.
    minSwapZats: safeBigInt("PAD_SWAP_MIN_ZATS", 1_000_000n), // 0.01 ZEC
    maxSwapZats: safeBigInt("PAD_SWAP_MAX_ZATS", 50_000_000n), // 0.5 ZEC
    slippageBps: 100, // basis points (N5)
    // The request deadline: when 1Click starts refunding an undelivered swap. F-030 used 2 h (N6).
    quoteValidityMs: 2 * 60 * 60_000,
    // Refuse a quote whose minAmountOut is below amountIn by more than the withdraw fee (PAD_1CLICK_WITHDRAW_FEE_ZATS) plus this
    // (audit S6, product decision 2; was a flat 700 bps that bound only under 0.0046 ZEC). A refused quote carries the round's
    // shielded shares to the next shielded round; it never pays them on the public rail.
    maxLossBps: safeInt("PAD_SWAP_MAX_LOSS_BPS", 300, 0, 10_000),
    // How long one status() call keeps polling before returning "pending" (the next epoch run resumes). Must stay well under lockStaleMs.
    pollWindowMs: safeInt("PAD_SWAP_POLL_WINDOW_MS", 150_000, 1_000),
    // Tell 1Click the deposit hash right after it confirms (N14: optional, effect not measured).
    submitDepositHash: process.env.PAD_1CLICK_SUBMIT_DEPOSIT === "1",
    // Solana priority fee for the deposit tx, micro-lamports per compute unit (the F-030 wallet also set one).
    priorityMicroLamports: safeInt("PAD_SWAP_PRIORITY_MICROLAMPORTS", 50_000, 0, 5_000_000),
    // The treasury's Zcash wallet directory: settlement is read from it (N8), and the treasury address must belong to it.
    treasuryWalletDir: process.env.TREASURY_WALLET_DIR ?? null,
    // The age identity that unlocks that wallet's spending key: the shielded leg pays from it outside local mode (audit S2-05). A PATH, never the key.
    treasuryIdentityFile: process.env.TREASURY_IDENTITY_FILE ?? null,
    // Zcash confirmations the delivered note needs before the epoch counts it as settled and spends it.
    treasuryMinConfirmations: safeInt("PAD_SWAP_TREASURY_MIN_CONFS", 10, 0),
  },
  epoch: {
    // amounts below this many zats carry over to the next epoch instead of being sent
    dustFloorZats: 5_000n,
    // Fees held for a coin that had no eligible holder (coin_orphaned_zats) join the next paying round once held this long: 25% to the team, the
    // rest pro rata to the holders that round pays (audit S6, product decision 1). The coin's own holders get them sooner if any appear.
    orphanReleaseDays: safeInt("PAD_ORPHAN_RELEASE_DAYS", 30, 1),
    // Payout policy (plan 4 review 2026-09-30). A Solana ZEC payout to a wallet
    // with no ZEC token account must exceed the account rent, else it carries:
    // 0.00204 SOL ~ $0.41 (SOL $200 assumed, ZEC $1,587.48 F-033) ~ 25.8k zats,
    // rounded up. Env-tunable because SOL and ZEC prices move.
    newAccountMinZats: safeBigInt("PAD_NEW_ACCOUNT_MIN_ZATS", 30_000n),
    // A fee claim (and, with a Squads vault, an owner approval) is worth making
    // only above this many zats accrued. Fees below it stay safe in the pool
    // until they add up; nothing is lost by waiting (~$0.16 at ZEC $1,587).
    minClaimZats: safeBigInt("PAD_MIN_CLAIM_ZATS", 10_000n),
    // A holder's shielded share is held until it reaches this (Zcash fee is
    // 5,000 zats per output, so 100,000 keeps the fee at <= 5%).
    shieldedMinPerHolderZats: safeBigInt("PAD_SHIELDED_MIN_PER_HOLDER_ZATS", 100_000n),
    // The 1Click swap runs only when the shielded total is at least this
    // (its withdrawFee is 32,000 zats, F-009), else everything carries.
    shieldedMinSwapZats: safeBigInt("PAD_SHIELDED_MIN_SWAP_ZATS", 1_000_000n),
    // hard cap per shielded payout tx
    // PAD_STRESS_SHIELDED_PER_TX: local mode only, so the stress harness (engine/stress/) gets several Ironwood chunks
    // from a dozen recipients; ignored on every real network.
    maxShieldedRecipientsPerTx: MODE === "local" && process.env.PAD_STRESS_SHIELDED_PER_TX ? Number(process.env.PAD_STRESS_SHIELDED_PER_TX) : 350,
    // any nonzero balance counts as a holder; tune upward if dust wallets become noise
    minHolderBalanceRaw: 1n,
    // Anti-sniping holder samples (audit O-1, src/epoch/snapshots.ts): `count` samples at random times in the
    // epoch window, plus one at claim time; a holder's weight is its MINIMUM balance across them. A coin is
    // claimed only if its window holds at least `minWindowSamples` of them. Mainnet default: half the count, so
    // a manual run without the keeper cannot be sniped. Local and devnet default 0 = the claim-time sample alone
    // when no samples exist (tests, the e2e and the devnet judge flow run an epoch right after trading; nothing
    // there is real money). Samples that do exist are always used.
    snapshots: {
      count: safeInt("PAD_SNAPSHOT_COUNT", 6, 1, 1_000),
      minWindowSamples: safeInt("PAD_SNAPSHOT_MIN_SAMPLES", MODE === "mainnet" ? 3 : 0, 0),
    },
    // Claim kinds a round leaves in the pool (owner decision 2026-10-12: a round may pay out part of what has built up and let
    // the rest keep earning in the pool). Comma-separated db.ClaimKind names; unset = every kind is claimed. A claim of a held
    // kind that already started finishes, because its ZEC may be on its way.
    heldClaimKinds: parseClaimKinds("PAD_HELD_CLAIM_KINDS"),
    // Business model (owner policy 2026-10-12, published on the site, README and submission): of each claimed fee,
    // holders get 12.5% (0.10% of volume on the 1% tier) and the team 87.5% (0.70%); 75/25 before that. The team
    // share first pays shielded-delivery costs (src/epoch/split.ts). TEAM_WALLET is a Solana pubkey; unset = the
    // team share stays in the keeper and the ledger says so. Never hard-coded.
    team: {
      shareBps: parseTeamShareBps(process.env.PAD_TEAM_SHARE_BPS),
      wallet: parseTeamWallet(process.env.TEAM_WALLET),
      // What the team reserves for the swap's slippage on top of the withdraw fee and the Zcash fee.
      reserveBps: safeInt("PAD_DELIVERY_RESERVE_BPS", 100, 0, 10_000),
      // 1Click's withdrawFee, F-009 (the same number the simulated swap charges).
      withdrawFeeZats: safeBigInt("PAD_1CLICK_WITHDRAW_FEE_ZATS", 32_000n),
    },
    // An epoch still unfinished after this many runs, or this old, is parked (status needs_attention, an alert is
    // raised) so it stops blocking later epochs (audit O-2). It is still progressed on every run.
    stuckMaxAttempts: safeInt("PAD_STUCK_MAX_ATTEMPTS", 24, 1),
    stuckMaxAgeMs: safeInt("PAD_STUCK_MAX_AGE_MS", 24 * 3_600_000, 1),
    // A stale epoch-run lock (crashed process that never released it) is
    // takeable after this long. See engine/README.md "Concurrency".
    lockStaleMs: safeInt("EPOCH_LOCK_STALE_MS", 10 * 60_000, 1),
    // Chunk 2 of a multi-chunk shielded payout must not spend chunk 1's still-
    // unconfirmed change. On regtest we mine+sync between chunks (effectively
    // instant finality); on a real chain this is the minimum confirmations to
    // wait for chunk N's transaction before broadcasting chunk N+1. See
    // engine/README.md "Multi-chunk shielded payouts".
    zcashChunkConfirmations: safeInt("ZCASH_CHUNK_CONFIRMATIONS", 1, 0, 1_000), // mainnet default: 1 block
  },
  // The keeper loop (`bun run keeper`, src/scheduler.ts). Plan 4b: Solana ZEC payouts every 2 days, the shielded
  // batch weekly. The *_MS variables exist for tests and drills; the hours/days ones are the documented knobs.
  scheduler: {
    // Audit S6 (lens 6-1): a blank or misspelt value is the default or a refusal, never Number("") = 0 (a round every tick).
    epochEveryMs: safeInt("PAD_EPOCH_EVERY_MS", safeInt("PAD_EPOCH_EVERY_HOURS", 48, 1, 24 * 3_650) * 3_600_000, 1),
    shieldedEveryMs: safeInt("PAD_SHIELDED_EVERY_MS", safeInt("PAD_SHIELDED_EVERY_DAYS", 7, 1, 3_650) * 86_400_000, 1), // the soak drill sets 999 days
    // How often the loop wakes up, and how often it retries an unfinished epoch (a draft waiting for an approval, a parked one).
    tickMs: safeInt("PAD_KEEPER_TICK_MS", 60_000, 1),
    resumeEveryMs: safeInt("PAD_RESUME_EVERY_MS", 15 * 60_000, 0), // 0 = resume on every tick (the kill drill)
    // The first epoch is due at this instant (ISO) instead of one cadence after the keeper first started.
    firstEpochAt: process.env.PAD_FIRST_EPOCH_AT ?? null,
  },
  // Below this many lamports in the keeper's own wallet the keeper raises a stored `keeper_sol_low` alert (the health check sends it to Telegram): claims and
  // payouts pay fees and account rent in SOL, and a dry keeper fails every claim (devnet, 2026-10-06: 21 hours, 1,040 failed claims, nothing alerted). Default 0.05 SOL.
  keeperWallet: {
    lowLamports: safeInt("PAD_KEEPER_LOW_LAMPORTS", 50_000_000, 0),
  },
  // Test network only: the stand-in owner key (the multisig's second member) the keeper co-signs its own claims with, so a devnet round needs no
  // person (ops/DEPLOY.md: that key is on the devnet server; on mainnet the owner approves from their phone and no owner key exists on any server).
  // Read in devnet mode only: local and mainnet ignore the variable and say so at startup (test/devnet-cosigner.test.ts).
  devnetCoSignerKeypair: MODE === "devnet" ? process.env.DEVNET_OWNER_KEYPAIR?.trim() || null : null,
  // The RPC plan's credits a month (ops/MAINNET-RUNBOOK.md G13). The keeper projects the month from the last 24 hours of the rpc_usage table and warns at 50% and 80%
  // of it (src/rpcBudget.ts). 0 = unset = no check. A value that is not a whole number of at least 1 stops startup (audit S3-03): a typo must not turn the check off.
  rpc: {
    monthlyCredits: safeInt("PAD_RPC_MONTHLY_CREDITS", 0, 1),
    // Keys per getMultipleAccounts call, at most the public 100; the reader learns a smaller limit from the provider's own answer (src/multiAccounts.ts).
    multiAccountMax: safeInt("PAD_RPC_MULTI_ACCOUNT_MAX", 100, 1, 100),
  },
  simulatedSwap: {
    // Local-mode-only stand-in for a real bridge's market spread + withdraw
    // fee (see src/swap/simulated.ts), so local runs exercise finding 7's
    // "pay from actual settled output, not the harvested input" path instead
    // of a silent 1:1 pass-through. F-009's measured NEAR 1Click withdrawFee.
    spreadBps: safeInt("SIMULATED_SWAP_SPREAD_BPS", 25, 0, 10_000),
    withdrawFeeZats: safeBigInt("SIMULATED_SWAP_WITHDRAW_FEE_ZATS", 32_000n),
    // Devnet only: the Zcash TESTNET wallet that pays the simulated swap's coins into the pad's testnet treasury
    // (paths, never keys). The pad's treasury is TREASURY_WALLET_DIR; this is the liquidity source standing in for 1Click.
    fundingWalletDir: process.env.DEVNET_ZCASH_FUNDING_DIR ?? null,
    fundingIdentityFile: process.env.DEVNET_ZCASH_FUNDING_IDENTITY ?? null,
  },
} as const;

/**
 * A safety knob read from the environment (audit S3-03): unset or "" gives the default; anything that is not an integer
 * in [min, max] stops startup. Number("three") is NaN and every comparison with NaN is false, which used to turn the
 * check it fed off (the sample gate, the confirmation count) instead of failing.
 */
/**
 * A zat amount read from the environment with the safeInt rule (audit S6, lens 6-1): unset or blank is the default; anything
 * that is not a plain non-negative integer stops startup. BigInt("") used to read a blank PAD_SWAP_MAX_ZATS as 0n, a cap of
 * nothing, which paid every opted-in holder on the public rail.
 */
function safeBigInt(name: string, fallback: bigint, min = 0n): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d{1,30}$/.test(raw.trim())) throw new Error(`${name} must be a whole number of zats, got ${JSON.stringify(raw)}`);
  const n = BigInt(raw.trim());
  if (n < min) throw new Error(`${name} must be at least ${min}, got ${raw}`);
  return n;
}

function parseClaimKinds(name: string): ReadonlySet<ClaimKind> {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return new Set();
  const kinds = raw.split(",").map((k) => k.trim().toLowerCase()).filter((k) => k !== "");
  for (const k of kinds) if (!CLAIM_KINDS.includes(k as ClaimKind)) throw new Error(`${name} names an unknown claim kind ${JSON.stringify(k)}; known: ${CLAIM_KINDS.join(", ")}`);
  return new Set(kinds as ClaimKind[]);
}

function safeInt(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * A SOL amount read from the environment, with the same rule as safeInt (audit S3-03): unset or "" gives the default; anything
 * that is not a plain decimal in [0.003, 1] stops startup. Plain means digits and at most 9 decimals (whole lamports): no sign,
 * exponent, hex or "Infinity", which Number() would accept or turn into NaN, and a comparison against NaN is false.
 */
function safeSol(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  const n = Number(text);
  if (!/^\d+(\.\d{1,9})?$/.test(text) || n < 0.003 || n > 1) throw new Error(`${name} must be a SOL amount 0.003..1 (digits, at most 9 decimals), got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * PUBLIC_BASE_URL: an http(s) origin with no path, query or login, at most 100 characters (the metadata address `<origin>/m/<mint>.json` has to
 * fit the 200 characters Metaplex allows for a uri). Unset or "" gives this engine's own address, which only works on the machine it runs on.
 */
export function parsePublicBaseUrl(raw: string | undefined, port: number): string {
  const text = raw?.trim() ?? "";
  if (text === "") return `http://127.0.0.1:${port}`;
  let u: URL | null = null;
  try {
    u = new URL(text);
  } catch {
    /* refused below */
  }
  const origin = u && /^https?:$/.test(u.protocol) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash ? u.origin : null;
  if (!origin || origin.length > 100) throw new Error(`PUBLIC_BASE_URL must be an http(s) origin of at most 100 characters, like https://snarks.fun (no path, query or login), got ${JSON.stringify(text)}`);
  return origin;
}

function parseTeamShareBps(raw: string | undefined): number {
  const n = raw === undefined ? 8750 : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 8750) throw new Error(`PAD_TEAM_SHARE_BPS must be an integer 0..8750, got ${JSON.stringify(raw)}`);
  return n;
}

function parseTeamWallet(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new Error("TEAM_WALLET is not a valid Solana public key");
  }
}

export const ZATS_PER_ZEC = 100_000_000n;
