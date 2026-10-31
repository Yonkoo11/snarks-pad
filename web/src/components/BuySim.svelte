<script lang="ts">
  // "What would this buy me": pick an amount of ZEC and the pad's own quote says how many tokens it gets, what the trade moves the
  // price, and what the fee is; from the holder numbers it says what share of the paying supply those tokens would be and what that
  // share of the next round's pot would come to IF everything stayed as it is now. It is arithmetic on today's numbers, not a forecast,
  // and it says so. Nothing is sent: a quote is a read.
  import { api, ApiError } from '../lib/api'
  import type { Coin, Pot } from '../lib/types'
  import { zec, tokens as fmtTokens, countdown } from '../lib/format'
  import { zecUsd } from '../lib/usd.svelte'
  import { poll } from '../lib/poll'

  const { coin, now }: { coin: Coin; now: number } = $props()
  const PRESETS = ['0.1', '0.5', '1', '5']
  const mint = $derived(coin.mint) // a primitive: effects reading it are not re-run when the page hands over a fresh coin object
  let amount = $state('0.5')
  let q = $state<Awaited<ReturnType<typeof api.quote>> | null>(null)
  let qErr = $state<string | null>(null)
  let pot = $state<Pot | null | undefined>(undefined)
  let hold = $state<{ supply: bigint; poolPct: number } | null | undefined>(undefined)

  $effect(() => { void mint; return poll(() => api.pot(mint).then((p) => (pot = p), () => (pot = null)), 20_000) })
  $effect(() => {
    api.holders(mint, { limit: 1 }).then((h) => { try { hold = { supply: BigInt(h.supply || '0'), poolPct: h.poolPct ?? 0 } } catch { hold = null } }, () => (hold = null))
  })

  const zats = $derived.by(() => {
    const n = Number(amount)
    return Number.isFinite(n) && n > 0 && n <= 1000 ? BigInt(Math.round(n * 1e8)) : null
  })
  // a quote is asked 300 ms after the amount stops changing
  $effect(() => {
    const z = zats, m = mint
    q = null; qErr = null
    if (z === null) return
    const t = setTimeout(() => {
      api.quote(m, { side: 'buy', amount: z.toString(), slippageBps: 100 }).then((r) => { if (zats === z) q = r }, (e) => { qErr = e instanceof ApiError ? 'The pad would not quote this amount.' : 'The quote did not load.' })
    }, 300)
    return () => clearTimeout(t)
  })

  const out = $derived(q ? BigInt(q.out) : null)
  const eligible = $derived(hold ? (hold.supply * BigInt(Math.round((100 - hold.poolPct) * 100))) / 10_000n : null)
  // tokens leave the pool for the buyer, so the paying supply grows by what is bought
  const share = $derived(out !== null && eligible !== null && eligible + out > 0n ? Number((out * 1_000_000n) / (eligible + out)) / 1_000_000 : null)
  const cut = $derived(share !== null && pot ? (BigInt(pot.holdersZats) * BigInt(Math.round(share * 1_000_000))) / 1_000_000n : null)
  const paid = $derived(BigInt(coin.rewards.paidSolanaZec || '0') + BigInt(coin.rewards.paidShieldedZec || '0'))
</script>

<section class="bs" aria-label="What a buy would get you">
  <h3 class="h3">What would a buy get you</h3>
  <div class="amt">
    <label class="lab" for="bs-a">Amount in ZEC</label>
    <input id="bs-a" class="input mono" inputmode="decimal" bind:value={amount} aria-invalid={zats === null} />
    <div class="pre">{#each PRESETS as p (p)}<button type="button" class:on={amount === p} onclick={() => (amount = p)}>{p}</button>{/each}</div>
    {#if zecUsd.rate && zats !== null}<span class="muted usd mono">≈ ${(Number(amount) * zecUsd.rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>{/if}
  </div>

  {#if zats === null}<p class="muted">Enter an amount between 0 and 1,000 ZEC.</p>
  {:else if qErr}<p class="error" role="alert"><span>{qErr}</span></p>
  {:else if !q}<div class="skel" style="height: 96px" aria-busy="true" role="status" aria-label="Asking the pad for a quote"></div>
  {:else}
    <dl>
      <div><dt class="label">You would get</dt><dd class="mono">{out !== null ? fmtTokens(out) : '–'} {coin.symbol}</dd></div>
      <div><dt class="label">Price impact</dt><dd class="mono">{q.priceImpactBps === 0 ? 'none worth naming' : `${(q.priceImpactBps / 100).toFixed(2)}%`}</dd></div>
      <div><dt class="label">Pool fee</dt><dd class="mono">{zec(q.feeZec, 5)} ZEC{q.feeBps ? ` (${(q.feeBps / 100).toFixed(2)}%)` : ''}</dd></div>
      <div><dt class="label">Share of the paying supply</dt><dd class="mono">{share === null ? '–' : share >= 0.01 ? `${(share * 100).toFixed(2)}%` : `${(share * 100).toFixed(4)}%`}</dd></div>
      <div class="wide"><dt class="label">Of the next round's pot, as things stand</dt><dd class="mono">{cut === null ? '–' : `${zec(cut, 6)} ZEC`}{#if pot?.nextPayoutAt}<span class="muted">&nbsp;in {countdown(pot.nextPayoutAt, now)}</span>{/if}</dd></div>
    </dl>
    <p class="muted fine">This is today's arithmetic, not a forecast. The pot, the holders and every wallet's balance change before the round closes, and your payout follows the least you held at the round's random checks, so a buy just before a round earns nothing from it. {#if paid > 0n}This coin has paid its holders {zec(paid, 2)} ZEC over {coin.rewards.epochs} {coin.rewards.epochs === 1 ? 'round' : 'rounds'}.{/if} The quote is a read: nothing is sent.</p>
  {/if}
</section>

<style>
  .bs { display: grid; gap: var(--s-3); padding: var(--s-4); background: var(--paper-2); border-radius: var(--r-md); box-shadow: var(--sh-1); }
  .amt { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
  .amt .input { width: 8.5ch; min-height: 44px; padding: 0 var(--s-3); }
  .lab { font-size: var(--t-12); font-weight: 700; color: var(--ink-2); }
  .pre { display: flex; gap: var(--s-2); }
  .pre button { min-height: 36px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-md); background: var(--paper-3); color: var(--ink-2); font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer; }
  .pre button.on { background: var(--ink); color: var(--paper); }
  .usd { font-size: var(--t-12); }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--s-3); margin: 0; }
  dl .wide { grid-column: 1 / -1; }
  dd { margin: 2px 0 0; font-size: var(--t-14); font-weight: 700; font-variant-numeric: tabular-nums; }
  .fine { font-size: var(--t-12); margin: 0; max-width: 90ch; }
</style>
