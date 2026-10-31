<script lang="ts">
  // The pad's live tape as a list that never moves under your thumb. While the pointer rests on it, focus is inside it, or it is
  // scrolled down, new trades are held behind a ribbon ("7 new") instead of pushing the rows; tapping the ribbon merges them.
  // The count is exact for the rows the feed serves and says "+" when the feed is full.
  import type { FeedTrade } from '../../lib/types'
  import { tradeFeed, type FeedState } from '../../lib/tape'
  import { zec, ago } from '../../lib/format'
  import { hilite } from '../../lib/hilite.svelte'

  const { limit = 30, everyMs = 6000, onpick, now = Date.now() }: { limit?: number; everyMs?: number; onpick: (t: FeedTrade) => void; now?: number } = $props()

  let live = $state<FeedTrade[]>([])
  let shown = $state<FeedTrade[]>([])
  let feed = $state<FeedState>('loading')
  let hover = $state(false)
  let focused = $state(false)
  let scrolled = $state(false)
  let fresh = $state(new Set<string>())
  let box = $state<HTMLElement>()
  const frozen = $derived(hover || focused || scrolled)

  $effect(() => tradeFeed({
    limit, everyMs,
    onRows: (r) => { live = r },
    onState: (s) => (feed = s),
  }))
  // the reader sees the live rows unless something holds them still
  $effect(() => {
    if (frozen && shown.length > 0) return
    const before = new Set(shown.map((t) => t.sig))
    const added = live.filter((t) => !before.has(t.sig)).map((t) => t.sig)
    if (shown.length > 0 && added.length) { fresh = new Set(added); setTimeout(() => (fresh = new Set()), 1400) }
    shown = live
  })
  const queued = $derived.by(() => {
    const seen = new Set(shown.map((t) => t.sig))
    return live.filter((t) => !seen.has(t.sig)).length
  })
  function merge() {
    shown = live
    hover = false; scrolled = false
    box?.scrollTo({ top: 0 })
  }
  // the chart's crosshair lights the tape rows that fall in the candle under it
  const lit = (t: FeedTrade) => hilite.chartMint === t.mint && hilite.chartAt !== null && Math.floor(Date.parse(t.at) / 1000 / hilite.chartSec) * hilite.chartSec === hilite.chartAt
  const tag = (t: FeedTrade) => (t.tags?.includes('dev') ? 'dev' : null)
</script>

<div class="tl">
  {#if queued > 0 && frozen}
    <button class="ribbon" type="button" onclick={merge} aria-live="polite">{queued}{queued >= limit ? '+' : ''} new trade{queued === 1 ? '' : 's'}, held back. Show</button>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rows"
    bind:this={box}
    onpointerenter={(e) => { if (e.pointerType === 'mouse') hover = true }}
    onpointerleave={() => (hover = false)}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
    onscroll={(e) => (scrolled = (e.currentTarget as HTMLElement).scrollTop > 6)}
  >
    {#if feed === 'loading' && shown.length === 0}
      <div class="skel" style="height: 120px" aria-busy="true" role="status" aria-label="Loading the tape"></div>
    {:else if feed === 'lost' && shown.length === 0}
      <p class="muted pad">Lost the connection to the pad. Trying again.</p>
    {:else if shown.length === 0}
      <p class="muted pad">No trades yet.</p>
    {:else}
      {#each shown as t (t.sig)}
        <button class="r" class:new={fresh.has(t.sig)} class:lit={lit(t)} type="button" onclick={() => onpick(t)} onpointerenter={() => { hilite.tradeAt = Date.parse(t.at) / 1000; hilite.tradeMint = t.mint }} onpointerleave={() => { if (hilite.tradeMint === t.mint) hilite.tradeAt = null }} title="Open ${t.symbol}">
          <span class="side caps {t.side}">{t.side}</span>
          <span class="mono sym">${t.symbol}</span>
          <span class="mono amt">{zec(t.amountZec)}{#if tag(t)}<span class="tg">{tag(t)}</span>{/if}</span>
          <span class="muted when">{ago(t.at, now)}</span>
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .tl { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; height: 100%; position: relative; }
  .rows { overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
  .ribbon {
    position: sticky; top: 0; z-index: 2; width: 100%; min-height: 36px; border: 0; background: var(--ink); color: var(--paper);
    font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer;
  }
  .pad { padding: var(--s-3); font-size: var(--t-12); }
  .r {
    width: 100%; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto auto; gap: var(--s-2); align-items: center; text-align: left;
    padding: 6px var(--s-3); min-height: 32px; border: 0; border-bottom: 1px solid var(--line); background: none; color: inherit; font: inherit; font-size: var(--t-12); cursor: pointer;
  }
  @media (hover: hover) { .r:hover { background: var(--hover); } }
  .r.lit { background: var(--pink-soft); box-shadow: inset 2px 0 0 var(--ink); }
  .r.new { animation: trow-in 500ms var(--ease) 1; }
  @keyframes trow-in { from { opacity: 0; transform: translateY(-6px); background: var(--pink-soft); } }
  .side { font-weight: 700; font-size: var(--t-11); letter-spacing: .06em; }
  .side.sell { color: var(--ink-3); }
  .sym { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
  .amt { display: inline-flex; gap: 4px; align-items: center; font-variant-numeric: tabular-nums; }
  .tg { font-size: var(--t-11); font-weight: 700; color: var(--paper); background: var(--ink); border-radius: var(--r-full); padding: 0 5px; }
  .when { font-size: var(--t-11); white-space: nowrap; text-align: right; }
  @media (prefers-reduced-motion: reduce) { .r.new { animation: none; } }
</style>
