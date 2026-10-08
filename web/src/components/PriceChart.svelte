<script lang="ts">
  import { api } from '../lib/api'
  import type { PricePoint } from '../lib/types'
  import { pricePerMillion, ago } from '../lib/format'
  import { nearestIndex, plot, toChartPoints } from '../lib/chart'
  import { poll } from '../lib/poll'

  // The coin page's price chart: one point per recorded trade, drawn as a line. Loading, empty and error are
  // states of their own. No library: an SVG path, ink on paper, no motion.
  let { mint, symbol }: { mint: string; symbol: string } = $props()

  const W = 600, H = 200
  let points = $state<PricePoint[] | null>(null)
  let failed = $state(false)
  let hover = $state<number | null>(null)
  let box: HTMLDivElement | undefined = $state()

  async function load() {
    try { points = (await api.priceHistory(mint)).points; failed = false }
    catch { failed = true }
  }
  $effect(() => { points = null; failed = false; return poll(load, 15_000) })

  const data = $derived(points ? toChartPoints(points) : [])
  const p = $derived(plot(data, W, H))
  const shown = $derived(hover !== null && p ? Math.min(hover, data.length - 1) : data.length - 1)
  const first = $derived(data[0]), last = $derived(data[data.length - 1])
  const wide = $derived(last && first ? last.t - first.t > 36 * 3_600_000 : false)
  const day = (t: number) => new Date(t).toLocaleString('en-GB', wide ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' })

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
      <p class="read mono" aria-live="polite">{pricePerMillion(String(data[shown].v))} ZEC <span class="muted">{ago(new Date(data[shown].t).toISOString())}</span></p>
    {/if}
  </div>

  {#if failed && !points}
    <div class="state"><p class="error">Could not load the price history.</p><button class="btn" onclick={load}>Try again</button></div>
  {:else if !points}
    <div class="skel plot-skel" aria-label="Loading the price chart"></div>
  {:else if !p}
    <p class="state muted">No trades yet. The chart starts with the first buy of ${symbol}.</p>
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
      <span class="dot" style:left="{(p.xs[shown] / W) * 100}%" style:top="{(p.ys[shown] / H) * 100}%"></span>
      </div>
      <span class="y hi mono">{pricePerMillion(String(p.max))}</span>
      <span class="y lo mono">{pricePerMillion(String(p.min))}</span>
    </div>
    <p class="x muted"><span class="mono">{day(first.t)}</span><span><span class="mono">{data.length}</span> {data.length === 1 ? 'trade' : 'trades'}, ZEC per 1M {symbol}</span><span class="mono">{day(last.t)}</span></p>
  {/if}
</section>

<style>
  .chart { display: grid; gap: var(--s-3); }
  .c-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-4); flex-wrap: wrap; }
  .read { font-size: var(--t-16); font-weight: 500; }
  .plot { position: relative; height: 220px; border-radius: var(--r-lg); background: var(--paper-2); box-shadow: var(--sh-2); padding: var(--s-4) var(--s-5); outline-offset: 3px; }
  .inner { position: relative; height: 100%; }
  .plot svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .line { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: var(--paper-3); }
  .cursor { stroke: var(--ink-3); stroke-width: 1; }
  .dot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: var(--r-full); background: var(--ink); box-shadow: 0 0 0 3px var(--paper-2); pointer-events: none; }
  .y { position: absolute; right: var(--s-3); font-size: var(--t-12); color: var(--ink-2); }
  .hi { top: var(--s-2); }
  .lo { bottom: var(--s-2); }
  .x { display: flex; justify-content: space-between; gap: var(--s-3); font-size: var(--t-12); }
  .state { display: grid; gap: var(--s-3); justify-items: start; min-height: 120px; align-content: center; }
  .plot-skel { height: 220px; border-radius: var(--r-lg); }
  @media (max-width: 640px) { .plot { height: 180px; padding: var(--s-3); } }
</style>
