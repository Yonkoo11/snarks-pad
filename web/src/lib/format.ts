export const ZATS = 100_000_000n

/**
 * After a coin graduates to Meteora's DAMM v2 pool the fee is no longer flat: its fixed base fee, rising by up to a fifth
 * in volatile trading (read on mainnet: audit/CONFIG-REVIEW.md S1-M1, CONFIG-REVIEW-TIERS.md). This is that ceiling for the 1%
 * pool, in basis points; `postGraduationMaxBps` scales it to the pool a tier graduates into. On the bonding curve the fee stays flat.
 */
export const POST_GRADUATION_FEE_MAX_BPS = 120

/** The highest the graduated pool's fee can rise to, given its base fee: base x 1.2 (1% -> 1.2%, 2% -> 2.4%, 4% -> 4.8%, 6% -> 7.2%). */
export function postGraduationMaxBps(postGraduationBps: number): number {
  return Math.round((postGraduationBps * POST_GRADUATION_FEE_MAX_BPS) / 100)
}

const bpsPct = (bps: number): string => String(bps / 100)

/** The fee as the copy says it: flat on the curve, a range after graduation. `short` fits a table cell. */
export function feeLabel(c: { feeBps: number; stage: 'curve' | 'graduated'; postGraduationFeeBps?: number }, short = false): string {
  if (c.stage === 'curve') return `${bpsPct(c.feeBps)}%`
  const base = c.postGraduationFeeBps ?? c.feeBps
  const max = postGraduationMaxBps(base)
  return short ? `${bpsPct(base)}-${bpsPct(max)}%` : `${bpsPct(base)}%, rising to about ${bpsPct(max)}% when trading is volatile`
}

/**
 * The fee as a coin's card or header chip says it: "1% fee on curve" while the coin is on its curve (a flat fee that applies only there),
 * "1-1.2% fee" once it trades in the graduated pool (a range, so it cannot be read as flat for life). Never a bare percentage.
 */
export function feeChip(c: { feeBps: number; stage: 'curve' | 'graduated'; postGraduationFeeBps?: number }): string {
  return `${feeLabel(c, true)} fee${c.stage === 'curve' ? ' on curve' : ''}`
}

/**
 * Dollars (or any unit) out of every 100 traded, for a share of the whole fee: fee% of 100, times the share. Integer thousandths so
 * no float rounding is shown: 6% x 6640 bps = 3.984. Two decimals unless a third is needed (the 6% tier leaves holders 0.612).
 */
export function per100(feeBps: number, shareBps: number): string {
  const mills = Math.round((feeBps * shareBps) / 1000)
  const s = (mills / 1000).toFixed(3)
  return '$' + (s.endsWith('0') ? s.slice(0, -1) : s)
}

/** What buying and selling straight back costs, per 100 put in: `roundTripCostBps` from the engine (1 - (1 - fee)^2), as dollars. */
export function roundTripPer100(roundTripCostBps: number): string {
  return '$' + (roundTripCostBps / 100).toFixed(2)
}

/**
 * What a buy and an immediate sell costs, in bps of the amount: the fee is paid on the buy and again on the sell, 1 - (1 - fee)^2. The engine's own
 * arithmetic (`roundTripCostBps` in engine/src/dbc/tiers.ts, which GET /tiers sends per tier); engine/test/copy.test.ts asserts the two agree for every tier.
 * The coin page and How it works say it in words, so they work it out from the fee they already know.
 */
export function roundTripCostBps(feeBps: number): number {
  const f = feeBps / 10_000
  return Math.round((1 - (1 - f) ** 2) * 10_000)
}

/**
 * The fees a creator can launch on, in bps, as How it works lists them. GET /tiers is the live menu; this is static prose like its neighbours, so
 * engine/test/copy.test.ts asserts it equals the engine's reviewed menu and the page cannot drift from it.
 */
export const TIER_FEES_BPS: readonly number[] = [100, 200, 400, 600, 1000]

/** What a buy and an immediate sell costs on each tier of the menu, as How it works prints it: `{ tier: "1%", cost: "$1.99" }`. */
export function roundTripByTier(): { tier: string; cost: string }[] {
  return TIER_FEES_BPS.map((bps) => ({ tier: feeLabel({ feeBps: bps, stage: 'curve' }), cost: roundTripPer100(roundTripCostBps(bps)) }))
}

/** zats string -> ZEC string with up to `dp` decimals, trailing zeros trimmed. */
export function zec(zats: string | bigint, dp = 4): string {
  const v = typeof zats === 'bigint' ? zats : BigInt(zats || '0')
  const neg = v < 0n
  const a = neg ? -v : v
  const whole = a / ZATS
  let frac = (a % ZATS).toString().padStart(8, '0').slice(0, dp).replace(/0+$/, '')
  const w = whole.toLocaleString('en-US')
  if (whole === 0n && frac === '' && a > 0n) return (neg ? '-' : '') + '<0.' + '0'.repeat(dp - 1) + '1'
  return (neg ? '-' : '') + w + (frac ? '.' + frac : '')
}

/**
 * zats string -> ZEC string rounded HALF UP to `dp` decimals (`zec` cuts the extra decimals off), trailing zeros trimmed. For a number that every page must print the
 * same way from the same source: the curve's graduation threshold is 666666666 zats, 6.67 ZEC on the Launch page and on a coin's What is fixed tab.
 */
export function zecRounded(zats: string | bigint, dp = 2): string {
  const v = typeof zats === 'bigint' ? zats : BigInt(zats || '0')
  const neg = v < 0n
  const unit = 10n ** BigInt(8 - dp) // zats in the last decimal printed
  const rounded = (((neg ? -v : v) + unit / 2n) / unit) * unit
  return zec(neg ? -rounded : rounded, dp)
}

/** Price in zats per whole token (decimal string, often < 1 zat) -> ZEC with 4 significant digits. */
export function zecPrice(zatsDecimal: string): string {
  const z = Number(zatsDecimal)
  if (!Number.isFinite(z) || z <= 0) return '0'
  const v = z / 1e8
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  const digits = Math.min(20, Math.max(0, 3 - Math.floor(Math.log10(v))))
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
}

/** ZEC decimal string typed by a user -> zats bigint. Returns null if not a number. */
export function toZats(input: string): bigint | null {
  const s = input.trim()
  if (!/^\d*(\.\d{0,8})?$/.test(s) || s === '' || s === '.') return null
  const [w, f = ''] = s.split('.')
  return BigInt(w || '0') * ZATS + BigInt(f.padEnd(8, '0') || '0')
}

/** Token amounts use 6 decimals in base units. */
export const TOKEN_DP = 6n
export function tokens(base: string | bigint, dp = 0): string {
  const v = typeof base === 'bigint' ? base : BigInt(base || '0')
  const unit = 10n ** TOKEN_DP
  const whole = (v / unit).toLocaleString('en-US')
  if (dp === 0) return whole
  const frac = (v % unit).toString().padStart(6, '0').slice(0, dp).replace(/0+$/, '')
  return whole + (frac ? '.' + frac : '')
}

export function short(s: string, head = 4, tail = 4): string {
  if (!s) return ''
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Full phrase for the next payout, e.g. "Next payout in 1h 02m 03s". */
export function nextPayout(iso: string | null, now = Date.now()): string {
  if (!iso) return 'No payout scheduled yet'
  if (Date.parse(iso) - now <= 0) return 'Payout running now'
  return `Next payout in ${countdown(iso, now)}`
}

export function countdown(iso: string, now = Date.now()): string {
  let s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000))
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
}

/** Price per 1,000,000 tokens in ZEC, from zats per whole token (decimal string): 12 zats a token = 0.12 ZEC per 1M. */
export function pricePerMillion(zatsPerToken: string): string {
  const z = Number(zatsPerToken)
  if (!Number.isFinite(z) || z <= 0) return '0'
  return zecPrice(String(z * 1e6)) // z * 1e6 zats is z/100 ZEC
}

/** Dollars as a short estimate: "$0.42", "$159", "$31.6k", "$1.2M". Never more precision than the feed has. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1) return '$' + n.toFixed(n < 0.01 ? 4 : 3).replace(/0+$/, '').replace(/\.$/, '')
  if (n < 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 })
  if (n < 1e6) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
}

/** "≈ $159" for an amount in zats, or null while no rate is known. */
export function usdOfZats(zats: string | bigint | number, rate: number | null): string | null {
  if (rate === null) return null
  const z = typeof zats === 'bigint' ? Number(zats) : Number(zats)
  if (!Number.isFinite(z)) return null
  const s = usd((z / 1e8) * rate)
  return s ? '≈ ' + s : null
}
