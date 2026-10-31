<script lang="ts">
  // The compare shelf opened: up to three pinned coins side by side, one column each, every cell the number the ledger row
  // already shows (a dash where it is not known, never a zero), with their trade lines either apart or laid over each other.
  import { untrack } from 'svelte'
  import { api } from '../../lib/api'
  import type { CoinDetail } from '../../lib/types'
  import { rowExtras, type RowExtras } from '../../lib/desk'
  import { compare } from '../../lib/compare.svelte'
  import { layers, dossierKey } from '../../lib/layers.svelte'
  import { zec, pricePerMillion, ago } from '../../lib/format'
  import CoinImage from '../CoinImage.svelte'
  import ConcRule from '../ConcRule.svelte'
  import Spark from '../Spark.svelte'
  import Onion from '../Onion.svelte'

  type Col = { mint: string; coin: CoinDetail | null; ex: RowExtras | null; failed: boolean }
  let cols = $state<Col[]>([])
  let mode = $state<'apart' | 'over'>('apart')
  let now = $state(Date.now())
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })

  // one column per pinned mint; a column keeps what it has already read when the shelf changes
  // reads only the shelf; the columns it writes are not something it depends on
  $effect(() => {
    const pins = [...compare.pins]
    let live = true
    untrack(() => {
      cols = pins.map((m) => cols.find((c) => c.mint === m) ?? { mint: m, coin: null, ex: null, failed: false })
      for (const m of pins) {
        if (cols.find((c) => c.mint === m)?.coin) continue
        Promise.all([api.coin(m).catch(() => null), rowExtras(m)]).then(([coin, ex]) => {
          if (!live) return
          cols = cols.map((c) => (c.mint === m ? { mint: m, coin, ex, failed: coin === null } : c))
        })
      }
    })
    return () => { live = false }
  })

  const perHolder = (c: Col) => (c.ex && c.ex.holdersPotZats != null && c.ex.holdersCount ? BigInt(c.ex.holdersPotZats) / BigInt(c.ex.holdersCount) : null)
  const paid = (c: Col) => (c.coin ? BigInt(c.coin.rewards.paidSolanaZec || '0') + BigInt(c.coin.rewards.paidShieldedZec || '0') : 0n)
  const chg = (c: Col) => c.coin?.priceChange24hBps ?? null
  const skins = $derived(cols.map((c) => ({ label: c.coin ? `$${c.coin.symbol}` : '…', trades: c.ex?.trades ?? null })))
  const rows: { label: string; cell: (c: Col) => string }[] = [
    { label: 'Price per 1M, ZEC', cell: (c) => (c.coin?.priceZec === undefined || !c.coin ? '–' : pricePerMillion(c.coin.priceZec)) },
    { label: '24h change', cell: (c) => (chg(c) === null ? '–' : `${chg(c)! > 0 ? '+' : ''}${(chg(c)! / 100).toFixed(1)}%`) },
    { label: 'Market cap, ZEC', cell: (c) => (!c.coin || c.coin.marketCapZec === undefined ? '–' : zec(c.coin.marketCapZec, 2)) },
    { label: '24h volume, ZEC', cell: (c) => (!c.coin || c.coin.volume24hZats === undefined ? '–' : zec(c.coin.volume24hZats, 2)) },
    { label: 'Holders', cell: (c) => (c.coin?.holders == null ? '–' : c.coin.holders.toLocaleString('en-US')) },
    { label: 'Curve', cell: (c) => (c.coin?.curveProgress == null ? '–' : `${Math.round(c.coin.curveProgress * 100)}%`) },
    { label: 'Paid to holders, ZEC', cell: (c) => (paid(c) > 0n ? `${zec(paid(c), 2)}  n=${c.coin!.rewards.epochs}` : '–') },
    { label: 'Next round, per holder', cell: (c) => (perHolder(c) === null ? '–' : `${zec(perHolder(c)!, 6)} ZEC`) },
    { label: 'Age', cell: (c) => (c.coin ? ago(c.coin.createdAt, now) : '–') },
  ]
  const wide = $derived(cols.length)
</script>

{#if cols.length === 0}
  <div class="empty">
    <p>Nothing pinned yet.</p>
    <p class="muted">Pin a coin from the ledger (the two-squares button on a row, or <kbd>p</kbd> on the row under the cursor) and it waits here. Up to three.</p>
  </div>
{:else}
  <div class="seg modes" role="group" aria-label="How the trade lines are drawn">
    <button type="button" aria-pressed={mode === 'apart'} onclick={() => (mode = 'apart')}>Side by side</button>
    <button type="button" aria-pressed={mode === 'over'} onclick={() => (mode = 'over')} disabled={cols.length < 2}>Onionskin</button>
  </div>

  <div class="cmp" style:--n={wide} role="table" aria-label="Pinned coins, compared">
    <div class="crow chead" role="row">
      <span class="lab" role="columnheader"></span>
      {#each cols as c (c.mint)}
        <span class="ch" role="columnheader">
          <button type="button" class="who" onclick={() => layers.open({ kind: 'dossier', key: dossierKey(c.mint), title: c.coin ? `$${c.coin.symbol}` : 'Coin' })} title="Open this coin's sheet">
            {#if c.coin}<CoinImage src={c.coin.imageUrl} symbol={c.coin.symbol} size={28} />{/if}
            <span class="nm">{c.coin ? c.coin.name : c.failed ? 'Could not load' : 'Loading'}</span>
            {#if c.coin}<span class="mono muted">${c.coin.symbol}</span>{/if}
          </button>
          <button type="button" class="off" onclick={() => compare.toggle(c.mint)} aria-label="Take {c.coin?.name ?? 'this coin'} off the shelf">&times;</button>
        </span>
      {/each}
    </div>
    <div class="crow" role="row">
      <span class="lab" role="rowheader">Supply</span>
      {#each cols as c (c.mint)}<span class="cell" role="cell">{#if c.ex}<ConcRule top10={c.ex.top10Pct} dev={c.ex.devPct} pool={c.ex.poolPct} w={88} />{:else}<span class="mono">–</span>{/if}</span>{/each}
    </div>
    {#each rows as r (r.label)}
      <div class="crow" role="row">
        <span class="lab" role="rowheader">{r.label}</span>
        {#each cols as c (c.mint)}<span class="cell mono" role="cell">{r.cell(c)}</span>{/each}
      </div>
    {/each}
    {#if mode === 'apart'}
      <div class="crow" role="row">
        <span class="lab" role="rowheader">Trade line</span>
        {#each cols as c (c.mint)}<span class="cell" role="cell">{#if c.ex?.trades}<Spark trades={c.ex.trades} w={wide === 3 ? 120 : 160} h={38} />{:else}<span class="mono">–</span>{/if}</span>{/each}
      </div>
    {/if}
  </div>

  {#if mode === 'over'}
    <Onion {skins} w={Math.min(560, 520)} />
  {/if}
  <p class="foot muted">Every figure is the one the ledger row shows, read from the pad's API. A dash is a figure the pad has not served for that coin, never a zero. Pins live in this browser only.</p>
  <button class="btn ghost clr" type="button" onclick={() => compare.clear()}>Clear the shelf</button>
{/if}

<style>
  .empty { display: grid; gap: var(--s-2); }
  .empty kbd { font-family: var(--f-mono); font-size: var(--t-11); border: 1px solid var(--line); border-radius: var(--r-xs); padding: 0 4px; }
  .modes { width: max-content; max-width: 100%; }
  .cmp { display: grid; font-size: var(--t-14); }
  .crow { display: grid; grid-template-columns: minmax(96px, .9fr) repeat(var(--n), minmax(0, 1fr)); gap: var(--s-3); align-items: center; padding: var(--s-2) 0; border-bottom: 1px solid var(--line); }
  .chead { align-items: end; }
  .lab { font-size: var(--t-11); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); font-weight: 700; }
  .cell { font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
  .ch { display: flex; align-items: center; gap: var(--s-1); min-width: 0; }
  .who { display: grid; justify-items: start; gap: 2px; min-width: 0; border: 0; background: none; font: inherit; color: inherit; padding: 4px; margin: -4px; border-radius: var(--r-sm); cursor: pointer; text-align: left; }
  @media (hover: hover) { .who:hover { background: var(--hover); } }
  .nm { font-weight: 700; font-size: var(--t-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .off { margin-left: auto; border: 0; background: none; font-size: 18px; line-height: 1; color: var(--ink-3); cursor: pointer; min-width: 28px; min-height: 28px; border-radius: var(--r-xs); }
  @media (hover: hover) { .off:hover { color: var(--ink); background: var(--hover); } }
  .foot { font-size: var(--t-12); }
  .clr { min-height: 44px; width: max-content; }
  @media (max-width: 640px) { .crow { grid-template-columns: minmax(72px, .8fr) repeat(var(--n), minmax(0, 1fr)); gap: var(--s-2); font-size: var(--t-12); } }
</style>
