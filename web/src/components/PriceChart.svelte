<script lang="ts">
  import { api } from '../lib/api'
  import type { PricePoint } from '../lib/types'
  import { pricePerMillion, usdOfZats, ago } from '../lib/format'
  import { nearestIndex, plot, toChartPoints, sinceOf, type Range } from '../lib/chart'
  import { zecUsd } from '../lib/usd.svelte'
  import { poll } from '../lib/poll'

  // The coin page's price chart: one point per recorded trade, drawn as a line. Points are spread evenly by trade,
  // not by wall clock (a coin trades in bursts; a clock axis would be mostly empty), and the cursor's read-out gives
  // each trade's time. Loading, empty and error are states of their own. No library: an SVG path, ink on paper.
  // The last trade wears a crayon circle: that is "now".
  let { mint, symbol }: { mint: string; symbol: string } = $props()

  const W = 600, H = 200
  let points = $state<PricePoint[] | null>(null)
  let failed = $state(false)
  let hover = $state<number | null>(null)
  let box: HTMLDivElement | undefined = $state()
  let unit = $state<'zec' | 'usd'>('zec')
  let range = $state<Range>('all')
  const RANGES: { id: Range; label: string }[] = [{ id: '24h', label: '24h' }, { id: '7d', label: '7d' }, { id: 'all', label: 'All' }]

  async function load() {
    try { points = (await api.priceHistory(mint)).points; failed = false }
    catch { failed = true }
  }
  $effect(() => { points = null; failed = false; return poll(load, 15_000) })

  const all = $derived(points ? toChartPoints(points) : [])
  const data = $derived.by(() => {
    const since = sinceOf(range, Date.now())
    return since === null ? all : all.filter((p) => p.t >= since)
  })
  const p = $derived(plot(data, W, H))
  const shown = $derived(hover !== null && p ? Math.min(hover, data.length - 1) : data.length - 1)
  const first = $derived(data[0]), last = $derived(data[data.length - 1])
  const wide = $derived(last && first ? last.t - first.t > 36 * 3_600_000 : false)
  const day = (t: number) => new Date(t).toLocaleString('en-GB', wide ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' })
  const whenAt = (t: number) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  // One label for a price in the picked unit. USD is offered only while a rate is known.
  const read = (v: number): string => (unit === 'usd' ? (usdOfZats(v * 1e6, zecUsd.rate) ?? '') : `${pricePerMillion(String(v))} ZEC`)
  $effect(() => { if (unit === 'usd' && !zecUsd.rate) unit = 'zec' })

  function move(e: PointerEvent) {
    if (!p || !box) return
    const r = box.getBoundingClientRect()
    hover = nearestIndex(p.xs, ((e.clientX - r.left) / r.width) * W)
  }
  function key(e: KeyboardEvent) {
    if (!p) return
    const cur = hover ?? data.length - 1
    if (e.key === 'ArrowLeft') { hover = Math.max(0, cur - 1); e.preventDefault() }
    else if (e.key === 'ArrowRight') { hover = Math.min(data.length - 1, cur + 1); e.preventDefault() }
    else if (e.key === 'Escape') hover = null
  }
</script>

<section class="chart" aria-labelledby="chart-h">
  <div class="c-head">
    <h2 class="h3" id="chart-h">Price</h2>
    {#if p && data[shown]}
      <p class="read mono" aria-live="polite">{read(data[shown].v)} <span class="muted">{ago(new Date(data[shown].t).toISOString())}</span></p>
    {/if}
    <div class="c-ctl">
      <div class="seg mini" role="group" aria-label="Time range">
        {#each RANGES as r (r.id)}<button type="button" aria-pressed={range === r.id} class:on={range === r.id} onclick={() => { range = r.id; hover = null }}>{r.label}</button>{/each}
      </div>
      {#if zecUsd.rate}
        <div class="seg mini" role="group" aria-label="Price unit">
          <button type="button" aria-pressed={unit === 'zec'} class:on={unit === 'zec'} onclick={() => (unit = 'zec')}>ZEC</button>
          <button type="button" aria-pressed={unit === 'usd'} class:on={unit === 'usd'} onclick={() => (unit = 'usd')}>USD</button>
        </div>
      {/if}
    </div>
  </div>

  {#if failed && !points}
    <div class="state"><p class="error">Could not load the price history.</p><button class="btn" onclick={load}>Try again</button></div>
  {:else if !points}
    <div class="skel plot-skel" aria-label="Loading the price chart"></div>
  {:else if !p}
    {#if range !== 'all' && all.length > 0}
      <p class="state muted">No trade in this range. <button class="linkish" type="button" onclick={() => (range = 'all')}>Show all {all.length}</button></p>
    {:else}
      <p class="state muted">No trades yet. The chart starts with the first buy of ${symbol}.</p>
    {/if}
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="plot" bind:this={box} onpointermove={move} onpointerleave={() => (hover = null)} onkeydown={key} tabindex="0" role="img"
      aria-label="Price of {symbol} over its last {data.length} trades, from {pricePerMillion(String(first.v))} to {pricePerMillion(String(last.v))} ZEC. Use the left and right arrow keys to read each trade.">
      <div class="inner">
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="area" d={p.area} />
        <path class="line" d={p.line} vector-effect="non-scaling-stroke" />
        {#if hover !== null}<line class="cursor" x1={p.xs[shown]} x2={p.xs[shown]} y1="0" y2={H} vector-effect="non-scaling-stroke" />{/if}
      </svg>
      <!-- the crayon ring marks the newest trade: two quick passes, like a circled line in a notebook -->
      <svg class="now" viewBox="0 0 28 28" aria-hidden="true" style:left="{(p.xs[p.xs.length - 1] / W) * 100}%" style:top="{(p.ys[p.ys.length - 1] / H) * 100}%">
        <path d="M 14 3.2 C 19.8 2.6 25 7.4 24.6 13.4 C 24.2 19.6 19.4 24.6 13.6 24.4 C 7.6 24.2 3.2 19.4 3.6 13.2 C 4 7.4 8.6 3.8 14 3.2" />
        <path d="M 13.2 4.4 C 18.6 3.4 23.6 8 23.6 13.6 C 23.6 19 19.2 23.4 13.8 23.2 C 8.4 23 4.6 18.6 4.8 13.4 C 5 8.6 8.4 5.2 13.2 4.4" />
      </svg>
      <span class="dot" style:left="{(p.xs[shown] / W) * 100}%" style:top="{(p.ys[shown] / H) * 100}%"></span>
      {#if hover !== null && data[shown]}
        <span class="tip mono" style:left="{Math.min(86, Math.max(8, (p.xs[shown] / W) * 100))}%" style:top="{(p.ys[shown] / H) * 100}%">{read(data[shown].v)} &#183; {whenAt(data[shown].t)}</span>
      {/if}
      </div>
      <span class="y hi mono">{unit === 'usd' ? read(p.max) : pricePerMillion(String(p.max))}</span>
      <span class="y lo mono">{unit === 'usd' ? read(p.min) : pricePerMillion(String(p.min))}</span>
    </div>
    <p class="x muted"><span class="mono">{day(first.t)}</span><span><span class="mono">{data.length}</span> {data.length === 1 ? 'trade' : 'trades'}, {unit === 'usd' ? 'USD' : 'ZEC'} per 1M {symbol}</span><span class="mono">{day(last.t)}</span></p>
  {/if}
</section>

<style>
  .chart { display: grid; gap: var(--s-3); }
  .c-head { display: flex; align-items: center; justify-content: flex-start; gap: var(--s-3) var(--s-4); flex-wrap: wrap; }
  .read { font-size: var(--t-16); font-weight: 500; }
  .c-ctl { margin-left: auto; display: flex; gap: var(--s-2); }
  /* the chart's two small switches share the seg track at a tighter size */
  .seg.mini > button { min-height: 44px; padding: 0 var(--s-3); font-size: var(--t-14); }
  .plot { position: relative; height: 220px; border-radius: var(--r-lg); background: var(--paper-2); box-shadow: var(--sh-2); padding: var(--s-4) var(--s-5); outline-offset: 3px; }
  .inner { position: relative; height: 100%; }
  .plot svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .line { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: var(--paper-3); }
  .cursor { stroke: var(--ink-3); stroke-width: 1; }
  .dot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: var(--r-full); background: var(--ink); box-shadow: 0 0 0 3px var(--paper-2); pointer-events: none; }
  /* wins over `.plot svg` above, which would stretch the ring across the whole box */
  .plot svg.now { position: absolute; width: 28px; height: 28px; margin: -14px 0 0 -14px; pointer-events: none; }
  .now path { fill: none; stroke: var(--pink); stroke-width: 1.6; stroke-linecap: round; opacity: .9; }
  .tip {
    position: absolute; transform: translate(-50%, calc(-100% - 14px)); white-space: nowrap;
    font-size: var(--t-12); padding: 2px var(--s-2); border-radius: var(--r-xs);
    background: var(--ink); color: var(--paper); pointer-events: none;
  }
  .y { position: absolute; right: var(--s-3); font-size: var(--t-12); color: var(--ink-2); }
  .hi { top: var(--s-2); }
  .lo { bottom: var(--s-2); }
  .x { display: flex; justify-content: space-between; gap: var(--s-3); font-size: var(--t-12); }
  .state { display: grid; gap: var(--s-3); justify-items: start; min-height: 120px; align-content: center; }
  .linkish { border: 0; background: none; padding: 0; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
  .plot-skel { height: 220px; border-radius: var(--r-lg); }
  @media (max-width: 640px) { .plot { height: 180px; padding: var(--s-3); } .c-ctl { margin-left: 0; } }
</style>
