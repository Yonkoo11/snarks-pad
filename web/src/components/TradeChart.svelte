<script lang="ts">
  // The coin's market chart: candles and volume on a real time axis, from the pool's own trades (lib/candleSource.ts says which
  // source answered and the line under the chart says it too). Over the candles: the payout rounds that paid THIS coin as dashed
  // lines, the graduation, the creator's sells and your own trades as markers. The last candle follows the pad's live price
  // for display only; every refresh from the source overwrites it. The tape and the chart point at each other.
  import { createChart, CandlestickSeries, HistogramSeries, createSeriesMarkers, CrosshairMode, LineStyle } from 'lightweight-charts'
  import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, UTCTimestamp, SeriesMarker, Time } from 'lightweight-charts'
  import { api } from '../lib/api'
  import type { Coin, Epoch, FeedTrade, PadMode } from '../lib/types'
  import { TIMEFRAMES, secOf, pushObs, priceDecimals, type Candle, type Timeframe } from '../lib/candles'
  import { loadCandles, type CandleResult } from '../lib/candleSource'
  import { VerticalLines } from '../lib/chartPrimitives'
  import { hilite } from '../lib/hilite.svelte'
  import { theme } from '../lib/theme.svelte'
  import { zecUsd } from '../lib/usd.svelte'
  import { wallet } from '../lib/wallet.svelte'
  import { poll } from '../lib/poll'
  import { ago } from '../lib/format'
  import Prov from './Prov.svelte'

  const { coin, epochs, mode }: { coin: Coin; epochs: Epoch[] | null; mode: PadMode | null } = $props()
  const mint = $derived(coin.mint)

  let tf = $state<Timeframe>('15m')
  let unit = $state<'zec' | 'usd'>('zec')
  let metric = $state<'price' | 'mcap'>('price')
  let log = $state(false)
  let res = $state<CandleResult | null>(null)
  let failed = $state(false)
  let trades = $state<FeedTrade[]>([])
  let hover = $state<{ c: Candle; at: number } | null>(null)
  let now = $state(Date.now())
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })
  $effect(() => { zecUsd.refresh() })

  // ---- the data
  async function load() {
    try { res = await loadCandles({ mint, pool: coin.poolId, tf, mode }); failed = false }
    catch { failed = true }
  }
  $effect(() => { void [mint, tf, mode, coin.poolId]; res = null; failed = false; return poll(load, 30_000) })
  $effect(() => {
    void mint
    return poll(() => api.trades({ mint, limit: 40 }).then((r) => (trades = r.trades), () => {}), 30_000)
  })

  // ZEC per whole token (what the source serves) to what is drawn: per 1M tokens (the page's price unit), or the coin's market cap, in ZEC or dollars
  const supply = $derived.by(() => {
    const p = Number(coin.priceZec), m = Number(coin.marketCapZec)
    return Number.isFinite(p) && Number.isFinite(m) && p > 0 && m > 0 ? m / p : null // whole tokens: both are zats, so the zats cancel
  })
  const usd = $derived(unit === 'usd' ? zecUsd.rate : null)
  const canMcap = $derived(supply !== null)
  const k = $derived((metric === 'mcap' && supply ? supply : 1e6) * (usd ?? 1))
  const sec = $derived(secOf(tf))
  const livePrice = $derived(Number(coin.priceZec) / 1e8) // ZEC per whole token, the pad's own figure, read every few seconds

  // the candles with the live price folded in, only when the price really moved off the last candle (a price moves on a trade)
  const candles = $derived.by(() => {
    const base = res?.candles ?? []
    const last = base[base.length - 1]
    if (!last || !Number.isFinite(livePrice) || livePrice <= 0) return base
    if (Math.abs(livePrice - last.close) / last.close < 1e-6) return base
    return pushObs(base, { t: now, v: livePrice }, sec)
  })

  // ---- the chart
  let box = $state<HTMLDivElement>()
  let probes = $state<HTMLElement[]>([])
  let chart: IChartApi | null = null
  let cs: ISeriesApi<'Candlestick'> | null = null
  let vs: ISeriesApi<'Histogram'> | null = null
  let markers: ISeriesMarkersPluginApi<Time> | null = null
  const rounds = new VerticalLines()
  const pointer = new VerticalLines()
  const col = () => {
    const c = probes.map((p) => getComputedStyle(p).color)
    return { ink: c[0], ink2: c[1], ink3: c[2], line: c[3], good: c[4], bad: c[5] }
  }
  const a = (rgb: string, alpha: number) => rgb.replace(/^rgba?\(([^)]+)\)$/, (_, inner: string) => `rgba(${inner.split(',').slice(0, 3).join(',')}, ${alpha})`)

  $effect(() => {
    const el = box
    if (!el) return
    const c = col()
    chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: c.ink2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: a(c.line, 0.5) }, horzLines: { color: a(c.line, 0.5) } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: c.ink3, style: LineStyle.Dashed, labelBackgroundColor: c.ink }, horzLine: { color: c.ink3, style: LineStyle.Dashed, labelBackgroundColor: c.ink } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      handleScale: { axisPressedMouseMove: true },
    })
    cs = chart.addSeries(CandlestickSeries, { upColor: c.good, downColor: c.bad, borderVisible: false, wickUpColor: c.good, wickDownColor: c.bad, priceLineColor: c.ink3 })
    markers = createSeriesMarkers(cs, [])
    cs.attachPrimitive(rounds)
    cs.attachPrimitive(pointer)
    chart.subscribeCrosshairMove((p) => {
      const d = p.time !== undefined ? (p.seriesData.get(cs!) as { open: number; high: number; low: number; close: number } | undefined) : undefined
      if (d && p.time !== undefined) {
        const t = p.time as number
        hover = { at: t, c: { time: t, open: d.open, high: d.high, low: d.low, close: d.close, volume: 0 } }
        hilite.chartAt = t; hilite.chartMint = mint; hilite.chartSec = sec
      } else { hover = null; if (hilite.chartMint === mint) hilite.chartAt = null }
    })
    return () => { chart?.remove(); chart = null; cs = vs = null; markers = null; hilite.chartAt = null }
  })

  // theme: the chart takes the page's inks again when it flips
  $effect(() => {
    void theme.effective
    if (!chart || !cs || probes.length < 6) return
    const c = col()
    chart.applyOptions({ layout: { textColor: c.ink2 }, grid: { vertLines: { color: a(c.line, 0.5) }, horzLines: { color: a(c.line, 0.5) } } })
    cs.applyOptions({ upColor: c.good, downColor: c.bad, wickUpColor: c.good, wickDownColor: c.bad })
  })

  // the numbers drawn; gaps stay gaps (a bucket with no trade is whitespace), up to a count the chart can carry
  const GAP_CAP = 2500
  function withGaps(cands: Candle[], step: number) {
    if (cands.length < 2) return cands.map((c) => ({ ...c }))
    const span = (cands[cands.length - 1].time - cands[0].time) / step
    if (span > GAP_CAP) return cands.map((c) => ({ ...c }))
    const out: ({ time: number } & Partial<Candle>)[] = []
    let i = 0
    for (let t = cands[0].time; t <= cands[cands.length - 1].time; t += step) {
      if (cands[i] && cands[i].time === t) out.push(cands[i++])
      else out.push({ time: t })
    }
    return out
  }
  let fitKey = ''
  $effect(() => {
    if (!chart || !cs) return
    const c = col()
    const drawn = withGaps(candles, sec)
    const pts = candles.flatMap((x) => [x.low * k, x.high * k])
    const dec = priceDecimals(pts)
    cs.applyOptions({ priceFormat: { type: 'price', precision: dec.precision, minMove: dec.minMove } })
    chart.priceScale('right').applyOptions({ mode: log ? 1 : 0 })
    cs.setData(drawn.map((x) => ('open' in x && x.open !== undefined ? { time: x.time as UTCTimestamp, open: x.open! * k, high: x.high! * k, low: x.low! * k, close: x.close! * k } : { time: x.time as UTCTimestamp })))
    // volume has a pane of its own under the candles, as on any trading screen, and exists only when the source carries volume
    const hasVol = candles.some((x) => x.volume > 0)
    if (hasVol && !vs) {
      vs = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 1)
      chart.panes()[0]?.setStretchFactor(3)
      chart.panes()[1]?.setStretchFactor(1)
    } else if (!hasVol && vs) { chart.removeSeries(vs); vs = null }
    vs?.setData(drawn.map((x) => ('open' in x && x.open !== undefined ? { time: x.time as UTCTimestamp, value: (x.volume ?? 0) * (usd ?? 1), color: a(x.close! >= x.open! ? c.good : c.bad, 0.45) } : { time: x.time as UTCTimestamp })))
    const key = `${mint}:${tf}:${metric}`
    // a new coin, timeframe or measure opens on the newest ~120 bars (older ones are a scroll away), or all of them when there are fewer
    if (fitKey !== key && drawn.length > 0) {
      fitKey = key
      if (drawn.length > 120) chart.timeScale().setVisibleLogicalRange({ from: drawn.length - 120, to: drawn.length + 6 })
      else chart.timeScale().fitContent()
    }
  })

  // markers: graduation, the creator's sells, your own trades (only trades the page has: the newest 40), snapped to the candle they fall in
  $effect(() => {
    if (!markers || candles.length === 0) return
    const c = col()
    const first = candles[0].time, last = candles[candles.length - 1].time
    const snap = (ms: number) => Math.floor(ms / 1000 / sec) * sec
    const within = (t: number) => t >= first && t <= last
    const ms: SeriesMarker<Time>[] = []
    if (coin.graduatedAt && within(snap(Date.parse(coin.graduatedAt)))) ms.push({ time: snap(Date.parse(coin.graduatedAt)) as UTCTimestamp, position: 'aboveBar', shape: 'square', color: c.ink, text: 'Graduated' })
    for (const t of trades) {
      const at = snap(Date.parse(t.at))
      if (!within(at)) continue
      if (t.side === 'sell' && t.tags.includes('dev')) ms.push({ time: at as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: c.bad, text: 'dev sold' })
      else if (wallet.address && t.wallet === wallet.address) ms.push({ time: at as UTCTimestamp, position: t.side === 'buy' ? 'belowBar' : 'aboveBar', shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown', color: c.ink, text: t.side === 'buy' ? 'you bought' : 'you sold' })
    }
    ms.sort((x, y) => (x.time as number) - (y.time as number))
    markers.setMarkers(ms)
  })

  // payout rounds that paid this coin: the dashed lines
  $effect(() => {
    void theme.effective
    if (probes.length < 6) return
    const c = col()
    const n = epochs?.length ?? 0
    rounds.set((epochs ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e.coinMints.includes(mint)).map(({ e, i }) => ({ time: Date.parse(e.at) / 1000, label: `Round ${n - i}` })), { line: c.ink3, text: c.ink2 })
  })
  // the tape's trade under the pointer, drawn as a hairline on the chart
  $effect(() => {
    void theme.effective
    if (probes.length < 6) return
    const c = col()
    const t = hilite.tradeMint === mint ? hilite.tradeAt : null
    pointer.set(t === null ? [] : [{ time: Math.floor(t / sec) * sec, label: '' }], { line: c.ink, text: c.ink })
  })

  const last = $derived(candles[candles.length - 1])
  const shown = $derived(hover?.c ?? last)
  const fmt = (v: number) => {
    const d = priceDecimals([v * k]).precision
    return (v * k).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  }
  const chg = $derived(coin.priceChange24hBps ?? null)
  const unitLabel = $derived(`${metric === 'mcap' ? 'Market cap' : 'Price per 1M'} ${coin.symbol}, ${usd ? 'USD' : 'ZEC'}`)
  const sourceLine = $derived(res ? (res.source === 'geckoterminal' ? 'GeckoTerminal pool candles, every on-chain trade of this pool' : 'The pad\'s recorded trades: only trades made through the pad\'s own buy box') : '')
</script>

<section class="tc" aria-label="Market chart for {coin.symbol}">
  <span class="probe" bind:this={probes[0]} style="color: var(--ink)" aria-hidden="true"></span><span class="probe" bind:this={probes[1]} style="color: var(--ink-2)" aria-hidden="true"></span><span class="probe" bind:this={probes[2]} style="color: var(--ink-3)" aria-hidden="true"></span><span class="probe" bind:this={probes[3]} style="color: var(--line)" aria-hidden="true"></span><span class="probe" bind:this={probes[4]} style="color: var(--good)" aria-hidden="true"></span><span class="probe" bind:this={probes[5]} style="color: var(--bad)" aria-hidden="true"></span>

  <div class="bar">
    <div class="read" aria-live="off">
      <span class="label">{unitLabel}</span>
      {#if shown}
        <span class="big mono">{fmt(shown.close)}</span>
        {#if chg !== null && !hover}<span class="mono chg" class:up={chg > 0} class:dn={chg < 0}>{chg > 0 ? '+' : ''}{(chg / 100).toFixed(1)}% 24h</span>{/if}
        {#if hover}<span class="mono ohlc">O {fmt(hover.c.open)} H {fmt(hover.c.high)} L {fmt(hover.c.low)} C {fmt(hover.c.close)}</span>{/if}
      {:else}<span class="big mono">–</span>{/if}
    </div>
    <div class="ctl">
      <div class="seg" role="group" aria-label="Timeframe">{#each TIMEFRAMES as t (t.id)}<button type="button" aria-pressed={tf === t.id} onclick={() => (tf = t.id)}>{t.label}</button>{/each}</div>
      <div class="seg" role="group" aria-label="Measure"><button type="button" aria-pressed={metric === 'price'} onclick={() => (metric = 'price')}>Price</button><button type="button" aria-pressed={metric === 'mcap'} disabled={!canMcap} onclick={() => (metric = 'mcap')}>Mcap</button></div>
      <div class="seg" role="group" aria-label="Currency"><button type="button" aria-pressed={unit === 'zec'} onclick={() => (unit = 'zec')}>ZEC</button><button type="button" aria-pressed={unit === 'usd'} disabled={zecUsd.rate === null} onclick={() => (unit = 'usd')}>USD</button></div>
      <button type="button" class="tog" aria-pressed={log} onclick={() => (log = !log)} title="Logarithmic price scale">Log</button>
      <button type="button" class="tog" onclick={() => chart?.timeScale().fitContent()} title="Fit every candle">All</button>
    </div>
  </div>

  <div class="plot">
    <div class="canvas" bind:this={box}></div>
    {#if failed && !res}<p class="over error" role="alert">Could not load the chart. <button class="btn ghost" type="button" onclick={load}>Try again</button></p>
    {:else if !res}<div class="over skel" aria-busy="true" role="status" aria-label="Loading the chart"></div>
    {:else if candles.length === 0}<p class="over muted">No trades yet. The first buy starts the chart.</p>{/if}
  </div>

  <p class="foot muted">
    {sourceLine}{#if res}<Prov label="chart" src={res.source === 'geckoterminal' ? 'GeckoTerminal OHLCV for this pool, read in your browser, priced in ZEC (the pool\'s quote token)' : 'The pad API price history, one point per trade the pad recorded'} n={candles.length} at={res.at} {now} note={res.source === 'geckoterminal' ? 'The newest candle moves with the pad\'s live price and is replaced by the source on its next read.' : 'It does not include trades made outside the pad\'s buy box.'} />{/if}
    {#if res?.note}<span class="warn"> {res.note}</span>{/if}
    Rounds that paid this coin are the dashed lines. {#if last}Last candle {ago(new Date(last.time * 1000).toISOString(), now)}.{/if}
    Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView Lightweight Charts</a>, data by <a href="https://www.geckoterminal.com/" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>.
  </p>
</section>

<style>
  .tc { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s-3); min-width: 0; }
  .tc > * { min-width: 0; }
  .probe { position: absolute; width: 0; height: 0; overflow: hidden; }
  .bar { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--s-3) var(--s-5); flex-wrap: wrap; }
  .read { display: grid; gap: 2px; min-width: 0; }
  .big { font-size: var(--t-20); font-weight: 700; font-variant-numeric: tabular-nums; }
  .chg { font-size: var(--t-12); font-weight: 700; } .up { color: var(--good); } .dn { color: var(--bad); }
  .ohlc { font-size: var(--t-11); color: var(--ink-2); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .ctl { display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center; }
  .ctl .seg button { min-height: 36px; padding: 0 var(--s-3); font-size: var(--t-12); }
  .tog { min-height: 36px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-md); background: var(--paper-3); color: var(--ink-2); font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer; }
  .tog[aria-pressed='true'] { background: var(--ink); color: var(--paper); }
  .plot { position: relative; height: clamp(300px, 46vh, 460px); border-radius: var(--r-md); background: var(--paper-2); box-shadow: var(--sh-1); overflow: hidden; }
  .canvas { position: absolute; inset: 0; }
  .over { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; text-align: center; padding: var(--s-4); pointer-events: none; }
  .over button { pointer-events: auto; }
  .foot { font-size: var(--t-11); max-width: 90ch; margin: 0; }
  .foot a { color: inherit; }
  .warn { color: var(--bad); }
  @media (max-width: 640px) {
    .plot { height: 320px; }
    /* one row you can swipe, not three rows of buttons */
    .ctl { width: 100%; max-width: 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
    .ctl > * { flex: none; }
  }
</style>
