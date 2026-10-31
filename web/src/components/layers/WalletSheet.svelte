<script lang="ts">
  // One wallet, looked at inside one coin, as a layer over the page. What it did here (from the trades the page holds, and it says
  // how many), whether it is among the largest holders, and what else it has launched on this pad. Only facts a public record gives:
  // an address is not a person and the sheet never says who it is.
  import type { Coin, FeedTrade, Holders, PadMode, WalletProfile } from '../../lib/types'
  import { api, onMode } from '../../lib/api'
  import { poolTrades, chainFromRecorded, walletActivity, type ChainTrade } from '../../lib/pool'
  import { walletParts } from '../../lib/layers.svelte'
  import { solanaAccountUrl } from '../../lib/explorer'
  import { profileHref } from '../../lib/profile'
  import { wallet as me } from '../../lib/wallet.svelte'
  import { ago, short } from '../../lib/format'

  const { layerKey }: { layerKey: string } = $props()
  const { wallet, mint } = $derived(walletParts(layerKey))
  let coin = $state<Coin | null>(null)
  let trades = $state<ChainTrade[] | null>(null)
  let holders = $state<Holders | null | undefined>(undefined)
  let profile = $state<WalletProfile | null | undefined>(undefined)
  let mode = $state<PadMode | null>(null)
  let source = $state<'chain' | 'recorded'>('chain')
  let copied = $state(false)
  $effect(() => onMode((m) => (mode = m)))

  $effect(() => {
    const w = wallet, m = mint
    coin = null; trades = null; holders = undefined; profile = undefined
    let live = true
    api.coin(m).then(async (c) => {
      if (!live) return
      coin = c
      try {
        if (mode === 'mainnet' && c.poolId) { trades = await poolTrades(c.poolId, m); source = 'chain' }
        else { trades = chainFromRecorded((await api.trades({ mint: m, limit: 40 })).trades as FeedTrade[]); source = 'recorded' }
      } catch { trades = [] }
    }, () => {})
    api.holders(m, { limit: 100 }).then((h) => { if (live) holders = h }, () => { if (live) holders = null })
    api.wallet(w).then((p) => { if (live) profile = p }, () => { if (live) profile = null })
    return () => { live = false }
  })

  const act = $derived(trades ? walletActivity(trades, wallet) : null)
  const held = $derived(holders ? holders.holders.find((h) => h.wallet === wallet) ?? null : null)
  const isCreator = $derived(coin?.creator === wallet)
  const launched = $derived(profile?.launched ?? [])
  const graduated = $derived(launched.filter((c) => c.stage === 'graduated').length)
  const f = (v: number, dp = 4) => v.toLocaleString('en-US', { maximumFractionDigits: dp })
  async function copy() { try { await navigator.clipboard.writeText(wallet); copied = true; setTimeout(() => (copied = false), 1600) } catch { copied = false } }
</script>

<div class="top">
  <h2 class="display mono addr">{short(wallet, 6, 6)}</h2>
  <div class="tags">{#if isCreator}<span class="tg">creator of ${coin?.symbol}</span>{/if}{#if me.address === wallet}<span class="tg">you</span>{/if}</div>
  <div class="acts">
    <button class="btn ghost" type="button" onclick={copy}>{copied ? 'Copied' : 'Copy address'}</button>
    {#if solanaAccountUrl(wallet, mode)}<a class="btn ghost" href={solanaAccountUrl(wallet, mode)} target="_blank" rel="noreferrer">Explorer</a>{/if}
    <a class="btn ghost" href={profileHref(wallet)}>Pad profile</a>
  </div>
</div>

<section aria-labelledby="w-here">
  <h3 class="label" id="w-here">In {coin ? `$${coin.symbol}` : 'this coin'}</h3>
  {#if !act}
    <div class="skel" style="height: 90px" aria-busy="true" role="status" aria-label="Loading the wallet"></div>
  {:else if act.n === 0}
    <p class="muted">No trade by this wallet in the {trades?.length ?? 0} trades the page holds ({source === 'chain' ? 'the last day on chain' : 'recorded by the pad'}). That says nothing about older trades.</p>
  {:else}
    <dl>
      <div><dt class="label">Trades</dt><dd class="mono">{act.buys} buys / {act.sells} sells</dd></div>
      <div><dt class="label">ZEC in / out</dt><dd class="mono">{f(act.zecIn)} / {f(act.zecOut)}</dd></div>
      <div><dt class="label">Net tokens</dt><dd class="mono">{act.net >= 0 ? '+' : ''}{f(act.net, 0)}</dd></div>
      <div><dt class="label">Average buy per 1M</dt><dd class="mono">{act.avgBuy === null ? '–' : f(act.avgBuy * 1e6)} ZEC</dd></div>
      <div><dt class="label">First / last trade</dt><dd class="mono">{act.first ? ago(new Date(act.first).toISOString()) : '–'} / {act.last ? ago(new Date(act.last).toISOString()) : '–'}</dd></div>
    </dl>
    <p class="muted small">From the {trades?.length} trades the page holds ({source === 'chain' ? 'the pool\'s last day on chain' : 'the ones the pad recorded'}). It is a window, not the wallet's whole history.</p>
  {/if}
</section>

<section aria-labelledby="w-hold">
  <h3 class="label" id="w-hold">Holding</h3>
  {#if holders === undefined}<div class="skel" style="height: 40px"></div>
  {:else if holders === null}<p class="muted">The holder list is not available.</p>
  {:else if held}<p><span class="mono">#{held.rank}</span> of the holder list, <span class="mono">{held.pct >= 10 ? held.pct.toFixed(1) : held.pct.toFixed(2)}%</span> of the supply.</p>
  {:else}<p class="muted">Not among the largest 100 holders listed, or holding none.</p>{/if}
</section>

<section aria-labelledby="w-launch">
  <h3 class="label" id="w-launch">Launched on this pad</h3>
  {#if profile === undefined}<div class="skel" style="height: 40px"></div>
  {:else if profile === null}<p class="muted">Not available.</p>
  {:else if launched.length === 0}<p class="muted">No coin launched from this wallet.</p>
  {:else}
    <p><span class="mono">{launched.length}</span> {launched.length === 1 ? 'coin' : 'coins'}, <span class="mono">{graduated}</span> graduated.</p>
    <ul class="coins">{#each launched.slice(0, 8) as c (c.mint)}<li><a href="#/coin/{c.mint}">${c.symbol}</a> <span class="muted">{c.stage}, {ago(c.createdAt)}</span></li>{/each}</ul>
  {/if}
</section>

<style>
  .top { display: grid; gap: var(--s-3); }
  .addr { font-size: clamp(22px, 5vw, 30px); }
  .tags { display: flex; gap: var(--s-2); flex-wrap: wrap; }
  .tg { font-size: var(--t-12); font-weight: 700; color: var(--paper); background: var(--ink); border-radius: var(--r-full); padding: 2px 10px; }
  .acts { display: flex; gap: var(--s-2); flex-wrap: wrap; }
  .acts .btn { min-height: 40px; font-size: var(--t-14); }
  section { display: grid; gap: var(--s-2); }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--s-3); margin: 0; }
  dd { margin: 2px 0 0; font-size: var(--t-14); font-weight: 700; }
  .small { font-size: var(--t-12); margin: 0; }
  .coins { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--s-2) var(--s-4); flex-wrap: wrap; font-size: var(--t-14); }
</style>
