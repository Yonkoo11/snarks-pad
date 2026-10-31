<script lang="ts">
  // A coin's dossier as a sheet: the headline numbers, the ten-second strip and three tabs (trades, holders, rewards), opened
  // over the page you were on, so the ledger keeps its place and the coin page keeps its chart. It reads the same endpoints
  // the coin page does and says where each came from in the line at the foot.
  import { api, onMode, routeAbsent } from '../../lib/api'
  import type { CoinDetail, Epoch, PadMode, Pot, Treasury } from '../../lib/types'
  import { layers, dossierMint, dossierTab, dossierKey, type DossierTab } from '../../lib/layers.svelte'
  import { pricePerMillion, zec, ago, feeChip } from '../../lib/format'
  import { zecUsd } from '../../lib/usd.svelte'
  import { poll } from '../../lib/poll'
  import { router } from '../../lib/router.svelte'
  import { compare } from '../../lib/compare.svelte'
  import { leaveSpot } from '../../lib/spot'
  import CoinImage from '../CoinImage.svelte'
  import LiveNumber from '../LiveNumber.svelte'
  import DecisionStrip from '../DecisionStrip.svelte'
  import ChainTrades from '../ChainTrades.svelte'
  import HoldersTable from '../HoldersTable.svelte'
  import CoinRewards from '../CoinRewards.svelte'

  const { layerKey }: { layerKey: string } = $props()
  const mint = $derived(dossierMint(layerKey))
  // svelte-ignore state_referenced_locally
  let tab = $state<DossierTab>(dossierTab(layerKey))
  // the layer's key as this sheet last wrote it (a tab change rekeys the layer)
  // svelte-ignore state_referenced_locally
  let key = layerKey
  const TABS: { id: DossierTab; label: string }[] = [{ id: 'trades', label: 'Trades' }, { id: 'holders', label: 'Holders' }, { id: 'rewards', label: 'Rewards' }]
  // opened over this same coin's page the crumb says which tab ("Coins / $SNRK / Holders"); opened from elsewhere it names the coin
  const overOwnPage = $derived(router.route.name === 'coin' && router.route.mint === mint)
  const label = (t: DossierTab) => TABS.find((x) => x.id === t)!.label
  function pick(t: DossierTab) {
    tab = t
    const next = dossierKey(mint, t)
    layers.rekey(key, next); key = next
    layers.retitle(key, overOwnPage ? label(t) : coin ? `$${coin.symbol}` : 'Coin')
  }

  let coin = $state<CoinDetail | null>(null)
  let err = $state(false)
  let pot = $state<Pot | null | undefined>(undefined)
  let epochs = $state<Epoch[] | null>(null)
  let treasury = $state<Treasury | null>(null)
  let mode = $state<PadMode | null>(null)
  let now = $state(Date.now())
  let readAt = $state<number | null>(null)
  $effect(() => onMode((m) => (mode = m)))
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })
  $effect(() => { zecUsd.refresh() })
  async function load() {
    try { coin = await api.coin(mint); err = false; readAt = Date.now(); layers.retitle(key, overOwnPage ? label(tab) : `$${coin.symbol}`) }
    catch { if (!coin) err = true }
  }
  async function loadSide() {
    const [e, t, p] = await Promise.all([api.epochs().catch(() => null), api.treasury().catch(() => null), api.pot(mint).then((v) => v, (x) => (routeAbsent(x) ? null : pot ?? null))])
    epochs = e ? e.epochs : null; treasury = t; pot = p
  }
  $effect(() => poll(load, 6_000))
  $effect(() => poll(loadSide, 10_000))

  const pinned = $derived(compare.has(mint))
</script>

{#if err}
  <p class="error" role="alert">Could not load this coin.</p>
  <button class="btn" type="button" onclick={load}>Try again</button>
{:else if !coin}
  <div class="skel" style="height: 120px" aria-busy="true" role="status" aria-label="Loading the coin"></div>
  <div class="skel" style="height: 220px"></div>
{:else}
  <div class="top">
    <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={64} />
    <div class="who">
      <h2 class="display name">{coin.name}</h2>
      <p class="muted sub"><span class="mono">${coin.symbol}</span>, created {ago(coin.createdAt)}, <span>{feeChip(coin)}</span></p>
    </div>
    <div class="acts">
      <a class="btn" href="#/coin/{mint}" onclick={() => leaveSpot(mint)}>Open the full page</a>
      <button class="btn ghost" type="button" aria-pressed={pinned} onclick={() => compare.toggle(mint)}>{pinned ? 'Unpin from compare' : 'Pin to compare'}</button>
    </div>
  </div>

  <dl class="nums">
    <div><dt class="label">Price per 1M</dt>{#if coin.priceZec === undefined}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={Number(coin.priceZec)} format={(v) => `${pricePerMillion(String(v))} ZEC`} /></dd>{/if}</div>
    <div><dt class="label">Market cap</dt>{#if coin.marketCapZec === undefined}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={Number(coin.marketCapZec)} format={(v) => `${zec(BigInt(Math.round(v)), 2)} ZEC`} /></dd>{/if}</div>
    <div><dt class="label">24h volume</dt><dd class="mono">{coin.volume24hZats === undefined ? '–' : `${zec(coin.volume24hZats, 2)} ZEC`}</dd></div>
    <div><dt class="label">Holders</dt><dd class="mono">{coin.holders === null ? '–' : coin.holders.toLocaleString('en-US')}</dd></div>
  </dl>

  <DecisionStrip {coin} {pot} {now} />

  <div class="seg tabs" role="tablist" aria-label="Coin details">
    {#each TABS as t (t.id)}
      <button type="button" role="tab" id="dt-{t.id}" aria-selected={tab === t.id} aria-controls="dp-{t.id}" class:on={tab === t.id} onclick={() => pick(t.id)}>{t.label}{#if t.id === 'holders' && coin.holders}<span class="cnt mono">{coin.holders.toLocaleString('en-US')}</span>{/if}</button>
    {/each}
  </div>
  <div role="tabpanel" id="dp-{tab}" aria-labelledby="dt-{tab}" class="panel-body">
    {#if tab === 'trades'}
      <ChainTrades {coin} {mode} {now} />
    {:else if tab === 'holders'}
      <HoldersTable {mint} {coin} {mode} {now} />
    {:else}
      <CoinRewards {coin} {pot} {epochs} {treasury} {mode} {now} rate={zecUsd.rate} />
    {/if}
  </div>

  <p class="foot muted">Read from the pad's own API {readAt ? ago(new Date(readAt).toISOString(), now) : '–'}. Trades show the last 25 the engine keeps; holders and the round are read on their own clocks and say so above.</p>
{/if}

<style>
  .top { display: flex; gap: var(--s-4); align-items: center; flex-wrap: wrap; }
  .who { min-width: 0; flex: 1 1 200px; }
  .name { font-size: clamp(26px, 5vw, 34px); overflow-wrap: anywhere; }
  .sub { font-size: var(--t-14); }
  .acts { display: flex; gap: var(--s-2); flex-wrap: wrap; width: 100%; }
  .acts .btn { min-height: 44px; font-size: var(--t-14); }
  .nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--s-4); margin: 0; }
  .nums dd { margin: var(--s-1) 0 0; font-size: var(--t-16); font-weight: 500; }
  .tabs { width: max-content; max-width: 100%; }
  .tabs > button { display: inline-flex; align-items: center; gap: var(--s-2); }
  .cnt { font-size: var(--t-12); font-weight: 500; color: var(--ink-2); }
  .panel-body { min-height: 160px; }
  .foot { font-size: var(--t-12); }
</style>
