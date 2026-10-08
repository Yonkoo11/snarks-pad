// What the profile page needs that is plain logic (so a test can read it): which tabs a visitor and the owner see, what a wallet address has to look like,
// and what a wallet's token accounts make of the pad's coins. The page itself is routes/Profile.svelte.
import bs58 from 'bs58'
import type { Coin } from './types'
import { TOKEN_DP } from './format'

export const PROFILE_TABS = ['holdings', 'launched', 'trades', 'rewards', 'shielded'] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

/** The two tabs only the wallet's owner sees: what the pad paid it, and its shielded delivery. */
const OWNER_ONLY: readonly ProfileTab[] = ['rewards', 'shielded']

export const TAB_LABELS: Record<ProfileTab, string> = {
  holdings: 'Holdings',
  launched: 'Launched',
  trades: 'Trades',
  rewards: 'Rewards',
  shielded: 'Shielded delivery',
}

export const isProfileTab = (s: string | null | undefined): s is ProfileTab => !!s && (PROFILE_TABS as readonly string[]).includes(s)

/** The tabs of a profile: Holdings, Launched and Trades for everyone; Rewards and Shielded delivery only for the wallet's owner. */
export function visibleTabs(isOwner: boolean): ProfileTab[] {
  return PROFILE_TABS.filter((t) => isOwner || !OWNER_ONLY.includes(t))
}

/** The tab to show: the one asked for if this viewer may see it, else Holdings. A visitor who asks for an owner tab gets Holdings, never an error. */
export function tabFor(asked: ProfileTab | null, isOwner: boolean): ProfileTab {
  return asked && visibleTabs(isOwner).includes(asked) ? asked : 'holdings'
}

/** A Solana address in its canonical form: base58 of exactly 32 bytes (a mistyped or padded one does not round-trip). */
export function isWalletAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false
  try {
    const bytes = bs58.decode(s)
    return bytes.length === 32 && bs58.encode(bytes) === s
  } catch {
    return false
  }
}

/** The address of a profile in the page address: `#/u/<wallet>`, with `?tab=` when a tab other than the first is meant. */
export function profileHref(wallet: string, tab: ProfileTab | null = null): string {
  return `#/u/${wallet}${tab && tab !== 'holdings' ? `?tab=${tab}` : ''}`
}

// ---- holdings

/** A pad coin a wallet holds: the amount in base units (6 decimals) and its worth in zats at the pool's price, or null when the engine has no price for the coin. */
/** What a holding needs of a coin: a full Coin or an IndexCoin (GET /coins/index). */
export type HoldingCoin = Pick<Coin, 'mint' | 'name' | 'symbol' | 'imageUrl' | 'priceZec'>

export interface Holding {
  coin: HoldingCoin
  amount: bigint
  valueZats: bigint | null
}

const PRICE_DP = 12
const TOKEN_UNIT = 10n ** TOKEN_DP

/** zats per whole token ("0.37545974197", up to 12 decimals) as an integer of 1e-12 zats, or null when it is missing or not a plain decimal. */
function scaledPrice(priceZec: string | undefined): bigint | null {
  if (priceZec === undefined || !/^\d+(\.\d+)?$/.test(priceZec)) return null
  const [whole, frac = ''] = priceZec.split('.')
  return BigInt(whole) * 10n ** BigInt(PRICE_DP) + BigInt(frac.padEnd(PRICE_DP, '0').slice(0, PRICE_DP))
}

/** What `amount` base units of a coin are worth in zats at `priceZec` (zats per whole token), rounded down; null with no price. Exact: no floating point. */
export function holdingValueZats(amount: bigint, priceZec: string | undefined): bigint | null {
  const price = scaledPrice(priceZec)
  return price === null ? null : (amount * price) / (TOKEN_UNIT * 10n ** BigInt(PRICE_DP))
}

/**
 * The pad's coins among a wallet's token accounts: accounts of any other mint are left out, accounts of the same mint are added up, an empty one is not a holding.
 * Largest value first (a coin with no price last), then by ticker, so the list does not shuffle between reads.
 */
export function holdingsOf(accounts: readonly { mint: string; amount: string }[], coins: readonly HoldingCoin[]): Holding[] {
  const byMint = new Map(coins.map((c) => [c.mint, c]))
  const totals = new Map<string, bigint>()
  for (const a of accounts) {
    if (byMint.has(a.mint) && /^\d+$/.test(a.amount)) totals.set(a.mint, (totals.get(a.mint) ?? 0n) + BigInt(a.amount))
  }
  return [...totals]
    .flatMap(([mint, amount]): Holding[] => {
      const coin = byMint.get(mint)
      return coin && amount > 0n ? [{ coin, amount, valueZats: holdingValueZats(amount, coin.priceZec) }] : []
    })
    .sort((a, b) => compareValue(b.valueZats, a.valueZats) || a.coin.symbol.localeCompare(b.coin.symbol))
}

function compareValue(a: bigint | null, b: bigint | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}
