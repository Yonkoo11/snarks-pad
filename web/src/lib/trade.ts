// The buy box's numbers, kept out of the component so each one can be read on its own: presets, slippage and the price
// impact a quote implies. Amounts are zats (ZEC, 8 decimals) or token base units (6 decimals), as the contract has them.
import type { TradeQuote } from './types'

/** Quick amounts in ZEC, in the range other launchpads offer. Custom stays in the box. */
export const BUY_PRESETS_ZEC = ['0.1', '0.5', '1', '5'] as const
/** Quick sell sizes as a share of what the wallet holds. */
export const SELL_PRESETS_PCT = [25, 50, 100] as const
/** Slippage chips in bps; 1% is the default the engine also assumes (trade-tx slippageBps default 100). */
export const SLIPPAGE_PRESETS_BPS = [100, 300, 1000] as const
export const SLIPPAGE_DEFAULT_BPS = 100
/** Above this the box warns: a wide slippage lets a trade fill at a much worse price than quoted. */
export const SLIPPAGE_WARN_BPS = 500
/** The contract's ceiling (trade-tx: slippageBps integer 0-5000). */
export const SLIPPAGE_MAX_BPS = 5000

/** Solana ZEC on mainnet (NEAR Omni Bridge mint, verified 2026-09-27). Devnet uses a stand-in the engine names per coin. */
export const ZEC_MINT_MAINNET = 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS'
/** Where to get Solana ZEC on mainnet: Jupiter's swap page, SOL into the ZEC mint. */
export const GET_ZEC_URL = `https://jup.ag/swap/SOL-${ZEC_MINT_MAINNET}`

/** "1.5" typed as a percent -> 150 bps; null when it is not a number or outside 0 to 50%. */
export function parseSlippagePct(s: string): number | null {
  const t = s.trim()
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null
  const bps = Math.round(Number(t) * 100)
  return bps >= 0 && bps <= SLIPPAGE_MAX_BPS ? bps : null
}

export const slippagePct = (bps: number): string => `${(bps / 100).toString()}%`

/**
 * What the quote's price is against the pool's spot price, in bps. A buy pays (in minus the fee) for `out` tokens; a sell
 * gives `in` tokens for (out plus the fee). The gap to the spot price is the impact; the fee is not part of it.
 * null when a value is missing or zero (nothing to compare).
 */
export function priceImpactBps(side: 'buy' | 'sell', q: TradeQuote, spotZatsPerToken: string): number | null {
  const spot = Number(spotZatsPerToken)
  const inn = Number(q.in), out = Number(q.out), fee = Number(q.feeZec)
  if (![spot, inn, out, fee].every(Number.isFinite) || spot <= 0 || inn <= 0 || out <= 0) return null
  const exec = side === 'buy' ? (inn - fee) / (out / 1e6) : (out + fee) / (inn / 1e6)
  const gap = side === 'buy' ? exec / spot - 1 : 1 - exec / spot
  return Math.max(0, Math.round(gap * 10_000))
}

/** "0.4%", "<0.01%", "12%": the impact as a person reads it. */
export function impactLabel(bps: number): string {
  if (bps < 1) return '<0.01%'
  const pct = bps / 100
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(pct >= 1 ? 1 : 2).replace(/\.?0+$/, '')}%`
}

/** A share of what the wallet holds, in base units, floored. */
export function shareOfHolding(holding: bigint, pct: number): bigint {
  return (holding * BigInt(Math.round(pct))) / 100n
}

/** Token base units -> the decimal string the box shows (up to 6 decimals, trailing zeros trimmed). */
export function tokenAmountText(base: bigint): string {
  const whole = base / 1_000_000n
  const frac = (base % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}
