// Mirrors docs/API.md v2.9 (2026-10-06, shielded delivery is private: signed reads, and the wallet profile data; v2.8 2026-10-05, the launch window and the Creator wallet; coin images from a device, metadata and links v2.7; trader panel v2.6; explore v2.5; faucet status v2.4; creator-fee tiers v2.3; Meteora DBC). Amounts are strings in base units (zats, 8 decimals).

export type PadMode = 'local' | 'devnet' | 'mainnet'

export interface Coin {
  mint: string
  name: string
  symbol: string
  imageUrl: string
  description: string
  creator: string
  createdAt: string
  feeBps: number // the coin's fee TIER: the pool trading fee ON THE BONDING CURVE, flat, fixed for life by the DBC config it launched on (100, 200, 400, 600 or 1000 = 1% to 10%), paid in ZEC on every buy and sell. After graduation the DAMM v2 pool charges postGraduationFeeBps rising by up to a fifth in volatile trading (feeLabel in format.ts)
  // Of the whole trading fee (10000 bps), for THIS coin's tier (owner policy 2026-10-02). Meteora keeps 2000 at every tier.
  claimedShareBps: number // what the pad claims from Meteora's pool: 8000 on the 1% tier, less the creator's part on the others
  holderShareBps: number // what holders receive: 75% of the claimed part (6000 on the 1% tier = 0.60% of volume)
  teamShareBps: number // the team: 25% of the claimed part, which first pays the cost of delivering shielded rewards
  creatorShareBps: number // the creator's own part, claimed by the creator's wallet; 0 on the 1% tier
  postGraduationFeeBps: number // the fee of the graduated DAMM v2 pool before its dynamic part: equal to feeBps except the 10% tier, which drops to 600
  stage: 'curve' | 'graduated'
  venue: 'meteora-dbc' | 'meteora-damm-v2'
  hidden?: boolean // v2.9.1: the pad keeps this coin off its lists (moderation, PAD_HIDDEN_MINTS); its page still opens and its holders are still paid
  // v2.8.1: the three pool numbers come from the engine's read of the pool on chain. While the chain cannot be read and the engine has never read this coin they are
  // absent (never 0): the page shows the en dash.
  curveProgress?: number
  priceZec?: string // zats per 1 whole token, decimal string (can be < 1, e.g. "0.375")
  marketCapZec?: string
  poolId: string
  rewards: CoinRewards // this coin's own paid-to-holders (never a pad-wide total)
  // v2.5 docs/API.md "Explore"): optional, so a v2.4 engine still typechecks; the UI shows a dash for an absent one.
  // A v2.5 engine sends all five. Volume, trades and the price change count only the trades the ENGINE recorded (the web's own trade-confirm), not the pool's total.
  volume24hZats?: string // ZEC of the recorded trades of the last 24 hours, zats: a buy's is what was paid (fee included), a sell's what was received
  trades24h?: number
  holders?: number | null // the keeper's newest holder sample, else a count read in the background; null on the list for a coin whose first count is still coming (about a second)
  priceChange24hBps?: number | null // signed bps: priceZec now against the window's first recorded trade; null when the coin has no recorded trade in the last 24 hours
  graduatedAt?: string | null // when the pad recorded the move to DAMM v2 (it can trail the chain by an epoch run); null on the curve
  // v2.7: the creator's links, written at launch and never changed. Optional so an older engine still typechecks: the page shows no link row for an absent field.
  socials?: Socials
  // v2.8: the launch window of the coin's config and the wallet the chain records as the pool's creator. Optional so an older engine still typechecks; an absent value is the en dash or no line at all, never 0.
  launchWindow?: LaunchWindow | null // null = a coin launched on a flat-fee config (before v2.8): no window
  creatorWallet?: string // receives the creator's share of the fee and is the only wallet that can claim it; equal to `creator` unless a Creator wallet was set at launch
  // v2.8, GET /coins/:mint only, worked out per request from the chain's clock (never from the 3 s cache):
  feeNowBps?: number | null // the fee a trade landing now pays on the curve, in bps (a step of the window, then `feeBps`); null once graduated or when the chain could not be read
  windowSecondsLeft?: number // whole seconds until the window closes; 0 once it has (and for a coin with no window)
  // Not in any contract version yet (the web asked for it in the 2026-10-04 handover). The mock serves it so the design can be seen;
  // on an engine that does not send it the UI computes the number from the migration threshold.
  curveRoomZats?: string // ZEC the curve still needs before it graduates (migration threshold minus the quote reserve), zats; "0" once graduated
}

/**
 * A coin's launch window (contract v2.8 `Coin.launchWindow`): the fee is `cliffBps` in the pool's first period and falls in `periods` equal steps of `periodSeconds` to
 * `endBps` (the coin's tier fee), from `startsAt` to `endsAt` (ISO UTC). The page never counts down against these times and the visitor's own clock: it counts down from
 * `windowSecondsLeft` against its own monotonic clock (lib/window.ts).
 */
export interface LaunchWindow {
  cliffBps: number
  endBps: number
  periods: number
  periodSeconds: number
  startsAt: string
  endsAt: string
}

/** The creator's links (contract v2.7 `socials`). Each is an https URL or absent; the web checks before sending (lib/socials.ts), the engine checks again, and nothing but https is ever rendered as a link. */
export interface Socials {
  x?: string
  website?: string
  telegram?: string
}

// ---- v2.6 docs/API.md "Trader panel, live trades, rewards and ledgers"): read-only views, mirrored field for field.

/** GET /coins/:mint/quote: the numbers trade-tx would carry for the same side, amount and slippage, with no wallet. An indication, not a promise. */
export interface Quote {
  side: 'buy' | 'sell'
  in: string
  out: string // net of the pool fee
  minOut: string
  feeZec: string // the whole pool fee in zats; holders get Coin.holderShareBps / 10000 of it
  priceImpactBps: number // how much worse than the pool's price just before, fee left out; 0 for a trade too small to move it
  // v2.8, optional so an older engine still typechecks: the pool fee this trade pays in bps (a step of the launch window, or the coin's tier fee after it; null on the DAMM v2 route) and how long the window has left
  feeBps?: number | null
  windowSecondsLeft?: number
  route: 'curve' | 'damm'
  slippageBps: number
  at: string
}

/** A trade on the tape (GET /trades, GET /coins/:mint/trades, SSE GET /events/trades). `tags` holds "dev" when the wallet is the coin's creator; "you" is the web's. */
export interface FeedTrade extends Trade {
  mint: string
  symbol: string
  tags: 'dev'[]
}

export type HolderTag = 'dev' | 'pool'
/** One row of GET /coins/:mint/holders. A pool row is a Meteora vault: not a person, never paid; `label` says which pool. `pct` is of TOTAL supply. Since v2.9 nothing marks or counts the wallets that opted in to shielded delivery. */
export interface HolderRow {
  rank: number
  wallet: string
  balance: string
  pct: number
  tags: HolderTag[]
  label?: string
}
export interface Holders {
  holders: HolderRow[]
  total: number // rows to page through: holdersCount plus the pool rows
  holdersCount: number // eligible wallets, the same number as Coin.holders
  top10Pct: number // the ten largest eligible wallets together, % of total supply
  devPct: number
  poolPct: number | null
  supply: string
  asOf: string
  source: 'keeper_sample' | 'chain'
}

/** GET /coins/:mint/pot: what the pool has accrued for the pad and nobody has claimed yet, and when it is next paid. */
export interface Pot {
  accruedZats: string
  holdersZats: string // the holders' part under the pad's split, what the next round pays out once claimed
  teamZats: string
  minClaimZats: string // the keeper claims a coin only above this
  nextPayoutAt: string | null
  lastPayout: { epochId: string; at: string; totalZats: string; shieldedZats: string } | null
  asOf: string
}

/** GET /coins/:mint/fixed: what nobody can change about this coin, each value with the account it was read from (`source`; null = one of the engine's own settings). */
export interface Fixed {
  mint: string
  network: 'local' | 'devnet' | 'mainnet'
  config: { id: string; source: string }
  curveFee: { bps: number; source: string } // v2.8: the fee AFTER the launch window
  // v2.8: the window as a fixed fact. `source` is the config account (the scheduler and the first-buy flag), `poolSource` the pool account (the activation point). null = a flat-fee config. Optional so an older engine still typechecks.
  launchWindow?: (LaunchWindow & { firstSwapAtEndFee: boolean; source: string; poolSource: string }) | null
  graduatedFee: { minBps: number; maxBps: number; source: string }
  creatorShare: { bps: number; percentage: number; source: string }
  migration: { thresholdZats: string; source: string }
  liquidity: { partnerLockedPct: number; creatorLockedPct: number; unlockedPct: number; source: string }
  tokenAuthorities: { mintAuthority: string | null; freezeAuthority: string | null; updateAuthority: string | null; source: string }
  feeClaimer: {
    address: string
    kind: 'squads_vault' | 'other'
    multisig: { address: string; threshold: number; members: number; timeLock: number; autonomous: boolean } | null
    source: string
  }
  pause: {
    padCanPause: false
    curve: { pausableByMeteoraCurrentCode: false; source: string }
    pool: { pausableByMeteora: true; paused: boolean | null; source: string }
  }
  snapshotRule: { samplesPerWindow: number; windowHours: number; minBalanceRaw: string; rule: string; excluded: string[] }
  readAt: string
}

/** GET /rewards/:wallet: the public parts of one wallet's payouts. */
export interface SolanaPayout {
  epochId: string
  at: string
  sig: string // the batch transaction, shared by the wallets paid in it
  zats: string // what the round actually sent this wallet on the Solana rail
  coins: { mint: string; shareZats: string }[]
}
export interface ShieldedRound {
  epochId: string
  at: string
  snapshotSha256: string | null
  commitments: string[] // this wallet's rows of the published snapshot, as salted commitments: never an amount or an address
}
/** Payouts on the Solana rail: every one counted and added up, and the page asked for. */
export interface SolanaPayouts {
  count: number
  totalZats: string
  payouts: SolanaPayout[]
}
/** Since v2.9 the public answer holds the Solana-side payouts only: the shielded part moved behind the wallet's signature (OptinStatus). */
export interface Rewards {
  wallet: string
  solana: SolanaPayouts
  memoFormat: string
}

/** POST /rewards/verify-memo: what a pasted shielded-note memo proves. Never an error for a memo that is not the pad's: `matches` is false. */
export interface MemoCheck {
  epochId: string | null
  matches: boolean
  coins: { mint: string; symbol: string }[]
  checks: { memo: boolean; txid: boolean | null; commitment: boolean | null }
  round: {
    at: string
    status: string
    shielded: { count: number; totalZats: string }
    zcashTxids: string[]
    snapshot: { sha256: string; memoSig: string | null; url: string } | null
  } | null
  rows?: { mint: string; shareZats: string; commitment: string }[] // only with a valid signed proof: the wallet's own rows
}

/**
 * GET /stats (v2.5). Every field is optional: the page shows a dash for one that is absent, never 0.
 * `coins`, `graduated` and `volume24hZats` are about the coins the board lists (all of them with ?all=1); `paidSolanaZats`, `paidShieldedZats` and `optIns` are the pad's.
 * The engine sends exactly those six; `trades24h`, `holders` and `epochs` are not part of the contract (the mock still fills them).
 */
export interface Stats {
  coins?: number
  graduated?: number
  volume24hZats?: string
  trades24h?: number
  holders?: number
  paidSolanaZats?: string
  paidShieldedZats?: string
  epochs?: number
  optIns?: number // wallets with shielded delivery on now
}

export interface CoinRewards {
  paidSolanaZec: string
  paidShieldedZec: string
  epochs: number
}

export interface Trade {
  sig: string
  side: 'buy' | 'sell'
  wallet: string
  amountToken: string
  amountZec: string
  at: string
}

export interface CoinDetail extends Coin {
  holders: number | null // v2.8.1: null while the engine cannot read the chain and has no keeper sample for the coin (the page shows the en dash)
  recentTrades: Trade[]
}

export interface TradeQuote {
  in: string
  out: string
  minOut: string
  feeZec: string
  feeBps?: number | null // v2.8: set on a quote read without a wallet (GET /coins/:mint/quote); trade-tx's own quote has none
}

export interface Treasury {
  treasuryZats: string
  owedZats: string
  covered: boolean
  lastEpochAt: string | null
  nextEpochAt: string | null
  zcashNetwork: 'regtest' | 'test' | 'main'
  // The kill switch is on: the keeper is not claiming or paying. Nothing is lost by a pause.
  paused: boolean
  // Epochs that stayed unfinished too long and wait for the operator. Their payouts are still owed and counted above.
  epochsNeedingAttention: number
  // The devnet test-money faucet: whether its key can pay another fill, and how many fills it can still pay. null where there is no faucet (local, mainnet).
  faucet: { available: boolean; fillsLeft: number } | null
  // The published fee policy and the team's running ledger (aggregates only).
  policy: FeePolicy
  team: {
    wallet: string | null // where the team's Solana ZEC is sent; null = it stays in the keeper
    grossZats: string
    deliveryCostZats: string // what delivering shielded rewards cost, paid from the team share
    nativeZats: string // native ZEC left in the treasury wallet after delivery
    heldInKeeperZats: string // team Solana ZEC not yet sent to a team wallet
    sweptZats: string
  }
}

/** The published fee split (GET /treasury policy): Meteora's share of the whole fee, then how the pad splits what it claims. */
export interface FeePolicy {
  holdersShareOfClaimedBps: number
  teamShareOfClaimedBps: number
  meteoraShareOfFeeBps: number
}

export interface Epoch {
  id: string
  at: string
  coinMints: string[]
  harvestedZats: string // ZEC claimed from the pools this epoch (the name is kept from v1)
  solanaPayouts: { count: number; totalZats: string; sigs: string[] }
  shielded: {
    count: number
    totalZats: string
    swap: { provider: 'near-1click' | 'simulated'; ref: string }
    zcashTxids: string[]
  }
  feeZats: string
  // v2.6: the same two numbers as split.deliveryCostZats / split.teamNetZats, at the top level; absent on an older engine
  deliveryCostZats?: string | null
  teamNetZats?: string | null
  status: 'ok' | 'partial' | 'fallback_solana' | 'needs_attention'
  // Where the claimed fee went. deliveryCostZats and teamNetZats are null until the epoch's swap is resolved.
  split: { holdersZats: string; teamZats: string; deliveryCostZats: string | null; teamNetZats: string | null; holderShortfallZats: string }
  // The published holder snapshot: its sha256, the Solana memo that carries the same hash (null until sent), and where to fetch the file.
  snapshot?: { sha256: string; memoSig: string | null; url: string } | null
}

/**
 * POST /optin/status (contract v2.9, signed reads): a wallet's own shielded delivery. The engine answers it only against a fresh signature of that wallet over
 * the status text (api.ts shieldedViewMessage); nothing about opt-in is readable any other way, not even whether the wallet opted in.
 */
export interface OptinStatus {
  optedIn: boolean
  zcashAddressMasked: string | null // the first and last 4 characters; never the whole address
  pendingZats: string // waiting for the next weekly batch
  shielded: {
    rounds: number
    commitments: ShieldedRound[] // the shielded batches that paid this wallet
    fallback: SolanaPayouts // its shielded share paid as Solana ZEC in a round when the shielded batch could not run: its own to see, never in the public Rewards
  }
}

export type OptinError = 'invalid_signature' | 'no_orchard_receiver' | 'bad_address' | 'stale_nonce' | 'bad_wallet' | 'bad_request'

/** One entry of the fee-tier menu (GET /tiers). Shares are in bps of the whole fee and add up to 10000. */
export interface Tier {
  feeBps: number
  available: boolean // the pad has created and verified this tier's config on this network
  postGraduationFeeBps: number
  roundTripCostBps: number // what buying and selling straight back loses to the fee, of the amount
  meteoraShareBps: number
  creatorShareBps: number
  holderShareBps: number
  teamShareBps: number
  claimedShareBps: number
  // v2.8: the tier's launch window from the engine's reviewed numbers: `feeByPeriodBps` has `periods + 1` numbers, what a buy pays in each period, the first `cliffBps` and the last `endBps`.
  // `firstSwapAtEndFee`: the launcher's own first buy pays `endBps`. Optional so an older engine still typechecks: the Launch page shows a dash for an absent one.
  launchWindow?: TierWindow
  // v2.7: two fixed facts of the tier's config, read by the launch page's preview. Optional so an older engine still typechecks: the page shows a dash for an absent one.
  migrationThresholdZats?: string // the ZEC the curve must raise to graduate
  liquidity?: { partnerLockedPct: number; creatorLockedPct: number; unlockedPct: number } // of the graduated pool's liquidity: locked for good (the pad's part and the creator's) and not locked
}

/** A tier's launch window as GET /tiers sends it (contract v2.8). */
export interface TierWindow {
  cliffBps: number
  endBps: number
  periods: number
  periodSeconds: number
  durationSeconds: number
  feeByPeriodBps: number[]
  firstSwapAtEndFee: boolean
}

/** What a coin's creator can claim right now (GET /coins/:mint/creator-fees): public chain numbers. */
export interface CreatorFees {
  creator: string
  creatorShareBps: number
  curveZats: string
  poolZats: string
  graduated: boolean
}

export interface LaunchInput {
  creator: string
  name: string
  symbol: string
  description: string
  imageUrl: string // the address POST /uploads gave for the picked picture, or '' for none (v2.7: any other address is refused as bad_image_url)
  initialBuyZec?: string
  feeTier?: number // bps; default 100. Must be a tier the pad has created (GET /tiers)
  socials?: Socials // v2.7: the links that passed lib/socials.ts, as https URLs
  // v2.8: a wallet that receives the creator's share of the fee. The launch transaction hands the pool to it, so only it can claim, and the launcher never can. Only a wallet that passed lib/creatorWallet.ts, different from the launcher's, on a tier with a creator share, and ticked by the creator.
  creatorWallet?: string
}

/** POST /uploads (v2.7): where the stored copy of a picked picture is, and its size after the engine fitted it inside 1000 x 1000. */
export interface UploadedImage {
  url: string
  width: number
  height: number
  bytes: number
}

export interface PricePoint {
  at: string
  priceZec: string // zats per 1 whole token, decimal string: the trade's fee-adjusted average price
}

/** A coin in a wallet's profile (GET /wallets/:wallet): one the wallet launched or is the Creator wallet of. `status` is always 'launched': a pending launch is not listed. */
export interface WalletCoin {
  mint: string
  name: string
  symbol: string
  imageUrl: string
  creator: string // who launched it
  creatorWallet: string // who receives the creator's share of its fee, as the pad recorded it (the pool on chain is the final word: GET /coins/:mint/creator-fees)
  stage: 'curve' | 'graduated'
  createdAt: string
  feeBps: number
  creatorShareBps: number // 0 on the 1% tier
  status: 'launched'
}

/** A trade the wallet made on this pad (GET /wallets/:wallet): a buy's `amountZec` is what was paid, a sell's what was received. */
export interface WalletTrade {
  sig: string
  mint: string
  symbol: string
  side: 'buy' | 'sell'
  amountToken: string
  amountZec: string
  at: string
}

/** GET /wallets/:wallet (v2.9): what the pad's database says about a wallet, with no chain read. Nothing here is about rewards or shielded delivery. */
export interface WalletProfile {
  wallet: string
  launched: WalletCoin[] // newest first
  trades: WalletTrade[] // newest first, at most 50
  firstSeenAt: string | null // the wallet's first recorded trade or launch here; null when the pad has none
}

/** GET /coins/index (v2.9.1): every coin the pad has not hidden, with the last price the engine read (absent when it has not read one). No chain read. */
export interface IndexCoin { mint: string; name: string; symbol: string; imageUrl: string; priceZec?: string }
