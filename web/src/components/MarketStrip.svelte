<script lang="ts">
  // The pool's market numbers in one terminal row, over a window the reader picks: how far the price moved, how much traded, how
  // many buys and sells and how many different wallets made them, what the pool holds. On mainnet every figure is the pool's own
  // on-chain reading; elsewhere it is counted from the trades the pad recorded, and the line says so. A dash is a figure not served.
  import type { Coin, FeedTrade, PadMode } from '../lib/types'
  import { poolStats, statsFromTrades, chainFromRecorded, WINDOWS, WIN_LABEL, type PoolStats, type Win } from '../lib/pool'
  import { poolProviderOn } from '../lib/chartSource'
  import { api } from '../lib/api'
  import { poll } from '../lib/poll'
  import { zec } from '../lib/format'
  import Prov from './Prov.svelte'

  const { coin, mode }: { coin: Coin; mode: PadMode | null } = $props()
  // primitives: an effect reading these is not re-run when the page hands over a fresh coin object
  const mint = $derived(coin.mint)
  const poolId = $derived(coin.poolId)
  let win = $state<Win>('h24')
  let stats = $state<PoolStats | null>(null)
  let source = $state<'chain' | 'recorded'>('chain')
  let failed = $state(false)
  let now = $state(Date.now())
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })

  async function load() {
    try {
      if (poolProviderOn(mode) && poolId) { stats = await poolStats(poolId); source = 'chain' }
      else {
        const r = await api.trades({ mint, limit: 40 }).then((x) => x.trades as FeedTrade[])
        stats = statsFromTrades(chainFromRecorded(r), Date.now()); source = 'recorded'
      }
      failed = false
    } catch { failed = true }
  }
  $effect(() => { void [mint, poolId, mode]; stats = null; return poll(load, 30_000) })

  const f = (v: number | null, dp = 2) => (v === null ? '–' : v.toLocaleString('en-US', { maximumFractionDigits: dp }))
  const z = (v: number | null) => (v === null ? '–' : `${v >= 100 ? f(v, 1) : f(v, 3)} ZEC`)
  const tx = $derived(stats?.txns[win] ?? null)
  const total = $derived(tx ? tx.buys + tx.sells : 0)
  const chg = $derived(stats?.priceChange[win] ?? null)
  const poolAge = $derived(stats?.createdAt ? Math.max(0, Math.round((now - Date.parse(stats.createdAt)) / 3_600_000)) : null)
</script>

<section class="ms" aria-label="Market numbers">
  <div class="top">
    <div class="seg" role="group" aria-label="Window">{#each WINDOWS as w (w)}<button type="button" aria-pressed={win === w} onclick={() => (win = w)}>{WIN_LABEL[w]}</button>{/each}</div>
    <span class="src muted">{source === 'chain' ? 'On-chain, from the pool' : 'Counted from the trades the pad recorded'}{#if stats}<Prov label="market numbers" src={source === 'chain' ? 'GeckoTerminal pool statistics for this pool, priced in ZEC' : 'The pad API trades for this coin, counted in this browser'} at={stats.at} {now} note={source === 'chain' ? 'Volume is converted from dollars at the pool quote price the provider states.' : 'Only trades made through the pad\'s own buy box are in it.'} />{/if}</span>
  </div>
  {#if failed && !stats}
    <p class="muted">The market numbers did not load. <button class="lnk" type="button" onclick={load}>Try again</button></p>
  {:else if !stats}
    <div class="skel" style="height: 56px" aria-busy="true" role="status" aria-label="Loading the market numbers"></div>
  {:else}
    <dl>
      <div><dt class="label">Price {WIN_LABEL[win]}</dt><dd class="mono" class:up={chg !== null && chg > 0} class:dn={chg !== null && chg < 0}>{chg === null ? '–' : `${chg > 0 ? '+' : ''}${f(chg, 2)}%`}</dd></div>
      <div><dt class="label">Volume</dt><dd class="mono">{z(stats.volumeZec[win])}</dd></div>
      <div class="wide"><dt class="label">Buys / sells</dt><dd class="mono">{tx ? `${tx.buys} / ${tx.sells}` : '–'}</dd>{#if tx && total > 0}<span class="ratio" role="img" aria-label="{Math.round((tx.buys / total) * 100)} percent of trades were buys"><i style:width="{(tx.buys / total) * 100}%"></i></span>{/if}</div>
      <div><dt class="label">Buyers / sellers</dt><dd class="mono">{tx ? `${tx.buyers} / ${tx.sellers}` : '–'}</dd></div>
      <div><dt class="label">Liquidity</dt><dd class="mono">{z(stats.reserveZec)}</dd></div>
      <div><dt class="label">FDV</dt><dd class="mono">{z(stats.fdvZec)}</dd></div>
      {#if poolAge !== null}<div><dt class="label">Pool age</dt><dd class="mono">{poolAge < 48 ? `${poolAge}h` : `${Math.round(poolAge / 24)}d`}</dd></div>{/if}
      {#if coin.stage === 'curve' && stats.graduationPct !== null}<div><dt class="label">Curve</dt><dd class="mono">{f(stats.graduationPct, 1)}%</dd></div>{/if}
    </dl>
    {#if source === 'recorded'}<p class="muted small">Buys, sells and wallets are counted from the newest {coin.symbol} trades the pad recorded, so a window can hold fewer trades than the pool saw. Price change, liquidity and FDV come from the pool on mainnet.</p>{/if}
  {/if}
</section>

<style>
  .ms { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: var(--s-3); padding: var(--s-3) var(--s-4); background: var(--paper-2); border-radius: var(--r-md); box-shadow: var(--sh-1); }
  .top { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap; }
  .top .seg button { min-height: 32px; padding: 0 var(--s-3); font-size: var(--t-12); }
  .src { font-size: var(--t-11); }
  dl { display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); margin: 0; }
  dl > div { display: grid; gap: 2px; align-content: start; }
  dd { margin: 0; font-size: var(--t-14); font-weight: 700; font-variant-numeric: tabular-nums; }
  .up { color: var(--good); } .dn { color: var(--bad); }
  .ratio { display: block; width: 96px; height: 4px; background: var(--bad); border-radius: 2px; overflow: hidden; opacity: .8; }
  .ratio i { display: block; height: 100%; background: var(--good); }
  .small { font-size: var(--t-11); margin: 0; max-width: 90ch; }
  .lnk { border: 0; background: none; color: inherit; text-decoration: underline; font: inherit; cursor: pointer; }
</style>
