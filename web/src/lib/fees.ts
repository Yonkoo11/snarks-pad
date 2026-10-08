// The fee split in one shape, whatever it came from: a coin's own tier fields (GET /coins), a tier of the launch menu
// (GET /tiers) or the published policy (GET /treasury). Every share is in bps of the whole trading fee and the four add
// up to 10000. Nothing is typed in: FeeSplit.svelte draws exactly these numbers.
import type { Coin, FeePolicy, Tier } from './types'

export interface FeeShares {
  feeBps: number
  holdersBps: number
  teamBps: number
  creatorBps: number
  meteoraBps: number
}

export function sharesOfCoin(c: Pick<Coin, 'feeBps' | 'claimedShareBps' | 'holderShareBps' | 'teamShareBps' | 'creatorShareBps'>): FeeShares {
  return {
    feeBps: c.feeBps, holdersBps: c.holderShareBps, teamBps: c.teamShareBps, creatorBps: c.creatorShareBps,
    meteoraBps: 10_000 - c.claimedShareBps - c.creatorShareBps,
  }
}

export function sharesOfTier(t: Pick<Tier, 'feeBps' | 'holderShareBps' | 'teamShareBps' | 'creatorShareBps' | 'meteoraShareBps'>): FeeShares {
  return { feeBps: t.feeBps, holdersBps: t.holderShareBps, teamBps: t.teamShareBps, creatorBps: t.creatorShareBps, meteoraBps: t.meteoraShareBps }
}

/** The published policy applied to a tier: Meteora's share comes off the top, the creator's next, and the pad splits what it claims. */
export function sharesFromPolicy(p: FeePolicy, feeBps = 100, creatorBps = 0): FeeShares {
  const claimed = 10_000 - p.meteoraShareOfFeeBps - creatorBps
  const holders = Math.floor((claimed * p.holdersShareOfClaimedBps) / 10_000)
  return { feeBps, holdersBps: holders, teamBps: claimed - holders, creatorBps, meteoraBps: p.meteoraShareOfFeeBps }
}
