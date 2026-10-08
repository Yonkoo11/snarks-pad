// In-browser mock of the engine API docs/API.md v2.8. Same shapes, same error codes.
// Signatures are verified for real (ed25519 via tweetnacl); everything else is made-up data.
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { Buffer } from 'buffer'
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import type { Api } from '../api'
import { ApiError, optinMessage, optoutMessage, receiptMessage, shieldedViewMessage } from '../api'
import { filterCoins, sortCoins } from '../coins'
import { MAX_UPLOAD_BYTES, problemWith } from '../upload'
import type { Coin, CoinRewards, CreatorFees, Epoch, FeedTrade, Fixed, HolderRow, Holders, LaunchWindow, MemoCheck, OptinStatus, Pot, PricePoint, Quote, Rewards, Stats, Tier, TierWindow, Trade, UploadedImage, WalletCoin, WalletProfile } from '../types'

const enc = new TextEncoder()
const h = (s: string) => nacl.hash(enc.encode(s)) // 64 bytes, deterministic
const pubkey = (seed: string) => bs58.encode(nacl.sign.keyPair.fromSeed(h(seed).slice(0, 32)).publicKey)
const sig = (seed: string) => bs58.encode(h(seed))
const hex = (seed: string) => Array.from(h(seed).slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join('')
const ZEC = (x: number) => String(Math.round(x * 1e8))
/** Mock only: ?fail=1 makes every read fail after its usual delay, so each page's error state can be seen; ?empty=1 is a pad with no coins and no payouts yet. */
const wait = async (ms = 220) => {
  await new Promise((r) => setTimeout(r, ms))
  if (/[?&]fail=1/.test(location.href)) throw new ApiError(500, 'internal_error')
}
const empty = () => /[?&]empty=1/.test(location.href)
const HOUR = 3_600_000
const NOW = Date.now()
const EPOCH_MS = 48 * HOUR // Solana ZEC every two days (the engine's default); the shielded batch rides every third round

export const SNARKS_MINT = pubkey('mint:SNARKS')
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
// The curve's migration threshold on the local config (engine/src/dbc/reviewed.ts migrationQuoteThreshold "666666666" raw units = 6.67 ZEC):
// "ZEC to go" on a card is the threshold minus what the curve holds.
const CURVE_TARGET_ZATS = 666_666_666
const MOCK_QUOTE_MINT = pubkey('mint:quote')
const SQUADS_VAULT = pubkey('squads:vault')
const SQUADS_MULTISIG = pubkey('squads:multisig')
const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'

// The fee-tier menu, as the engine computes it (engine/src/dbc/tiers.ts): Meteora keeps 20% of every fee, the creator takes a share of
// the rest, and the pad splits what it claims 75/25 between holders and the team. The mock builds the same numbers.
const CREATOR_PCT: Record<number, number> = { 100: 0, 200: 50, 400: 75, 600: 83, 1000: 90 }
const POST_FEE: Record<number, number> = { 100: 100, 200: 200, 400: 400, 600: 600, 1000: 600 }
// What each reviewed tier locks for good in the graduated pool (engine/src/dbc/reviewed.ts): the pad's part and the creator's, in percent. Every tier locks all of it.
const LOCKED_LP: Record<number, [partner: number, creator: number]> = { 100: [100, 0], 200: [50, 50], 400: [25, 75], 600: [17, 83], 1000: [17, 83] }
// The launch window every reviewed config carries (engine/src/dbc/reviewed.ts REVIEWED_WINDOW, contract v2.8): 99% in the pool's first second, 5 equal steps of 1 second down to the tier's own fee.
const WINDOW_CLIFF_BPS = 9900
const WINDOW_PERIODS = 5
const WINDOW_PERIOD_S = 1
/** What a trade pays in period k of the window, in bps: the cliff less k equal steps. Exact for every whole-bps tier, as the engine's is. */
const windowFeeBps = (feeBps: number, k: number): number => WINDOW_CLIFF_BPS - Math.min(k, WINDOW_PERIODS) * ((WINDOW_CLIFF_BPS - feeBps) / WINDOW_PERIODS)
const tierWindow = (feeBps: number): TierWindow => ({
  cliffBps: WINDOW_CLIFF_BPS, endBps: feeBps, periods: WINDOW_PERIODS, periodSeconds: WINDOW_PERIOD_S, durationSeconds: WINDOW_PERIODS * WINDOW_PERIOD_S,
  feeByPeriodBps: Array.from({ length: WINDOW_PERIODS + 1 }, (_, k) => windowFeeBps(feeBps, k)), firstSwapAtEndFee: true,
})
function tierOf(feeBps: number, available = true): Tier {
  const creator = (8000 * CREATOR_PCT[feeBps]) / 100
  const claimed = 8000 - creator
  const team = Math.floor((claimed * 2500) / 10_000)
  const f = feeBps / 10_000
  return {
    feeBps, available, postGraduationFeeBps: POST_FEE[feeBps], roundTripCostBps: Math.round((1 - (1 - f) ** 2) * 10_000),
    meteoraShareBps: 2000, creatorShareBps: creator, holderShareBps: claimed - team, teamShareBps: team, claimedShareBps: claimed,
    launchWindow: tierWindow(feeBps),
    migrationThresholdZats: String(CURVE_TARGET_ZATS),
    liquidity: { partnerLockedPct: LOCKED_LP[feeBps][0], creatorLockedPct: LOCKED_LP[feeBps][1], unlockedPct: 100 - LOCKED_LP[feeBps][0] - LOCKED_LP[feeBps][1] },
  }
}
const TIER_MENU = [100, 200, 400, 600, 1000]
/** Mock only: open the app with ?tier10=off to see a tier the pad has not created yet. A v2.5 engine (?v25=1) does not send the v2.7 tier facts and a v2.7 engine (?v27=1) not the v2.8 window, so the Launch page's dashes can be seen. */
const tiers = (): Tier[] => TIER_MENU.map((b) => {
  const t = tierOf(b, !(b === 1000 && /[?&]tier10=off/.test(location.href)))
  if (v27()) delete t.launchWindow
  if (!v25()) return t
  delete t.migrationThresholdZats
  delete t.liquidity
  return t
})
const coinTierFields = (feeBps: number): Pick<Coin, 'feeBps' | 'claimedShareBps' | 'holderShareBps' | 'teamShareBps' | 'creatorShareBps' | 'postGraduationFeeBps'> => {
  const t = tierOf(feeBps)
  return { feeBps, claimedShareBps: t.claimedShareBps, holderShareBps: t.holderShareBps, teamShareBps: t.teamShareBps, creatorShareBps: t.creatorShareBps, postGraduationFeeBps: t.postGraduationFeeBps }
}

function coin(ageHours: number, name: string, symbol: string, o: Partial<Coin>): Coin {
  const c: Coin = {
    mint: pubkey('mint:' + symbol), name, symbol, imageUrl: '', description: '',
    creator: pubkey('creator:' + symbol), createdAt: new Date(NOW - ageHours * HOUR).toISOString(),
    ...coinTierFields(100), stage: 'curve', venue: 'meteora-dbc', curveProgress: 0.1, priceZec: '10', marketCapZec: ZEC(10),
    poolId: pubkey('pool:' + symbol), rewards: { paidSolanaZec: '0', paidShieldedZec: '0', epochs: 0 },
    // v2.5 fields; a pad in its first week has small numbers
    volume24hZats: '0', trades24h: 0, holders: 1, priceChange24hBps: 0, graduatedAt: null,
    ...o,
  }
  // The room left on the curve follows from the progress, so the mock cannot contradict itself. (Not in contract v2.6: asked for in the handover.)
  return { curveRoomZats: c.stage === 'graduated' ? '0' : String(Math.round(CURVE_TARGET_ZATS * (1 - (c.curveProgress ?? 0)))), ...c }
}
/** Mock only: the pot a coin has accrued, a slice of the day's volume at the coin's fee, in zats. */
const accruedOf = (c: Coin): number => Math.round(Number(c.volume24hZats ?? '0') * (c.feeBps / 10_000) * (c.claimedShareBps / 10_000) * 1.4)

// Five coins, first-week numbers: 24h volumes 0.05 to 2.4 ZEC, 3 to 54 trades, ages 11 hours to 6 days, $SNARKS the oldest.
const seedCoins: Coin[] = [
  coin(6 * 24, 'Release The Snarks', 'SNARKS', {
    imageUrl: '/mascot-256.jpg', curveProgress: 0.62, priceZec: '12', marketCapZec: ZEC(120),
    description: 'Coin #1 on the pad. A tribute to the 2023 "RELEASE THE SNARKS!" video, where kids drew what zk-SNARKs look like. This one is a pink pizza-slice monster holding a ZEC card.',
    volume24hZats: ZEC(0.84), trades24h: 23, holders: 1284, priceChange24hBps: 420,
  }),
  coin(4 * 24, 'Shielded Pie', 'PIE', { ...coinTierFields(200), curveProgress: 0.34, priceZec: '6', marketCapZec: ZEC(60), description: 'A pie for every shielded note.', volume24hZats: ZEC(0.31), trades24h: 9, holders: 402, priceChange24hBps: -180 }),
  coin(3 * 24, 'Crayon Cat', 'CRAYON', { ...coinTierFields(400), curveProgress: 0.88, priceZec: '17', marketCapZec: ZEC(170), description: 'Drew outside the lines.', volume24hZats: ZEC(1.12), trades24h: 31, holders: 733, priceChange24hBps: 910 }),
  coin(5 * 24, 'Halo Arc', 'HALO', {
    stage: 'graduated', venue: 'meteora-damm-v2', curveProgress: 1, priceZec: '41', marketCapZec: ZEC(410), description: 'No trusted setup, no problem.',
    volume24hZats: ZEC(2.4), trades24h: 54, holders: 2210, priceChange24hBps: 120, graduatedAt: new Date(NOW - 2 * 24 * HOUR).toISOString(),
  }),
  coin(11, 'Zatoshi', 'ZATS', { ...coinTierFields(1000), curveProgress: 0.07, priceZec: '2', marketCapZec: ZEC(20), description: 'The smallest unit of fun.', volume24hZats: ZEC(0.05), trades24h: 3, holders: 57, priceChange24hBps: -2300 }),
]
// Two seed coins carry links, so the coin page's link row has something to show. Reserved example addresses: a made-up coin must not
// point at anyone's real account or site.
seedCoins[0].socials = { x: 'https://example.com/x/snarks', website: 'https://example.com/snarks' }
seedCoins[2].socials = { telegram: 'https://example.com/t/crayon' }
/** Mock only: ?many=1 adds 30 curve coins with no traction, so the pages of the Explore grid can be exercised. */
const many = () => /[?&]many=1/.test(location.href)
const manyCoins = (): Coin[] => Array.from({ length: 30 }, (_, k) => coin((k + 1) * 4, `Test coin ${k + 1}`, `TEST${k + 1}`, {
  curveProgress: ((k * 37) % 90) / 100 + 0.02, priceZec: String(1 + (k % 7)), marketCapZec: ZEC(10 + k * 3),
}))

// Per-coin totals that add up to less than the seven rounds below pay in all (Solana legs 1.3815 ZEC, shielded 0.0881 ZEC).
const rewardsBy: Record<string, CoinRewards> = {
  SNARKS: { paidSolanaZec: ZEC(0.4127), paidShieldedZec: ZEC(0.0431), epochs: 7 },
  PIE: { paidSolanaZec: ZEC(0.2012), paidShieldedZec: ZEC(0.0204), epochs: 7 },
  CRAYON: { paidSolanaZec: ZEC(0.1933), paidShieldedZec: ZEC(0), epochs: 5 },
  HALO: { paidSolanaZec: ZEC(0.3719), paidShieldedZec: ZEC(0.0217), epochs: 7 },
  ZATS: { paidSolanaZec: ZEC(0.0211), paidShieldedZec: ZEC(0), epochs: 2 },
}

// ---- persisted mock state (browser storage is a convenience; the mock works without it)
interface State { launched: Coin[]; optins: Record<string, { masked: string; at: string }> }
function load(): State {
  try {
    const raw = localStorage.getItem('snarks-mock-v1')
    if (raw) return JSON.parse(raw) as State
  } catch { /* storage blocked: start empty */ }
  return { launched: [], optins: {} }
}
const state = load()
function save() {
  try { localStorage.setItem('snarks-mock-v1', JSON.stringify(state)) } catch { /* ignore */ }
}
const nonces = new Map<string, { nonce: string; exp: number }>()

function withRewards(c: Coin): Coin {
  return { ...c, rewards: rewardsBy[c.symbol] || { paidSolanaZec: '0', paidShieldedZec: '0', epochs: 0 } }
}
/** Mock only: ?window=open makes the featured coin (SNARKS) look as if it launched the moment this page loaded, so its window is open for its first 5 seconds on this page's own clock and the countdown can be seen. Every other coin's window has closed. */
const windowSwitch = () => /[?&]window=open/.test(location.href)
const PAGE_LOADED_AT = Date.now()
/** The second a coin's pool was created, as the engine's activation point is: a whole unix second. */
const startOf = (c: Coin): number => Math.floor((windowSwitch() && c.symbol === 'SNARKS' ? PAGE_LOADED_AT : Date.parse(c.createdAt)) / 1000)
function launchWindowOf(c: Coin): LaunchWindow {
  const start = startOf(c)
  return {
    cliffBps: WINDOW_CLIFF_BPS, endBps: c.feeBps, periods: WINDOW_PERIODS, periodSeconds: WINDOW_PERIOD_S,
    startsAt: new Date(start * 1000).toISOString(), endsAt: new Date((start + WINDOW_PERIODS * WINDOW_PERIOD_S) * 1000).toISOString(),
  }
}
/** Mock only: what the engine adds on GET /coins/:mint and works out per request: the fee a trade pays now and the seconds the window has left, on this page's clock. No curve fee once graduated. */
function liveWindow(c: Coin): { feeNowBps: number | null; windowSecondsLeft: number } {
  if (c.stage === 'graduated') return { feeNowBps: null, windowSecondsLeft: 0 }
  const elapsed = Date.now() / 1000 - startOf(c)
  return { feeNowBps: windowFeeBps(c.feeBps, Math.max(0, Math.floor(elapsed))), windowSecondsLeft: Math.max(0, Math.ceil(WINDOW_PERIODS * WINDOW_PERIOD_S - elapsed)) }
}
/** The facts of a coin that do not move: its window, and the wallet the chain records as its pool's creator (the launcher unless the launch named a Creator wallet). */
const withWindowFacts = (c: Coin): Coin => ({ ...c, launchWindow: launchWindowOf(c), creatorWallet: c.creatorWallet ?? c.creator })
function allCoins(): Coin[] { return empty() ? [] : [...seedCoins, ...(many() ? manyCoins() : []), ...state.launched].map(withRewards).map(withWindowFacts) }
function findCoin(mint: string): Coin {
  const c = allCoins().find((x) => x.mint === mint)
  if (!c) throw new ApiError(404, 'not_found')
  return c
}

/** Mock only: open the app with ?live=1 and every read of a coin brings one new trade and nudges its price, market cap and curve, so the moving parts can be watched without an engine. */
const live = () => /[?&]live=1/.test(location.href)
let liveTick = 0
function liveCoin(c: Coin): Coin {
  if (!live() || liveTick === 0) return c
  const drift = 1 + 0.004 * liveTick
  return { ...c, priceZec: (Number(c.priceZec) * drift).toFixed(6), marketCapZec: String(Math.round(Number(c.marketCapZec) * drift)), curveProgress: Math.min(1, (c.curveProgress ?? 0) + 0.003 * liveTick) }
}
function liveTrades(c: Coin): Trade[] {
  return Array.from({ length: liveTick }, (_, k) => {
    const i = liveTick - k
    const zats = 3_000_000 + ((i * 2_654_435) % 40_000_000)
    return { sig: sig(`live:${c.symbol}:${i}`), side: i % 4 === 0 ? 'sell' : 'buy', wallet: pubkey(`lw:${c.symbol}:${i}`), amountZec: String(zats), amountToken: String(Math.round((zats / Number(c.priceZec)) * 1e6)), at: new Date(Date.now() - k * 6_000).toISOString() }
  })
}

function trades(c: Coin): Trade[] {
  return Array.from({ length: 8 }, (_, i) => {
    const side = (i * 7 + c.symbol.length) % 3 === 0 ? 'sell' : 'buy'
    const r = h(`size:${c.symbol}:${i}`)
    const zats = 2_000_000 + ((r[0] * 65_536 + r[1] * 256 + r[2]) % 90_000_000)
    return {
      // one trade per coin is the creator's own (the newest for coin #1, the second-newest elsewhere), so the tape's "dev" tag has something to mark
      sig: sig(`trade:${c.symbol}:${i}`), side, wallet: i === (c.symbol === 'SNARKS' ? 0 : 1) ? c.creator : pubkey(`w:${c.symbol}:${i}`),
      amountZec: String(zats), amountToken: String(Math.round((zats / Number(c.priceZec)) * 1e6)),
      at: new Date(NOW - (i * 11 + 3) * 60_000).toISOString(),
    }
  })
}

/** Mock only: a deterministic drift of ~60 trades that ends at the coin's price, at the newest trade (3 min ago), inside 8 hours. */
function pricePoints(c: Coin): PricePoint[] {
  const end = Number(c.priceZec)
  const n = 60
  let v = end * 0.55
  return Array.from({ length: n }, (_, i) => {
    const wobble = (((i * 2_654_435_761 + c.symbol.charCodeAt(0) * 40_503) >>> 0) % 1000) / 1000 - 0.5
    v += ((end - v) / (n - i)) * 1.2 + v * 0.035 * wobble
    return { at: new Date(NOW - 3 * 60_000 - (n - 1 - i) * 8 * 60_000).toISOString(), priceZec: i === n - 1 ? (c.priceZec ?? '0') : v.toFixed(6) }
  })
}

function epochs(): Epoch[] {
  const last = Math.floor(NOW / EPOCH_MS) * EPOCH_MS
  return Array.from({ length: 7 }, (_, i) => {
    const id = 42 - i
    const batchRound = i % 3 === 0 // rounds 0, 3 and 6 carry the shielded batch; the other rounds pay Solana ZEC only
    const fallback = i === 3 // this batch's swap did not complete, so its shielded holders were paid Solana ZEC
    const harvested = 18_000_000 + ((i * 3_331_777) % 22_000_000)
    const shieldedCount = batchRound && !fallback ? 6 + ((i * 5) % 9) : 0
    const team = Math.floor(harvested * 0.25) // owner policy: holders 75% of the claim, the team 25%
    const holders = harvested - team
    const shieldedTotal = shieldedCount ? Math.round(holders * 0.21) : 0
    const fee = shieldedCount ? 5000 * (shieldedCount + 1) : 0
    const solCount = 40 + ((i * 13) % 31)
    return {
      id: `epoch-${id}`, at: new Date(last - i * EPOCH_MS).toISOString(),
      coinMints: seedCoins.slice(0, 3 + (i % 3)).map((c) => c.mint),
      harvestedZats: String(harvested),
      solanaPayouts: {
        count: solCount + (fallback ? 7 : 0),
        totalZats: String(holders - shieldedTotal),
        sigs: Array.from({ length: 3 }, (_, k) => sig(`payout:${id}:${k}`)),
      },
      shielded: {
        count: shieldedCount, totalZats: String(shieldedTotal),
        swap: { provider: 'simulated', ref: shieldedCount ? `sim-${hex('swap:' + id).slice(0, 16)}` : '' },
        zcashTxids: shieldedCount ? [hex('ztx:' + id)] : [],
      },
      feeZats: String(fee),
      // v2.6: the same two numbers at the top level
      deliveryCostZats: String(shieldedCount ? fee + 32_000 : 0), teamNetZats: String(team - (shieldedCount ? fee + 32_000 : 0)),
      status: fallback ? 'fallback_solana' : 'ok',
      // The team pays the delivery cost (the 1Click withdraw fee and the Zcash fee) out of its share, so shielded holders get their full share.
      split: {
        holdersZats: String(holders), teamZats: String(team),
        deliveryCostZats: String(shieldedCount ? fee + 32_000 : 0),
        teamNetZats: String(team - (shieldedCount ? fee + 32_000 : 0)),
        holderShortfallZats: '0',
      },
    }
  })
}

/** A coin as a wallet's profile lists it (contract v2.9 GET /wallets/:wallet). */
const walletCoinOf = (c: Coin): WalletCoin => ({
  mint: c.mint, name: c.name, symbol: c.symbol, imageUrl: c.imageUrl, creator: c.creator, creatorWallet: c.creatorWallet ?? c.creator,
  stage: c.stage, createdAt: c.createdAt, feeBps: c.feeBps, creatorShareBps: c.creatorShareBps, status: 'launched',
})

/** Mock only: the newest trades of every coin on one tape, newest first (the live ones first when ?live=1); `dev` tagged as the engine does. */
function tape(limit: number, mint?: string): FeedTrade[] {
  const coins = allCoins().filter((c) => !mint || c.mint === mint)
  const rows: FeedTrade[] = []
  for (const c of coins) {
    const past = state.launched.some((l) => l.mint === c.mint) ? [] : trades(c)
    for (const t of [...(live() ? liveTrades(c) : []), ...past]) rows.push({ ...t, mint: c.mint, symbol: c.symbol, tags: t.wallet === c.creator ? ['dev'] : [] })
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)
}

const SUPPLY_BASE = 1_000_000_000 * 1e6 // 1B tokens in 6-decimal base units
/** Mock only: a holder sample in the contract's shape. The curve's vault holds the unsold supply (a pool row, never paid); the creator is tagged "dev". */
function holdersOf(c: Coin): Holders {
  const n = Math.min(20, Math.max(3, c.holders ?? 3))
  const poolPct = c.stage === 'graduated' ? 2.5 : Math.round((1 - (c.curveProgress ?? 0)) * 6000) / 100 // the curve still holds what it has not sold; a graduated pool keeps a little
  const left = 100 - poolPct
  const weights = Array.from({ length: n }, (_, i) => 1 / (i + 1.5))
  const sum = weights.reduce((a, b) => a + b, 0)
  const wallets: HolderRow[] = weights.map((w, i) => {
    const pct = Math.round((w / sum) * left * 100) / 100
    return { rank: 0, wallet: i === 1 ? c.creator : pubkey(`holder:${c.symbol}:${i}`), balance: String(Math.round((SUPPLY_BASE * pct) / 100)), pct, tags: i === 1 ? ['dev'] : [] }
  })
  const pool: HolderRow = { rank: 0, wallet: pubkey(`vault:${c.symbol}`), balance: String(Math.round((SUPPLY_BASE * poolPct) / 100)), pct: poolPct, tags: ['pool'], label: c.stage === 'graduated' ? 'Meteora DAMM v2 pool' : 'Meteora curve vault' }
  const rows = [pool, ...wallets].sort((a, b) => b.pct - a.pct).map((r, i) => ({ ...r, rank: i + 1 }))
  const count = Math.max(n, c.holders ?? n)
  return {
    holders: rows, total: count + 1, holdersCount: count,
    top10Pct: Math.round(wallets.slice(0, 10).reduce((a, r) => a + r.pct, 0) * 100) / 100, devPct: wallets[1]?.pct ?? 0, poolPct,
    supply: String(SUPPLY_BASE), asOf: new Date(NOW - 50 * 60_000).toISOString(), source: 'keeper_sample',
  }
}

/** Mock only: the chain-read facts of a coin in the contract's shape; the addresses are made up but stable. */
function fixedOf(c: Coin): Fixed {
  const grad = c.stage === 'graduated'
  const cfg = pubkey(`config:${c.feeBps}`)
  return {
    mint: c.mint, network: 'local',
    config: { id: cfg, source: cfg },
    curveFee: { bps: c.feeBps, source: cfg },
    ...(v27() ? {} : { launchWindow: { ...launchWindowOf(c), firstSwapAtEndFee: true, source: cfg, poolSource: c.poolId } }),
    graduatedFee: { minBps: c.postGraduationFeeBps, maxBps: Math.round(c.postGraduationFeeBps * 1.2), source: pubkey(`damm-config:${c.postGraduationFeeBps}`) },
    creatorShare: { bps: c.creatorShareBps, percentage: CREATOR_PCT[c.feeBps] ?? 0, source: cfg },
    migration: { thresholdZats: String(CURVE_TARGET_ZATS), source: cfg },
    liquidity: { partnerLockedPct: 100, creatorLockedPct: 0, unlockedPct: 0, source: cfg },
    tokenAuthorities: { mintAuthority: grad ? null : c.poolId, freezeAuthority: null, updateAuthority: null, source: c.mint },
    feeClaimer: { address: SQUADS_VAULT, kind: 'squads_vault', multisig: { address: SQUADS_MULTISIG, threshold: 2, members: 3, timeLock: 0, autonomous: true }, source: cfg },
    pause: { padCanPause: false, curve: { pausableByMeteoraCurrentCode: false, source: DBC_PROGRAM }, pool: { pausableByMeteora: true, paused: grad ? false : null, source: grad ? c.poolId : DAMM_V2_PROGRAM } },
    snapshotRule: { samplesPerWindow: 6, windowHours: 48, minBalanceRaw: '1', rule: 'the least balance a wallet showed across the window\'s random samples and the one at claim time', excluded: ['pool vaults', 'the keeper', 'fee claimers', 'Squads members'] },
    readAt: new Date(NOW - 20_000).toISOString(),
  }
}

/** Mock only: a coin's pot in the contract's shape, from the same numbers the epochs list uses. */
function potOf(c: Coin): Pot {
  const accrued = accruedOf(c)
  const team = Math.floor((accrued * 2500) / 10_000)
  const last = Math.floor(NOW / EPOCH_MS) * EPOCH_MS
  const e = empty() ? undefined : epochs().find((x) => x.coinMints.includes(c.mint))
  const share = e ? 1 / e.coinMints.length : 0
  return {
    accruedZats: String(accrued), holdersZats: String(accrued - team), teamZats: String(team), minClaimZats: '1000',
    nextPayoutAt: empty() ? null : new Date(last + EPOCH_MS).toISOString(),
    lastPayout: e ? { epochId: e.id, at: e.at, totalZats: String(Math.round(Number(e.split.holdersZats) * share)), shieldedZats: String(Math.round(Number(e.shielded.totalZats) * share)) } : null,
    asOf: new Date(NOW - 5_000).toISOString(),
  }
}

/** `cosigner`: a second required signer (a launch's new coin address, which the page signs with after the wallet, as on chain). */
function unsignedTx(payer: string, memo: string, cosigner?: string): string {
  const keys = cosigner ? [{ pubkey: new PublicKey(cosigner), isSigner: true, isWritable: false }] : []
  const msg = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: bs58.encode(h('blockhash:' + memo).slice(0, 32)),
    instructions: [new TransactionInstruction({ programId: MEMO, keys, data: Buffer.from(memo, 'utf8') })],
  }).compileToV0Message()
  const bytes = new VersionedTransaction(msg).serialize()
  let s = ''
  bytes.forEach((b) => (s += String.fromCharCode(b)))
  return btoa(s)
}

/** Mock stand-in for "send to the Solana cluster": checks every required ed25519 signature (the fee payer's and a launch's coin address), returns a sig. */
export function mockSend(signed: VersionedTransaction): string {
  const msg = signed.message.serialize()
  const n = signed.message.header.numRequiredSignatures
  for (let i = 0; i < n; i++) {
    const ok = nacl.sign.detached.verify(msg, signed.signatures[i], signed.message.staticAccountKeys[i].toBytes())
    if (!ok) throw new ApiError(400, 'invalid_signature')
  }
  return bs58.encode(signed.signatures[0])
}

function validUnified(a: string): 'ok' | 'no_orchard_receiver' | 'bad_address' {
  const s = a.trim()
  if (/^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]{20,}$/.test(s)) return 'no_orchard_receiver'
  if (/^(zs|ztestsapling|zregtestsapling)1[02-9ac-hj-np-z]{20,}$/.test(s)) return 'no_orchard_receiver'
  // The mock cannot decode receivers; the engine does. It accepts a well-formed u1 of plausible length.
  if (/^(u|utest|uregtest)1[02-9ac-hj-np-z]{100,}$/.test(s)) return 'ok'
  return 'bad_address'
}
// The engine's masking (engine/src/zcash/address.ts maskZcashAddress): the first four and the last four characters, never more.
function mask(a: string) { return `${a.slice(0, 4)}…${a.slice(-4)}` }

function takeNonce(wallet: string, nonce: string) {
  const n = nonces.get(wallet)
  if (!n || n.nonce !== nonce || n.exp < Date.now()) throw new ApiError(400, 'stale_nonce')
  nonces.delete(wallet)
}
function verify(message: string, signature: string, wallet: string): boolean {
  try {
    return nacl.sign.detached.verify(enc.encode(message), bs58.decode(signature), bs58.decode(wallet))
  } catch { return false }
}

/** Mock only: ?stats=off makes the mock a v2.4 engine (every coin, no `total`, no /stats), so the page's own filtering, sorting, paging and sums can be seen. */
const v24 = () => /[?&]stats=off/.test(location.href)
/** Mock only: ?v25=1 answers like a v2.5 engine (the one live on snarks.fun on 2026-10-04): no quote, holders, fixed, trades, rewards, verify-memo or CSV route (404 not_found) and no v2.6 field on a coin, so every hidden state can be seen. */
const v25 = () => /[?&]v25=1/.test(location.href) || v24()
/** Mock only: ?v27=1 answers like the v2.7 engine that was live before the launch window: no window, no creator wallet, no live fee (every v2.8 field absent), so the pages' dashes and plain states can be seen. A v2.5 engine lacks them too. */
const v27 = () => /[?&]v27=1/.test(location.href) || v25()
const gone = (): never => { throw new ApiError(404, 'not_found') }
const V26_FIELDS = ['socials', 'curveRoomZats'] as const
const V28_FIELDS = ['launchWindow', 'creatorWallet', 'feeNowBps', 'windowSecondsLeft'] as const
function stripV26<T extends Coin>(c: T): T {
  if (!v25() && !v27()) return c
  const out = { ...c }
  if (v25()) for (const k of V26_FIELDS) delete (out as Partial<Coin>)[k]
  if (v27()) for (const k of V28_FIELDS) delete (out as Partial<Coin>)[k]
  return out
}

/** The coin keys launchTx made and launchCosign has not used yet, as the engine keeps them (engine dbc/cosign.ts). */
const heldCoinKeys = new Map<string, Uint8Array>()

/** The pictures this mock's upload has handed out in this page's life: the only ones launchTx takes, as the engine takes only its own uploads. */
const issuedImages = new Set<string>()

/** What the engine's re-encode gives, kept small enough for this browser's storage: the picture fitted inside 256 x 256 and written as a data address, so a launched test coin keeps its picture after a reload. */
async function storedCopy(file: Blob): Promise<UploadedImage> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new ApiError(400, 'bad_image') })
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ApiError(500, 'internal_error')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const url = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9)
  return { url, width, height, bytes: Math.round(((url.length - url.indexOf(',') - 1) * 3) / 4) }
}

export const mock: Api = {
  // v2.5 shape: the query is applied here and the answer carries `total`, as the engine does.
  async coins(q) {
    await wait()
    const all = allCoins().map(liveCoin).map(stripV26)
    if (v24()) return { coins: all }
    const list = sortCoins(filterCoins(all, q ?? {}), q?.sort ?? 'mcap')
    const offset = q?.offset ?? 0
    return { coins: list.slice(offset, offset + (q?.limit ?? list.length)), total: list.length }
  },
  async stats(): Promise<Stats> {
    await wait(120)
    if (v24()) throw new ApiError(404, 'not_found')
    const all = allCoins()
    const eps = empty() ? [] : epochs()
    return {
      coins: all.length, graduated: all.filter((c) => c.stage === 'graduated').length,
      volume24hZats: String(all.reduce((a, c) => a + BigInt(c.volume24hZats ?? '0'), 0n)),
      trades24h: all.reduce((a, c) => a + (c.trades24h ?? 0), 0), holders: all.reduce((a, c) => a + (c.holders ?? 0), 0),
      paidSolanaZats: String(eps.reduce((a, e) => a + BigInt(e.solanaPayouts.totalZats), 0n)),
      paidShieldedZats: String(eps.reduce((a, e) => a + BigInt(e.shielded.totalZats), 0n)), epochs: eps.length,
      optIns: empty() ? 0 : 7 + Object.keys(state.optins).length, // 7 wallets opted in on the made-up pad, plus this browser's own
    }
  },
  async coin(mint) {
    await wait()
    if (live()) liveTick++
    const c = stripV26(liveCoin(findCoin(mint)))
    const holders = (c.holders ?? 1) + (live() ? liveTick : 0)
    const past = state.launched.some((l) => l.mint === c.mint) ? [] : trades(c)
    return { ...c, ...(v27() ? {} : liveWindow(c)), holders, recentTrades: live() ? [...liveTrades(c), ...past] : past }
  },
  async priceHistory(mint) {
    await wait()
    const c = findCoin(mint)
    // Mock only: open the app with ?chart=empty or ?chart=error to see those states.
    if (/[?&]chart=error/.test(location.href)) throw new ApiError(500, 'internal_error')
    if (state.launched.some((l) => l.mint === c.mint) || /[?&]chart=empty/.test(location.href)) return { points: [] }
    return { points: pricePoints(c) }
  },
  async tiers() { await wait(120); return { tiers: tiers(), ...(v25() ? {} : { quoteMint: MOCK_QUOTE_MINT }) } },
  // The engine re-encodes the picture and stores its own copy. The mock keeps a small one in this browser; ?upload=fail makes every upload fail, so the page's "Try again" can be seen.
  async upload(file) {
    await wait(450)
    if (/[?&]upload=fail/.test(location.href)) throw new ApiError(502, 'internal_error')
    if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'body_too_large')
    if (await problemWith(file)) throw new ApiError(400, 'bad_image')
    const stored = await storedCopy(file)
    issuedImages.add(stored.url)
    return stored
  },
  async creatorFees(mint): Promise<CreatorFees> {
    await wait()
    const c = findCoin(mint)
    const graduated = c.stage === 'graduated'
    // Mock only: made-up amounts that grow with the tier's creator share.
    const unit = Math.round(c.creatorShareBps * 1200)
    return { creator: c.creatorWallet ?? c.creator, creatorShareBps: c.creatorShareBps, curveZats: c.creatorShareBps === 0 ? '0' : String(unit), poolZats: graduated && c.creatorShareBps > 0 ? String(unit * 2) : '0', graduated }
  },
  async creatorClaimTx(mint, wallet, kind) {
    await wait()
    const c = findCoin(mint)
    if ((c.creatorWallet ?? c.creator) !== wallet) throw new ApiError(403, 'not_creator')
    if (c.creatorShareBps === 0) throw new ApiError(400, 'no_creator_fee')
    const f = await mock.creatorFees(mint)
    const chosen = kind ?? (BigInt(f.curveZats) > 0n ? 'curve' : 'pool')
    const amount = chosen === 'curve' ? f.curveZats : f.poolZats
    if (BigInt(amount) <= 0n) throw new ApiError(400, 'nothing_to_claim')
    return { tx: unsignedTx(wallet, `claim ${c.symbol} ${chosen}`), kind: chosen, claimableZats: amount }
  },
  async launchTx(input) {
    await wait()
    if (!input.name.trim() || !/^[A-Z0-9]{2,10}$/.test(input.symbol)) throw new ApiError(400, 'bad_input')
    // as the engine: a picture is one the pad's own upload gave, or none; any other address (a link, a data: address) is refused
    if (input.imageUrl && !issuedImages.has(input.imageUrl)) throw new ApiError(400, 'bad_image_url')
    const feeTier = input.feeTier ?? 100
    if (!TIER_MENU.includes(feeTier)) throw new ApiError(400, 'bad_request')
    if (!tiers().find((t) => t.feeBps === feeTier)!.available) throw new ApiError(503, 'tier_unavailable')
    // as the engine (v2.9.1): the coin's key is made and kept here; the wallet signs first and launchCosign adds the coin's signature
    const coinKey = nacl.sign.keyPair()
    const mint = bs58.encode(coinKey.publicKey)
    heldCoinKeys.set(mint, coinKey.secretKey)
    // a Creator wallet other than the launcher's: the pool is handed to it, so it is the creator the chain records (the page has already checked the address; the engine's own checks are not repeated here)
    const creatorWallet = input.creatorWallet && input.creatorWallet !== input.creator ? input.creatorWallet : undefined
    const pending: Coin = {
      mint, name: input.name.trim(), symbol: input.symbol, imageUrl: input.imageUrl, description: input.description,
      creator: input.creator, createdAt: new Date().toISOString(), ...coinTierFields(feeTier), stage: 'curve', venue: 'meteora-dbc',
      curveProgress: 0, priceZec: '1', marketCapZec: ZEC(10), poolId: pubkey('pool:' + mint), rewards: { paidSolanaZec: '0', paidShieldedZec: '0', epochs: 0 },
      curveRoomZats: String(CURVE_TARGET_ZATS), ...(input.socials ? { socials: input.socials } : {}), ...(creatorWallet ? { creatorWallet } : {}),
    }
    pendingLaunch.set(mint, pending)
    return { tx: unsignedTx(input.creator, `launch ${input.symbol}`, mint), mint }
  },
  async coinIndex() {
    await wait()
    return { coins: allCoins().map(({ mint, name, symbol, imageUrl, priceZec }) => ({ mint, name, symbol, imageUrl, ...(priceZec ? { priceZec } : {}) })) }
  },
  async launchCosign(mint, tx) {
    await wait()
    const secret = heldCoinKeys.get(mint)
    if (!secret) throw new ApiError(404, 'unknown_launch')
    heldCoinKeys.delete(mint)
    const signed = VersionedTransaction.deserialize(Uint8Array.from(atob(tx), (c) => c.charCodeAt(0)))
    const msg = signed.message.serialize()
    if (!nacl.sign.detached.verify(msg, signed.signatures[0], signed.message.staticAccountKeys[0].toBytes())) throw new ApiError(400, 'tx_mismatch')
    const i = signed.message.staticAccountKeys.findIndex((k) => k.toBase58() === mint)
    if (i < 0) throw new ApiError(400, 'tx_mismatch')
    signed.signatures[i] = nacl.sign.detached(msg, secret)
    let out = ''
    signed.serialize().forEach((b) => (out += String.fromCharCode(b)))
    return { tx: btoa(out) }
  },
  async confirmLaunch(_sig, mint) {
    await wait()
    const c = pendingLaunch.get(mint)
    if (!c) throw new ApiError(404, 'not_found')
    state.launched.push(c); pendingLaunch.delete(mint); save()
    return { ok: true }
  },
  async tradeConfirm(mint, _sig) {
    await wait()
    findCoin(mint)
    return { ok: true }
  },
  async tradeTx(mint, body) {
    await wait()
    const c = findCoin(mint)
    const amt = Number(body.amount)
    if (!(amt > 0)) throw new ApiError(400, 'bad_amount')
    if (body.side === 'buy' && c.stage === 'curve' && amt > Number(c.curveRoomZats ?? Infinity)) throw new ApiError(400, 'bad_amount') // more than the curve can fill
    const q = quoteFor(c, body.side, amt, body.slippageBps)
    return { tx: unsignedTx(body.wallet, `${body.side} ${c.symbol} ${amt}`), quote: { in: q.in, out: q.out, minOut: q.minOut, feeZec: q.feeZec } }
  },
  // v2.6: the same numbers with no wallet, plus the price impact. The mock's curve deepens with the market cap: a buy of x against a
  // pool holding m moves the price by about x / (m + x).
  async quote(mint, q) {
    await wait(150)
    if (v25()) gone()
    const c = findCoin(mint)
    const amt = Number(q.amount)
    if (!(amt > 0)) throw new ApiError(400, 'bad_amount')
    if (q.side === 'buy' && c.stage === 'curve' && amt > Number(c.curveRoomZats ?? Infinity)) throw new ApiError(400, 'bad_amount')
    return quoteFor(c, q.side, amt, q.slippageBps)
  },
  async holders(mint, q): Promise<Holders> {
    await wait()
    if (v25()) gone()
    const h = holdersOf(findCoin(mint))
    const offset = q?.offset ?? 0
    return { ...h, holders: h.holders.slice(offset, offset + (q?.limit ?? 20)) }
  },
  async pot(mint): Promise<Pot> { await wait(120); if (v25()) gone(); return potOf(findCoin(mint)) },
  async fixed(mint): Promise<Fixed> { await wait(); if (v25()) gone(); return fixedOf(findCoin(mint)) },
  async trades(q) { await wait(120); if (v25()) gone(); return { trades: tape(q.limit ?? 30, q.mint) } },
  tradeStreamUrl: () => null,
  async rewards(wallet): Promise<Rewards> {
    await wait()
    if (v25()) gone()
    const memoFormat = 'SNARKS pad reward, epoch <epochId>'
    if (empty()) return { wallet, solana: { count: 0, totalZats: '0', payouts: [] }, memoFormat }
    const eps = epochs()
    // three rounds paid this wallet on the Solana rail: two coins in the first, one in the others
    const payouts = [1, 2, 3].map((k, i) => {
      const e = eps[k]
      const coins = (i === 0 ? [seedCoins[0], seedCoins[1]] : [seedCoins[i === 1 ? 1 : 0]]).map((c, j) => ({ mint: c.mint, shareZats: String(90_000 + ((i * 97_531 + j * 40_111) % 160_000)) }))
      const zats = coins.reduce((a, c) => a + Number(c.shareZats), 0)
      return { epochId: e.id, at: e.at, sig: sig(`reward:${e.id}:batch`), zats: String(zats), coins }
    })
    const total = payouts.reduce((a, p) => a + Number(p.zats), 0)
    return { wallet, solana: { count: payouts.length, totalZats: String(total), payouts }, memoFormat }
  },
  // A memo that is not the pad's, or names no published round, is 200 with matches false, never an error (contract v2.6).
  async verifyMemo(body): Promise<MemoCheck> {
    await wait(150)
    if (v25()) gone()
    if (typeof body.memo !== 'string' || body.memo.length > 512) throw new ApiError(400, 'bad_request')
    const m = /^SNARKS pad reward, epoch (\S+)$/.exec(body.memo.trim())
    const e = m ? epochs().find((x) => x.id === m[1]) : undefined
    const memoOk = !!e && e.shielded.count > 0
    const txidOk = body.txid === undefined ? null : !!e && e.shielded.zcashTxids.includes(body.txid)
    let commitment: boolean | null = null
    let rows: MemoCheck['rows']
    if (body.wallet || body.nonce || body.signature) {
      if (!body.wallet || !body.nonce || !body.signature || !e) throw new ApiError(400, 'bad_request')
      if (!verify(receiptMessage(body.wallet, e.id, body.nonce), body.signature, body.wallet)) throw new ApiError(400, 'invalid_signature')
      takeNonce(body.wallet, body.nonce)
      commitment = memoOk && !!state.optins[body.wallet]
      rows = commitment ? e.coinMints.slice(0, 2).map((mint, i) => ({ mint, shareZats: String(70_000 + i * 31_000), commitment: hex(`commit:${body.wallet}:${e.id}`) })) : []
    }
    const coins = e ? e.coinMints.map((mint) => ({ mint, symbol: allCoins().find((c) => c.mint === mint)?.symbol ?? '' })) : []
    return {
      epochId: e ? e.id : null, matches: memoOk && txidOk !== false && commitment !== false, coins,
      checks: { memo: memoOk, txid: txidOk, commitment },
      round: e ? { at: e.at, status: e.status, shielded: { count: e.shielded.count, totalZats: e.shielded.totalZats }, zcashTxids: e.shielded.zcashTxids, snapshot: null } : null,
      ...(rows ? { rows } : {}),
    }
  },
  // The mock has no server to serve a file, so the CSV is built here: one row per round, the engine's columns in the engine's order.
  async epochsCsv() {
    await wait(80)
    if (v25()) return null
    const head = 'epochId,at,status,coinMints,claimedZats,holdersZats,teamZats,deliveryCostZats,teamNetZats,holderShortfallZats,zcashNetworkFeeZats,solanaPayoutCount,solanaPayoutZats,shieldedCount,shieldedZats,snapshotSha256,snapshotMemoSig'
    const rows = epochs().map((e) => [e.id, e.at, e.status, e.coinMints.join(';'), e.harvestedZats, e.split.holdersZats, e.split.teamZats, e.split.deliveryCostZats ?? '', e.split.teamNetZats ?? '', e.split.holderShortfallZats, e.feeZats, e.solanaPayouts.count, e.solanaPayouts.totalZats, e.shielded.count, e.shielded.totalZats, '', ''].join(','))
    return URL.createObjectURL(new Blob([[head, ...rows].join('\n') + '\n'], { type: 'text/csv' }))
  },
  async optinNonce(wallet) {
    await wait(120)
    const nonce = bs58.encode(nacl.randomBytes(12))
    nonces.set(wallet, { nonce, exp: Date.now() + 5 * 60_000 })
    return { nonce, message: optinMessage(wallet, '<u1 address>', nonce) }
  },
  async optin({ wallet, zcashAddress, nonce, signature }) {
    await wait()
    const v = validUnified(zcashAddress)
    if (v !== 'ok') throw new ApiError(400, v)
    if (!verify(optinMessage(wallet, zcashAddress.trim(), nonce), signature, wallet)) throw new ApiError(400, 'invalid_signature')
    takeNonce(wallet, nonce)
    const at = new Date().toISOString()
    state.optins[wallet] = { masked: mask(zcashAddress.trim()), at }; save()
    return { ok: true, registeredAt: at }
  },
  async optout({ wallet, nonce, signature }) {
    await wait()
    if (!verify(optoutMessage(wallet, nonce), signature, wallet)) throw new ApiError(400, 'invalid_signature')
    takeNonce(wallet, nonce)
    delete state.optins[wallet]; save()
    return { ok: true }
  },
  // v2.9 (signed reads): there is no unsigned read, as on the engine. A signature over the status text opens the wallet's own settings and shielded batches, the nonce works once.
  async optinStatus({ wallet, nonce, signature }): Promise<OptinStatus> {
    await wait(120)
    if (v25()) gone()
    if (!verify(shieldedViewMessage(wallet, nonce), signature, wallet)) throw new ApiError(400, 'invalid_signature')
    takeNonce(wallet, nonce)
    const o = state.optins[wallet]
    const batches = o && !empty() ? epochs().filter((e) => e.shielded.count > 0 && e.status === 'ok').slice(0, 2) : []
    const commitments = batches.map((e) => ({ epochId: e.id, at: e.at, snapshotSha256: hex(`snap:${e.id}`), commitments: [hex(`commit:${wallet}:${e.id}`)] }))
    // an opted-in wallet's share in the round whose batch fell back (the mock has one): paid as Solana ZEC, and in this answer only, never in the public rewards
    const fell = o && !empty() ? epochs().filter((e) => e.status === 'fallback_solana').slice(0, 1) : []
    const fallback = fell.map((e) => ({ epochId: e.id, at: e.at, sig: sig(`fallback:${e.id}:${wallet}`), zats: '154000', coins: [{ mint: seedCoins[0].mint, shareZats: '154000' }] }))
    return {
      optedIn: !!o, zcashAddressMasked: o ? o.masked : null, pendingZats: o ? '1834200' : '0',
      shielded: { rounds: commitments.length, commitments, fallback: { count: fallback.length, totalZats: String(fallback.length * 154_000), payouts: fallback } },
    }
  },
  // v2.9: a wallet's profile data from the made-up pad: the coins it launched (or is the Creator wallet of), the trades the tape holds for it, and the earlier of the two first times.
  async wallet(address): Promise<WalletProfile> {
    await wait(120)
    if (v25()) gone()
    const launched = allCoins()
      .filter((c) => c.creator === address || c.creatorWallet === address)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(walletCoinOf)
    const mine = tape(10_000).filter((t) => t.wallet === address)
    const times = [...launched.map((c) => c.createdAt), ...mine.map((t) => t.at)].map((t) => Date.parse(t))
    return {
      wallet: address, launched,
      trades: mine.slice(0, 50).map(({ sig, mint, symbol, side, amountToken, amountZec, at }) => ({ sig, mint, symbol, side, amountToken, amountZec, at })),
      firstSeenAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    }
  },
  async treasury() {
    await wait()
    const last = Math.floor(Date.now() / EPOCH_MS) * EPOCH_MS
    return {
      treasuryZats: empty() ? '0' : ZEC(1.2044), owedZats: empty() ? '0' : ZEC(0.9418), covered: true,
      lastEpochAt: empty() ? null : new Date(last).toISOString(), nextEpochAt: empty() ? null : new Date(last + EPOCH_MS).toISOString(),
      zcashNetwork: 'regtest',
      // Mock only: open the app with ?paused=1 to see what a paused keeper looks like.
      paused: /[?&]paused=1/.test(location.href), epochsNeedingAttention: 0,
      // Mock only, with ?devnet=1: ?faucet=dry is a faucet whose key is out of test money; ?faucet=race says it has some and then answers 503 (the last fill went just before the click).
      faucet: /[?&]devnet=1/.test(location.href) ? { available: !/[?&]faucet=dry/.test(location.href), fillsLeft: /[?&]faucet=dry/.test(location.href) ? 0 : 42 } : null,
      policy: { holdersShareOfClaimedBps: 7500, teamShareOfClaimedBps: 2500, meteoraShareOfFeeBps: 2000 },
      team: { wallet: null, grossZats: ZEC(0.5412), deliveryCostZats: ZEC(0.0066), nativeZats: ZEC(0.0021), heldInKeeperZats: ZEC(0.5345), sweptZats: '0' },
    }
  },
  async epochs() { await wait(); return { epochs: empty() ? [] : epochs() } },
  async faucet() {
    await wait()
    if (/[?&]faucet=(dry|race)/.test(location.href)) throw new ApiError(503, 'faucet_unavailable')
    return { ok: true as const, sol: 0.02, zecZats: '500000000' }
  },
}
const pendingLaunch = new Map<string, Coin>()

/** The numbers both trade-tx and the wallet-less quote answer: the pool fee off the top, then the curve's price, then slippage. */
function quoteFor(c: Coin, side: 'buy' | 'sell', amt: number, slippageBps: number): Quote {
  const price = Number(c.priceZec) // zats per whole token
  // inside the launch window the trade pays the step's fee, after it the coin's tier; a v2.7 engine has no window
  const win = v27() ? { feeNowBps: null, windowSecondsLeft: 0 } : liveWindow(c)
  const feeRate = (win.feeNowBps ?? c.feeBps) / 10_000 // the whole pool fee; holders get holderShareBps of it, Meteora keeps 20%
  const depth = Math.max(Number(c.marketCapZec), 1)
  const bps = Math.max(0, Math.min(5000, slippageBps))
  const slip = bps / 10_000
  const base = { side, route: c.stage === 'graduated' ? 'damm' as const : 'curve' as const, slippageBps: bps, at: new Date().toISOString(), ...(v27() ? {} : { feeBps: win.feeNowBps, windowSecondsLeft: win.windowSecondsLeft }) }
  if (side === 'buy') {
    const fee = Math.round(amt * feeRate)
    const impact = (amt - fee) / (depth + amt - fee) // the curve's price rises as the buy fills, so fewer tokens come out than at the spot price
    const out = Math.floor((((amt - fee) / price) * 1e6) / (1 + impact))
    return { ...base, in: String(amt), out: String(out), minOut: String(Math.floor(out * (1 - slip))), feeZec: String(fee), priceImpactBps: Math.floor(impact * 10_000) }
  }
  const spot = Math.round((amt / 1e6) * price)
  const impact = spot / (depth + spot) // a sell pushes the price down as it fills
  const gross = Math.round(spot * (1 - impact))
  const fee = Math.round(gross * feeRate)
  const out = gross - fee
  return { ...base, in: String(amt), out: String(out), minOut: String(Math.floor(out * (1 - slip))), feeZec: String(fee), priceImpactBps: Math.floor(impact * 10_000) }
}
