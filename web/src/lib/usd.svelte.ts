// ZEC in US dollars, for the "≈ $" estimates. Two public feeds that agree (checked 2026-10-04: CoinGecko /simple/price and the
// NEAR 1Click /tokens list the pad swaps through both said 1326.68). 1Click is asked first: it answers a browser on any origin,
// while CoinGecko's free endpoint answered without CORS headers (a red console line on every page, 2026-10-04). Read in the
// browser, kept for a minute; if both fail the estimate is simply not shown (the ZEC numbers never depend on it).
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd'
const ONECLICK = 'https://1click.chaindefuser.com/v0/tokens'
const MAX_AGE_MS = 60_000

async function fromCoingecko(): Promise<number | null> {
  const r = await fetch(COINGECKO)
  const j = (await r.json()) as { zcash?: { usd?: number } }
  return j.zcash?.usd ?? null
}
async function fromOneClick(): Promise<number | null> {
  const r = await fetch(ONECLICK)
  const list = (await r.json()) as { symbol?: string; blockchain?: string; price?: number }[]
  return list.find((t) => t.symbol === 'ZEC' && t.blockchain === 'zec')?.price ?? null
}

class ZecUsd {
  rate = $state<number | null>(null)
  private at = 0
  private inflight: Promise<void> | null = null
  refresh(): Promise<void> {
    if (Date.now() - this.at < MAX_AGE_MS) return Promise.resolve()
    this.inflight ??= (async () => {
      for (const read of [fromOneClick, fromCoingecko]) {
        try {
          const v = await read()
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) { this.rate = v; this.at = Date.now(); return }
        } catch { /* try the next feed */ }
      }
    })().finally(() => { this.inflight = null })
    return this.inflight
  }
}
export const zecUsd = new ZecUsd()
