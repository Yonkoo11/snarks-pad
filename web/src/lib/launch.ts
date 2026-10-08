// What the Launch page works out from the pad's own numbers (GET /tiers): the most a first buy can be, the one line under the tier picker, and the
// plain words for the fixed facts of a tier that its preview card prints, one fact to a row. Nothing is typed in here as a fact: a number comes from
// the tier, and a fact the engine did not send is null, which the page shows as a dash. No network and no browser in this file, so a test runs it as it is.
import { ZATS, feeLabel, zecRounded } from './format'
import type { Tier } from './types'
import { windowParts, windowValue, type WindowParts } from './window'

/**
 * The most a first buy can be, in zats: what the wallet holds of Solana ZEC, and never more than the curve can take. The trading fee is paid out
 * of the amount a buyer spends (nothing is added on top of it), and the program refuses an exact-in buy above the room left under the graduation
 * threshold, which the engine's own helper clamps to 95% of it (engine/src/dbc/room.ts). null = the wallet's balance is not known.
 */
export function maxFirstBuy(balance: bigint | null, thresholdZats: string | undefined): bigint | null {
  if (balance === null) return null
  if (!thresholdZats || !/^\d+$/.test(thresholdZats)) return balance
  const room = (BigInt(thresholdZats) * 95n) / 100n
  return balance < room ? balance : room
}

/** An amount of zats as the text of the first-buy field: whole ZEC and up to eight decimals, no thousands commas, no trailing zeros. */
export function zatsText(zats: bigint): string {
  const frac = (zats % ZATS).toString().padStart(8, '0').replace(/0+$/, '')
  const whole = String(zats / ZATS)
  return frac ? `${whole}.${frac}` : whole
}

/** A share of the fee as the fee strip prints it: bps to percent, one decimal at most (6640 bps is 66.4%). */
export const shareText = (bps: number): string => `${Math.round(bps / 10) / 10}%`

/**
 * What the curve must hold before the coin graduates, in words, or null when the engine does not say (an older one). Rounded half up to two decimals from the zats the
 * engine sends, the way the coin page's Graduation fact prints it (lib/format zecRounded): 666666666 zats is 6.67 ZEC on both pages.
 */
export function graduationText(t: Pick<Tier, 'migrationThresholdZats'>): string | null {
  const z = t.migrationThresholdZats
  if (!z || !/^[1-9]\d*$/.test(z)) return null
  return `${zecRounded(z, 2)} ZEC`
}

/**
 * The line beside the 10% tier's tick box, in the shape of the line under the picker (the fee, on every trade, fixed at launch) and nothing about what a buy and an immediate
 * sell costs: that is on the coin page and How it works. Where the pool the coin graduates into charges less, that fact follows, in three words ("6% after graduation").
 */
export function confirmLineOfTier(t: Pick<Tier, 'feeBps' | 'postGraduationFeeBps'>): string {
  const after = t.postGraduationFeeBps < t.feeBps ? `, ${feeLabel({ feeBps: t.postGraduationFeeBps, stage: 'curve' })} after graduation` : ''
  return `I understand: ${feeLabel({ feeBps: t.feeBps, stage: 'curve' })} on every trade, fixed at launch${after}.`
}

/**
 * The liquidity fact in true words. "Locked for good" only when no share of the graduated pool's liquidity is left unlocked (the locks are
 * permanent: the pool's program never lets that liquidity out); any unlocked share is said as it is. null when the engine does not say.
 */
export function liquidityText(l: Tier['liquidity']): string | null {
  if (!l) return null
  const locked = l.partnerLockedPct + l.creatorLockedPct
  if (l.unlockedPct <= 0 && locked >= 100) return 'Locked for good'
  if (locked <= 0) return 'Not locked'
  return `${locked}% locked for good`
}

export interface TierFacts {
  fee: string // the curve fee, flat
  holdersShare: string // the holders' part of the fee
  creatorShare: string | null // the creator's part of the fee, null on the tier that has none
}

/** The fee numbers of a tier, printed the way the fee strip and the tier picker print them (lib/format, lib/fees). */
export function factsOfTier(t: Tier): TierFacts {
  return {
    fee: feeLabel({ feeBps: t.feeBps, stage: 'curve' }),
    holdersShare: shareText(t.holderShareBps),
    creatorShare: t.creatorShareBps > 0 ? shareText(t.creatorShareBps) : null,
  }
}

/** The fee split of a tier in bps of the whole fee: what the one line under the picker needs (a tier of GET /tiers has all of it). */
export type FeeSplitOfTier = Pick<Tier, 'feeBps' | 'creatorShareBps' | 'holderShareBps' | 'teamShareBps' | 'meteoraShareBps'>

export interface FeeLine {
  /** The fee, so the page can set it in mono: "1%". */
  fee: string
  /** The rest of the line, from the space after the fee. */
  rest: string
}

/**
 * The one line under the tier picker: the fee, that it is paid
 * in ZEC and fixed at launch, and nothing else. Who gets what is on the preview card ("To you", "To holders"); what a buy and an immediate sell costs,
 * the launch window, the graduated pool and Meteora's hand in it, the delivery cost and wallet-to-wallet sends are on the coin page's "What is fixed"
 * tab and on How it works.
 */
export function feeLineOfTier(t: FeeSplitOfTier): FeeLine {
  return { fee: feeLabel({ feeBps: t.feeBps, stage: 'curve' }), rest: ' on every trade, paid in ZEC, fixed at launch.' }
}

export interface WindowRow {
  /** The value in parts, so each number can be set in mono: "99%", "1%", 5. */
  parts: WindowParts
  /** The same value as one sentence: "99% at launch, 1% from second 5". */
  value: string
}

/**
 * The Launch preview's "Launch window" row for the picked tier, or null when the engine does not send the tier's window (an older engine): the card then shows a dash.
 * The numbers are the tier's (GET /tiers, contract v2.8). What a bot pays in the window, and what the launcher's own first buy pays, are on How it works and the coin page.
 */
export function windowRowOfTier(t: Tier): WindowRow | null {
  const w = t.launchWindow
  if (!w) return null
  return { parts: windowParts(w), value: windowValue(w) }
}
