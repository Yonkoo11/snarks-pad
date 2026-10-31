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
  import { peek } from '../lib/peek.svelte'
  import { layers, dossierKey } from '../lib/layers.svelte'
  import { compare, MAX_PINS } from '../lib/compare.svelte'

  const { coin, now, bagZats = null, deltaBase = 'look', dens = 2, returnedAt = null, onstarchange }: {
    coin: Coin
    now: number
    dens?: 1 | 2 | 3 // how much of a row shows: one line, the default, or the supply numbers written out
    returnedAt?: number | null // set on the row you came back from: it says what moved while you were away
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

  const pinned = $derived(compare.has(coin.mint))
  let pinNote = $state(false)
  function pin() {
    if (!compare.toggle(coin.mint)) { pinNote = true; setTimeout(() => (pinNote = false), 2400) }
  }

  // the row opens its sheet; the name is the link that leaves the page
  function open(e: MouseEvent) {
    if (suppress) { suppress = false; e.preventDefault(); e.stopPropagation(); return }
    if ((e.target as HTMLElement).closest('a, button')) return
    layers.open({ kind: 'dossier', key: dossierKey(coin.mint), title: `$${coin.symbol}` })
  }
  // a resting mouse or a held finger opens the peek card; a held finger must not also follow the link under it
  let suppress = false
  let hold: ReturnType<typeof setTimeout> | null = null
  let el = $state<HTMLElement>()
  function enter(e: PointerEvent) {
    if (e.pointerType === 'mouse' && el) peek.hover(coin, e.clientX, el.getBoundingClientRect())
  }
  function leave() { peek.hide(); if (hold) { clearTimeout(hold); hold = null } }
  function down(e: PointerEvent) {
    if (e.pointerType !== 'touch' || !el) return
    hold = setTimeout(() => { hold = null; suppress = true; peek.show(coin, e.clientX, el!.getBoundingClientRect(), true) }, 420)
  }
  function up() { if (hold) { clearTimeout(hold); hold = null } if (peek.touch) peek.hide() }

  const chg = $derived(coin.priceChange24hBps ?? null)
  const paid = $derived(BigInt(coin.rewards.paidSolanaZec || '0') + BigInt(coin.rewards.paidShieldedZec || '0'))
  const perHolder = $derived.by(() => {
    if (!extras || extras.holdersPotZats == null || !extras.holdersCount) return null
    return BigInt(extras.holdersPotZats) / BigInt(extras.holdersCount)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="drow d{dens}"
  data-coin-mint={coin.mint}
  class:bag={bagZats !== null}
  class:returned={returnedAt !== null}
  role="row"
  tabindex="-1"
  bind:this={el}
  onclick={open}
  onpointerenter={enter}
  onpointerleave={leave}
  onpointerdown={down}
  onpointerup={up}
  onpointercancel={up}
  oncontextmenu={(e) => { if (peek.touch || suppress) e.preventDefault() }}
>
  <div class="c-coin" role="cell">
    <button class="star" type="button" aria-pressed={starred} aria-label={starred ? `Stop watching ${coin.name}` : `Watch ${coin.name}`} onclick={star}>{starred ? '★' : '☆'}</button>
    <button class="pin" type="button" aria-pressed={pinned} aria-label={pinned ? `Take ${coin.name} off the compare shelf` : `Pin ${coin.name} to compare`} title={pinNote ? `The shelf holds ${MAX_PINS} coins` : pinned ? 'On the compare shelf' : 'Pin to compare'} onclick={pin}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="3.5" width="8" height="8" rx="1" /><rect x="6.5" y="5.5" width="8" height="8" rx="1" /></svg>
    </button>
    <a class="who" href="#/coin/{coin.mint}">
      <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={26} />
      <span class="names"><span class="nm">{coin.name}</span><span class="sym mono">${coin.symbol}</span></span>
    </a>
    {#if returnedAt !== null}<span class="crease back mono">{delta.length ? delta.join(', ') : 'no change'} since you left, {ago(new Date(returnedAt).toISOString(), now)}</span>
    {:else if delta.length}<span class="crease mono">{delta.join(', ')} since {deltaBase === 'star' ? 'starred' : 'you looked'}</span>{/if}
    {#if bagZats !== null}<span class="bagv mono">you hold {zec(bagZats, 2)}</span>{/if}
  </div>
  <span class="n mono prim" role="cell">{coin.priceZec === undefined ? '–' : pricePerMillion(coin.priceZec)}</span>
  <span class="n mono" role="cell" class:up={chg !== null && chg > 0} class:dn={chg !== null && chg < 0}>{chg === null ? '–' : `${chg > 0 ? '+' : ''}${(chg / 100).toFixed(1)}%`}</span>
  <span class="n mono hide-md" role="cell">{coin.marketCapZec === undefined ? '–' : zec(coin.marketCapZec, 2)}</span>
  <span class="n mono hide-md" role="cell">{coin.volume24hZats === undefined ? '–' : zec(coin.volume24hZats, 2)}</span>
  <span class="n mono hide-md" role="cell">{coin.holders == null ? '–' : coin.holders.toLocaleString('en-US')}</span>
  <span class="viz hide-md" role="cell">
    {#if extras}<ConcRule top10={extras.top10Pct} dev={extras.devPct} pool={extras.poolPct} />{:else}<span class="label">&ndash;</span>{/if}
    {#if dens === 3 && extras}<span class="agg mono">top10 {extras.top10Pct == null ? '–' : `${Math.round(extras.top10Pct)}%`} dev {extras.devPct == null ? '–' : `${Math.round(extras.devPct)}%`}</span>{/if}
  </span>
  <span class="n mono hide-md" role="cell">{#if paid > 0n}{zec(paid, 2)} <span class="nn">n={coin.rewards.epochs}</span>{:else}–{/if}</span>
  <span class="n mono hide-md" role="cell">{perHolder === null ? '–' : zec(perHolder, 6)}</span>
  <span class="viz c-spark" role="cell">
    {#if extras?.trades}<Spark trades={extras.trades} w={dens === 3 ? 96 : 76} h={dens === 3 ? 38 : 22} />{:else}<span class="label">&ndash;</span>{/if}
  </span>
  <span class="n mono hide-md c-age" role="cell">{ago(coin.createdAt, now)}</span>
</div>

<style>
  .drow { display: grid; grid-template-columns: minmax(0, 2.4fr) .9fr .6fr .9fr .9fr .6fr var(--supply-col, 64px) 1.1fr .9fr 84px .6fr; gap: var(--s-3);
    align-items: center; min-height: 34px; padding: 3px var(--s-2); border-bottom: 1px solid var(--line); font-size: var(--t-12); position: relative;
    transition: background-color var(--d-fn) var(--ease); }
  @media (hover: hover) { .drow:hover { background: var(--hover); } }
  .drow.bag { box-shadow: inset 3px 0 0 var(--pink); }
  .drow { cursor: pointer; }
  .viz { display: flex; }
  .drow.d1 { min-height: 26px; padding-block: 0; }
  .drow.d1 .crease, .drow.d1 .bagv { display: none; }
  .drow.d3 { min-height: 60px; }
  .drow.returned { animation: returned 2.4s var(--ease); }
  @keyframes returned { 0%, 40% { background: var(--pink-soft); } }
  .crease.back { border-left-style: solid; color: var(--ink); }
  .pin { border: 0; background: none; padding: 4px; margin: -4px 0; line-height: 0; color: var(--ink-3); cursor: pointer; border-radius: var(--r-xs); }
  .pin svg { fill: none; stroke: currentColor; stroke-width: 1.4; }
  .pin[aria-pressed='true'] { color: var(--ink); }
  .pin[aria-pressed='true'] svg rect:last-child { fill: var(--ink); }
  @media (hover: hover) { .pin:hover { color: var(--ink); } }
  .agg { font-size: var(--t-11); color: var(--ink-2); white-space: nowrap; }
  .viz { flex-direction: column; align-items: flex-end; gap: 2px; }
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
  @media (max-width: 800px) {
    /* the phone two-line row: name, price and change on line one; the trade line fills line two */
    .drow { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-rows: auto auto; row-gap: 2px; padding-block: var(--s-2); }
    .hide-md { display: none; }
    .c-coin { grid-column: 1; grid-row: 1; }
    .c-spark { grid-column: 1 / -1; grid-row: 2; align-items: flex-start; }
  }
</style>
