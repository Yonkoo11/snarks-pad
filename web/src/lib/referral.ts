// Referral links: #/coin/<mint>?ref=<wallet>. Meteora pays the referrer 4% of the pool fee out of its own 20% share
// (host fee, DBC state/config.rs); the trader, the holders and the pad pay nothing extra. The referrer is remembered
// in this browser so it survives a page change; storage can be blocked, so every access is guarded.
import bs58 from 'bs58'

const KEY = 'snarks-ref'

export function isWallet(s: string | null | undefined): s is string {
  if (!s) return false
  try { return bs58.decode(s).length === 32 } catch { return false }
}

/** The ref= value in the page address (before or after the #), if it is a wallet. */
export function refFromLocation(href: string): string | null {
  const m = /[?&]ref=([1-9A-HJ-NP-Za-km-z]{32,44})(?:[&#]|$)/.exec(href)
  return m && isWallet(m[1]) ? m[1] : null
}

export function captureReferrer(): void {
  const r = refFromLocation(location.href)
  if (!r) return
  try { localStorage.setItem(KEY, r) } catch { /* storage blocked: the link still works for this page view */ }
  memory = r
}

let memory: string | null = null

export function referrer(): string | null {
  try { const s = localStorage.getItem(KEY); if (isWallet(s)) return s } catch { /* fall through */ }
  return memory
}

export function referralLink(mint: string, wallet: string): string {
  return `${location.origin}${location.pathname}#/coin/${mint}?ref=${wallet}`
}
