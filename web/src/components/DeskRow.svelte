<script lang="ts">
  // One coin as a ledger line: the dense view's row. Eleven cells on a desk, two lines on a
  // phone. The slow cells (supply split, next round per holder, the trade line) fill in from
  // lib/desk.ts for the rows on screen only; until then they hold the en dash. The fold-line on
  // the left appears when this browser has seen the coin before and something moved since.
  import type { Coin } from '../lib/types'
  import type { RowExtras } from '../lib/desk'
  import { rowExtras } from '../lib/desk'
  import { zec, pricePerMillion, ago } from '../lib/format'
  import { lastLook, lookDelta, recordLook, snapOf, isWatched, toggleWatch, watched, type Looked } from '../lib/looked'
  import CoinImage from './CoinImage.svelte'
  import Spark from './Spark.svelte'
  import ConcRule from './ConcRule.svelte'

  const { coin, now, bagZats = null, deltaBase = 'look', onstarchange }: {
    coin: Coin
    now: number
    bagZats?: bigint | null // the connected wallet's value of this coin, when it holds it
    deltaBase?: 'look' | 'star' // what the fold-line compares against
    onstarchange?: () => void // the Watching filter re-reads its set
  } = $props()

  let extras = $state<RowExtras | null>(null)
  $effect(() => {
    let live = true
    rowExtras(coin.mint).then((e) => { if (live) extras = e })
    return () => { live = false }
  })

  // the since-you-looked fold: compared once against the stored snapshot, then the look is recorded
  let delta = $state<string[]>([])
  // the initial read is the point: the star's truth lives in storage, not in the coin prop
  // svelte-ignore state_referenced_locally
  let starred = $state(isWatched(coin.mint))
  $effect(() => {
    const base: Looked | null = deltaBase === 'star' ? (watched()[coin.mint] ?? null) : lastLook(coin.mint)
    const snap = snapOf(coin)
    delta = lookDelta(base, snap)
    if (deltaBase === 'look') recordLook(coin.mint, snap)
  })
  function star() {
    starred = toggleWatch(coin.mint, snapOf(coin))
    onstarchange?.()
  }

  const chg = $derived(coin.priceChange24hBps ?? null)
  const paid = $derived(BigInt(coin.rewards.paidSolanaZec || '0') + BigInt(coin.rewards.paidShieldedZec || '0'))
  const perHolder = $derived.by(() => {
    if (!extras || extras.holdersPotZats == null || !extras.holdersCount) return null
    return BigInt(extras.holdersPotZats) / BigInt(extras.holdersCount)
  })
</script>

<div class="drow" class:bag={bagZats !== null} role="row">
  <div class="c-coin" role="cell">
    <button class="star" type="button" aria-pressed={starred} aria-label={starred ? `Stop watching ${coin.name}` : `Watch ${coin.name}`} onclick={star}>{starred ? '★' : '☆'}</button>
    <a class="who" href="#/coin/{coin.mint}">
      <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={26} />
      <span class="names"><span class="nm">{coin.name}</span><span class="sym mono">${coin.symbol}</span></span>
    </a>
    {#if delta.length}<span class="crease mono">{delta.join(', ')} since {deltaBase === 'star' ? 'starred' : 'you looked'}</span>{/if}
    {#if bagZats !== null}<span class="bagv mono">you hold {zec(bagZats, 2)}</span>{/if}
  </div>
  <span class="n mono prim" role="cell">{coin.priceZec === undefined ? '–' : pricePerMillion(coin.priceZec)}</span>
  <span class="n mono" role="cell" class:up={chg !== null && chg > 0} class:dn={chg !== null && chg < 0}>{chg === null ? '–' : `${chg > 0 ? '+' : ''}${(chg / 100).toFixed(1)}%`}</span>
  <span class="n mono hide-md" role="cell">{coin.marketCapZec === undefined ? '–' : zec(coin.marketCapZec, 2)}</span>
  <span class="n mono hide-md" role="cell">{coin.volume24hZats === undefined ? '–' : zec(coin.volume24hZats, 2)}</span>
  <span class="n mono hide-md" role="cell">{coin.holders == null ? '–' : coin.holders.toLocaleString('en-US')}</span>
  <span class="viz hide-md" role="cell">
    {#if extras}<ConcRule top10={extras.top10Pct} dev={extras.devPct} pool={extras.poolPct} />{:else}<span class="label">&ndash;</span>{/if}
  </span>
  <span class="n mono hide-md" role="cell">{#if paid > 0n}{zec(paid, 2)} <span class="nn">n={coin.rewards.epochs}</span>{:else}–{/if}</span>
  <span class="n mono hide-md" role="cell">{perHolder === null ? '–' : zec(perHolder, 6)}</span>
  <span class="viz c-spark" role="cell">
    {#if extras?.trades}<Spark trades={extras.trades} />{:else}<span class="label">&ndash;</span>{/if}
  </span>
  <span class="n mono hide-md c-age" role="cell">{ago(coin.createdAt, now)}</span>
</div>

<style>
  .drow { display: grid; grid-template-columns: minmax(0, 2.4fr) .9fr .6fr .9fr .9fr .6fr 64px 1.1fr .9fr 84px .6fr; gap: var(--s-3);
    align-items: center; min-height: 34px; padding: 3px var(--s-2); border-bottom: 1px solid var(--line); font-size: var(--t-12); position: relative;
    transition: background-color var(--d-fn) var(--ease); }
  @media (hover: hover) { .drow:hover { background: var(--hover); } }
  .drow.bag { box-shadow: inset 3px 0 0 var(--pink); }
  .c-coin { display: flex; align-items: center; gap: var(--s-2); min-width: 0; }
  .star { border: 0; background: none; font: inherit; font-size: var(--t-14); line-height: 1; color: var(--ink-3); cursor: pointer; padding: 4px; margin: -4px 0; border-radius: var(--r-xs); }
  .star[aria-pressed='true'] { color: var(--pink); }
  @media (hover: hover) { .star:hover { color: var(--ink); } }
  .who { display: flex; align-items: center; gap: var(--s-2); min-width: 0; text-decoration: none; color: inherit; }
  @media (hover: hover) { .who:hover .nm { text-decoration: underline; } }
  .names { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; overflow: hidden; }
  .nm { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 16ch; }
  .sym { color: var(--ink-3); font-size: var(--t-11); }
  .crease, .bagv { font-size: var(--t-11); color: var(--ink-2); white-space: nowrap; padding-left: var(--s-2); border-left: 2px dashed var(--pink);
    overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
  .bagv { border-left-color: var(--ink-3); }
  .n { text-align: right; font-size: var(--t-12); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .prim { font-weight: 700; }
  .nn { color: var(--ink-3); font-size: var(--t-11); }
  .up { color: var(--good); }
  .dn { color: var(--bad); }
  .viz { display: flex; justify-content: flex-end; }
  @media (max-width: 800px) {
    /* the phone two-line row: name, price and change on line one; the trade line fills line two */
    .drow { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-rows: auto auto; row-gap: 2px; padding-block: var(--s-2); }
    .hide-md { display: none; }
    .c-coin { grid-column: 1; grid-row: 1; }
    .c-spark { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
  }
</style>
