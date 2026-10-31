<script lang="ts">
  // Every trade of the pool, with the wallet that made it: on mainnet the pool's own on-chain trades of the last day (up to 300, from
  // GeckoTerminal), elsewhere the trades the pad recorded. Filter by side, by size against this coin's own trades, by the creator,
  // by you. A row points at its candle on the chart and the chart's crosshair lights its rows; a wallet opens as a layer.
  import type { Coin, FeedTrade, PadMode } from '../lib/types'
  import { poolTrades, chainFromRecorded, type ChainTrade } from '../lib/pool'
  import { api } from '../lib/api'
  import { poll } from '../lib/poll'
  import { ago, short } from '../lib/format'
  import { solanaTxUrl } from '../lib/explorer'
  import { wallet } from '../lib/wallet.svelte'
  import { hilite } from '../lib/hilite.svelte'
  import { layers, walletKey } from '../lib/layers.svelte'
  import Prov from './Prov.svelte'

  const { coin, mode, now }: { coin: Coin; mode: PadMode | null; now: number } = $props()
  let rows = $state<ChainTrade[] | null>(null)
  let source = $state<'chain' | 'recorded'>('chain')
  let failed = $state(false)
  let readAt = $state<number | null>(null)
  let side = $state<'all' | 'buy' | 'sell'>('all')
  let only = $state<{ big: boolean; dev: boolean; mine: boolean }>({ big: false, dev: false, mine: false })
  let take = $state(40)

  async function load() {
    try {
      if (mode === 'mainnet' && coin.poolId) { rows = await poolTrades(coin.poolId, coin.mint); source = 'chain' }
      else { rows = chainFromRecorded((await api.trades({ mint: coin.mint, limit: 40 })).trades as FeedTrade[]); source = 'recorded' }
      failed = false; readAt = Date.now()
    } catch { failed = true }
  }
  $effect(() => { void [coin.mint, coin.poolId, mode]; rows = null; take = 40; return poll(load, 15_000) })

  const all = $derived(rows ?? [])
  const maxZec = $derived(Math.max(0, ...all.map((t) => t.zec)))
  // "big" is against this coin's own trades: the top tenth by size, once there are enough trades to say
  const bigAt = $derived.by(() => {
    if (all.length < 10) return Infinity
    const s = all.map((t) => t.zec).sort((a, b) => a - b)
    return s[Math.floor(s.length * 0.9)]
  })
  const isDev = (t: ChainTrade) => t.wallet === coin.creator
  const isMe = (t: ChainTrade) => !!wallet.address && t.wallet === wallet.address
  const shown = $derived(all.filter((t) => (side === 'all' || t.side === side) && (!only.big || t.zec >= bigAt) && (!only.dev || isDev(t)) && (!only.mine || isMe(t))))
  const buys = $derived(all.filter((t) => t.side === 'buy').length)
  const lit = (t: ChainTrade) => hilite.chartMint === coin.mint && hilite.chartAt !== null && Math.floor(t.at / 1000 / hilite.chartSec) * hilite.chartSec === hilite.chartAt
  const open = (t: ChainTrade) => layers.open({ kind: 'wallet', key: walletKey(t.wallet, coin.mint), title: short(t.wallet, 4, 4) })
  const f = (v: number, dp: number) => v.toLocaleString('en-US', { maximumFractionDigits: dp })
</script>

<div class="ct">
  <div class="bar">
    <div class="seg" role="group" aria-label="Side">{#each [['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']] as [id, l] (id)}<button type="button" aria-pressed={side === id} onclick={() => (side = id as typeof side)}>{l}</button>{/each}</div>
    <button class="fchip" type="button" aria-pressed={only.big} disabled={bigAt === Infinity} title={bigAt === Infinity ? 'Needs at least 10 trades to say what is big for this coin' : 'The largest tenth of this coin\'s trades'} onclick={() => (only.big = !only.big)}>Big</button>
    <button class="fchip" type="button" aria-pressed={only.dev} onclick={() => (only.dev = !only.dev)}>Creator</button>
    <button class="fchip" type="button" aria-pressed={only.mine} disabled={!wallet.address} onclick={() => (only.mine = !only.mine)}>Mine</button>
    {#if rows}<span class="sum muted">{shown.length} of {all.length} trades, {buys} buys / {all.length - buys} sells</span>{/if}
  </div>

  {#if failed && !rows}
    <p class="muted">The trades did not load. <button class="lnk" type="button" onclick={load}>Try again</button></p>
  {:else if !rows}
    <div class="skel" style="height: 200px" aria-busy="true" role="status" aria-label="Loading the trades"></div>
  {:else if all.length === 0}
    <p class="muted">No trades yet. The first buy starts the curve.</p>
  {:else}
    <div class="tbl" role="table" aria-label="Trades">
      <div class="r h" role="row"><span class="label" role="columnheader">Time</span><span class="label" role="columnheader">Side</span><span class="label num" role="columnheader">ZEC</span><span class="label num hide-sm" role="columnheader">Tokens</span><span class="label" role="columnheader">Wallet</span><span class="label" role="columnheader"></span></div>
      {#each shown.slice(0, take) as t (t.sig)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="r" class:lit={lit(t)} role="row" tabindex="-1" onpointerenter={() => { hilite.tradeAt = t.at / 1000; hilite.tradeMint = coin.mint }} onpointerleave={() => { if (hilite.tradeMint === coin.mint) hilite.tradeAt = null }}>
          <span class="muted" role="cell">{ago(new Date(t.at).toISOString(), now)}</span>
          <span class="side caps {t.side}" role="cell">{t.side}</span>
          <span class="num mono sz" role="cell"><i class="bar2 {t.side}" style:width="{maxZec ? (t.zec / maxZec) * 100 : 0}%"></i><b>{f(t.zec, t.zec >= 10 ? 2 : 4)}</b></span>
          <span class="num mono muted hide-sm" role="cell">{f(t.tokens, 0)}</span>
          <span role="cell" class="who"><button class="w mono" type="button" onclick={() => open(t)} title="Open this wallet">{short(t.wallet, 4, 4)}</button>{#if isDev(t)}<span class="tg">creator</span>{/if}{#if isMe(t)}<span class="tg">you</span>{/if}{#if t.zec >= bigAt}<span class="tg big">big</span>{/if}</span>
          <span role="cell">{#if solanaTxUrl(t.sig, mode)}<a class="tx" href={solanaTxUrl(t.sig, mode)} target="_blank" rel="noreferrer" aria-label="This trade on the Solana explorer">&#8599;</a>{/if}</span>
        </div>
      {/each}
    </div>
    {#if shown.length > take}<button class="btn ghost more" type="button" onclick={() => (take += 40)}>Show 40 more</button>{/if}
    {#if shown.length === 0}<p class="muted">No trade matches those filters.</p>{/if}
    <p class="foot muted">{source === 'chain' ? 'Every trade of this pool in the last day the provider holds, up to 300.' : 'Only the trades the pad recorded: those made through its own buy box.'}{#if readAt}<Prov label="trades" src={source === 'chain' ? 'GeckoTerminal trades for this pool, read in your browser' : 'The pad API trades for this coin'} n={all.length} at={readAt} {now} note="A wallet is a trader's address, not a person: one person can use several." />{/if}</p>
  {/if}
</div>

<style>
  .ct { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s-3); min-width: 0; }
  .bar { display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center; }
  .bar .seg button { min-height: 32px; padding: 0 var(--s-3); font-size: var(--t-12); }
  .fchip { min-height: 32px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-full); background: var(--paper-3); color: var(--ink-2); font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer; }
  .fchip[aria-pressed='true'] { background: var(--ink); color: var(--paper); }
  .fchip:disabled { opacity: .45; cursor: not-allowed; }
  .sum { font-size: var(--t-12); margin-left: auto; }
  .tbl { display: grid; }
  .r { display: grid; grid-template-columns: 64px 44px minmax(90px, 1.2fr) minmax(80px, 1fr) minmax(130px, 1.4fr) 28px; gap: var(--s-3); align-items: center; padding: 5px var(--s-2); border-bottom: 1px solid var(--line); font-size: var(--t-12); }
  .r.h { border-bottom-color: var(--ink-3); padding-block: 3px; }
  .r.lit { background: var(--pink-soft); box-shadow: inset 2px 0 0 var(--ink); }
  @media (hover: hover) { .r:not(.h):hover { background: var(--hover); } }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .side { font-weight: 700; font-size: var(--t-11); letter-spacing: .06em; } .side.sell { color: var(--ink-3); }
  .sz { position: relative; display: block; min-height: 18px; line-height: 18px; }
  .sz b { position: relative; font-weight: 700; }
  .bar2 { position: absolute; right: 0; top: 2px; bottom: 2px; border-radius: 2px; opacity: .22; background: var(--good); } .bar2.sell { background: var(--bad); }
  .who { display: flex; gap: var(--s-1); align-items: center; flex-wrap: wrap; min-width: 0; }
  .w { border: 0; background: none; padding: 2px 4px; margin: -2px -4px; border-radius: var(--r-xs); font: inherit; color: var(--ink); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; cursor: pointer; }
  @media (hover: hover) { .w:hover { background: var(--hover); text-decoration-color: var(--ink-3); } }
  .tg { font-size: var(--t-11); font-weight: 700; color: var(--paper); background: var(--ink); border-radius: var(--r-full); padding: 0 6px; } .tg.big { background: var(--ink-3); }
  .tx { color: var(--ink-2); text-decoration: none; padding: 4px; }
  .more { min-height: 44px; width: max-content; font-size: var(--t-14); }
  .foot { font-size: var(--t-11); margin: 0; }
  .lnk { border: 0; background: none; color: inherit; text-decoration: underline; font: inherit; cursor: pointer; }
  @media (max-width: 640px) { .r { grid-template-columns: 52px 38px minmax(0, 1fr) minmax(0, 1.3fr) 24px; gap: var(--s-2); } .hide-sm { display: none; } .sum { margin-left: 0; width: 100%; } }
</style>
