<script lang="ts">
  import { api, routeAbsent } from '../lib/api'
  import type { Coin, Holders, PadMode } from '../lib/types'
  import { ago } from '../lib/format'
  import { wallet } from '../lib/wallet.svelte'
  import { solanaAccountUrl } from '../lib/explorer'
  import Addr from './Addr.svelte'

  // The Holders tab (contract v2.6 GET /coins/:mint/holders): the largest wallets with their share of the total supply, the pool
  // vaults listed so the shares add up and marked as never paid, the creator tagged, the connected wallet "you". Since v2.9 nothing
  // here says which holders opted in to shielded delivery, or how many: that is private, and the engine no longer sends it.
  let { mint, coin, mode, now }: { mint: string; coin: Coin; mode: PadMode | null; now: number } = $props()
  let view = $state<Holders | null | undefined>(undefined) // undefined loading, null = this engine has no holder list
  let err = $state(false)
  async function load() {
    err = false
    try { view = await api.holders(mint) }
    catch (e) { if (routeAbsent(e)) view = null; else err = true }
  }
  $effect(() => { view = undefined; load() })

  const pct = (p: number) => `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`
  const n = (v: number) => v.toLocaleString('en-US')
  const count = $derived(coin.holders === undefined || coin.holders === null ? null : n(coin.holders))
</script>

<div class="holders">
  {#if err}
    <div class="state"><p class="error">Could not load the holders.</p><button class="btn" type="button" onclick={load}>Try again</button></div>
  {:else if view === undefined}
    <div class="skel sk" aria-busy="true" aria-label="Loading the holders"></div>
  {:else if view === null}
    <p class="muted">{count ?? '–'} holders. The holder list is not available on this pad's engine yet.</p>
  {:else}
    <p class="sum">
      <span class="mono">{n(view.holdersCount)}</span> {view.holdersCount === 1 ? 'holder' : 'holders'}. Top 10 hold <span class="mono">{pct(view.top10Pct)}</span> of the supply{#if view.devPct > 0}, the creator <span class="mono">{pct(view.devPct)}</span>{/if}{#if view.poolPct !== null}, the pool <span class="mono">{pct(view.poolPct)}</span>{/if}.
      <span class="muted"> {view.source === 'keeper_sample' ? 'From the keeper\'s sample' : 'Read on chain'} {ago(view.asOf, now)}.</span>
    </p>
    <div class="table" role="table" aria-label="Holders">
      <div class="hrow head" role="row"><span role="columnheader" class="label">#</span><span role="columnheader" class="label">Holder</span><span role="columnheader" class="label num">Share</span></div>
      {#each view.holders as h (h.wallet)}
        {@const pool = h.tags.includes('pool')}
        <div class="hrow" role="row" class:pool>
          <span role="cell" class="mono rk">{h.rank}</span>
          <span role="cell" class="who">
            <Addr value={h.wallet} head={4} tail={4} href={solanaAccountUrl(h.wallet, mode)} label={pool ? 'pool vault address' : 'wallet address'} />
            {#if pool}<span class="tg">pool, not paid</span>{#if h.label}<span class="muted small">{h.label}</span>{/if}{/if}
            {#if h.tags.includes('dev')}<span class="tg">dev</span>{/if}
            {#if wallet.address === h.wallet}<span class="tg">you</span>{/if}
          </span>
          <span role="cell" class="mono num">{pct(h.pct)}</span>
        </div>
      {/each}
    </div>
    <p class="note muted">Shares are of the total supply. A pool row is a Meteora vault, not a person: it holds what the curve has not sold (or the graduated pool's side) and is never paid. Which wallets get shielded rewards is not shown on any page.{#if view.total > view.holders.length}{' '}Showing the largest {view.holders.length} of {n(view.total)} rows.{/if}</p>
  {/if}
</div>

<style>
  .holders { display: grid; gap: var(--s-3); }
  .sum { font-size: var(--t-16); }
  .sum .mono { color: var(--ink); }
  .sk { height: 320px; }
  .state { display: grid; gap: var(--s-3); justify-items: start; }
  .table { display: grid; }
  .hrow { display: grid; grid-template-columns: 44px minmax(0, 1fr) 90px; gap: var(--s-3); align-items: center; padding: var(--s-2) 0; border-bottom: 1px solid var(--line); font-size: var(--t-14); }
  .hrow.head { padding-bottom: var(--s-1); }
  .hrow.pool { color: var(--ink-2); }
  .rk { color: var(--ink-2); }
  .who { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1) var(--s-2); min-width: 0; }
  .tg { font-size: var(--t-12); font-weight: 700; color: var(--ink); background: var(--paper-3); border-radius: var(--r-full); padding: 0 6px; white-space: nowrap; }
  .small { font-size: var(--t-12); }
  .num { text-align: right; }
  .note { font-size: var(--t-14); max-width: 66ch; }
  @media (max-width: 640px) { .hrow { grid-template-columns: 40px minmax(0, 1fr) 72px; } }
</style>
