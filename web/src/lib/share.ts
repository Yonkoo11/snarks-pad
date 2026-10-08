// Sharing a coin (GAP-AUDIT G18): a "Post on X" link and the coin's address on this site. A connected wallet's link carries its referral (lib/referral.ts),
// so the person sharing gets the pad's referral share of trades that come through it. The words say what is true of every coin and promise nothing.
import { referralLink } from './referral'

export function coinLink(mint: string, wallet: string | null): string {
  return wallet ? referralLink(mint, wallet) : `${location.origin}${location.pathname}#/coin/${mint}`
}

export function shareText(symbol: string): string {
  return `$${symbol} is live on @SnarksPad. Part of every trade's fee is paid to its holders in ZEC.`
}

export function xIntentUrl(symbol: string, link: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(shareText(symbol))}&url=${encodeURIComponent(link)}`
}
