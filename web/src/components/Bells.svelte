<script lang="ts">
  // The alerts the data can actually fire, computed in this tab from what is already on screen:
  // a curve close to graduating, a round paying soon for a coin this wallet holds, and a dev
  // sell seen on the live tape since this tab opened. They run only while the tab is open and
  // the line under them says so; nothing here pretends to be a server-side alert service.
  import type { Coin, FeedTrade, PadPot } from '../lib/types'
  import { tradeFeed } from '../lib/tape'
  import { countdown, ago } from '../lib/format'

  const { coins, bag, padPot, now }: {
    coins: Coin[] | null
    bag: Map<string, bigint> | null
    padPot: PadPot | null
    now: number
  } = $props()

  const NEAR_GRAD = 0.85
  const SOON_MS = 2 * 3600_000

  // dev sells seen on the open tape, newest first; only trades that happened after this mount
  let devSells = $state<FeedTrade[]>([])
  const openedAt = Date.now()
  $effect(() =>
    tradeFeed({
      limit: 12,
      everyMs: 10_000,
      onRows: (rows) => {
        const fresh = rows.filter((t) => t.side === 'sell' && t.tags.includes('dev') && Date.parse(t.at) >= openedAt)
        if (fresh.length) devSells = fresh.slice(0, 3)
      },
      onState: () => {},
    }),
  )

  const nearGrad = $derived((coins ?? []).filter((c) => c.stage === 'curve' && (c.curveProgress ?? 0) >= NEAR_GRAD).slice(0, 3))
  const paySoon = $derived.by(() => {
    if (!padPot?.nextPayoutAt || !bag || bag.size === 0) return null
    const ms = Date.parse(padPot.nextPayoutAt) - now
    return ms > 0 && ms < SOON_MS ? padPot.nextPayoutAt : null
  })
  const any = $derived(nearGrad.length > 0 || paySoon !== null || devSells.length > 0)
</script>

{#if any}
  <div class="bells" role="status" aria-label="Things worth a look right now">
    {#each nearGrad as c (c.mint)}
      <a class="bell" href="#/coin/{c.mint}"><span class="b-k caps">curve {Math.round((c.curveProgress ?? 0) * 100)}%</span> ${c.symbol} is close to graduating</a>
    {/each}
    {#if paySoon}
      <span class="bell"><span class="b-k caps">payday</span> a round pays your coins in {countdown(paySoon, now)}</span>
    {/if}
    {#each devSells as t (t.sig)}
      <a class="bell warn" href="#/coin/{t.mint}"><span class="b-k caps">dev sold</span> ${t.symbol}, {ago(t.at, now)}</a>
    {/each}
    <span class="b-note muted">fires only while this tab is open</span>
  </div>
{/if}

<style>
  .bells { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-3); align-items: center; font-size: var(--t-12); }
  .bell { display: inline-flex; align-items: center; gap: var(--s-2); padding: 3px 10px; border: 1px dashed var(--ink-3); border-radius: var(--r-full);
    color: inherit; text-decoration: none; font-variant-numeric: tabular-nums; }
  a.bell { transition: background-color var(--d-fn) var(--ease); }
  @media (hover: hover) { a.bell:hover { background: var(--hover); } }
  .bell.warn { border-color: var(--bad); color: var(--bad); }
  .b-k { font-size: 10px; font-weight: 700; color: var(--pink); }
  .bell.warn .b-k { color: var(--bad); }
  .b-note { font-size: var(--t-11); }
</style>
