<script lang="ts">
  // Who holds the supply, drawn: one tile per wallet, as large as its share of the total supply, the ten largest holders always
  // among them. The creator is the dark tile, a pool vault (never paid) is dashed, everyone beyond the list is one plain tile.
  // A wallet tile opens the wallet as a layer. The picture is the holder list the pad serves, read now; it keeps no history.
  import { api } from '../lib/api'
  import type { Coin, Holders } from '../lib/types'
  import { squarify } from '../lib/treemap'
  import { layers, walletKey } from '../lib/layers.svelte'
  import { wallet } from '../lib/wallet.svelte'
  import { short, ago } from '../lib/format'

  const { coin, now }: { coin: Coin; now: number } = $props()
  const W = 640, H = 300
  let view = $state<Holders | null | undefined>(undefined)
  $effect(() => {
    const m = coin.mint
    view = undefined
    api.holders(m, { limit: 100 }).then((h) => (view = h), () => (view = null))
  })

  type Tn = { kind: 'holder' | 'pool' | 'rest'; wallet: string; label: string; pct: number; dev: boolean }
  const entries = $derived.by(() => {
    if (!view) return []
    const rows: Tn[] = view.holders.map((h) => ({ kind: h.tags.includes('pool') ? 'pool' : 'holder', wallet: h.wallet, label: h.label ?? short(h.wallet, 4, 4), pct: h.pct, dev: h.tags.includes('dev') }))
    const sum = rows.reduce((a, r) => a + r.pct, 0)
    if (sum < 99.95) rows.push({ kind: 'rest', wallet: '', label: 'Everyone else', pct: 100 - sum, dev: false })
    return rows.map((r) => ({ item: r, value: r.pct }))
  })
  const tiles = $derived(squarify(entries, W, H))
  const top = $derived(Math.max(1, ...tiles.filter((t) => t.item.kind === 'holder').map((t) => t.item.pct)))
  const fill = (t: Tn) => (t.kind === 'rest' ? 'var(--paper-3)' : t.kind === 'pool' ? 'var(--paper-2)' : t.dev ? 'var(--ink)' : `color-mix(in srgb, var(--ink) ${Math.round(10 + 42 * (t.pct / top))}%, var(--paper-2))`)
  const pct = (p: number) => `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`
  const pick = (t: Tn) => { if (t.kind === 'holder') layers.open({ kind: 'wallet', key: walletKey(t.wallet, coin.mint), title: short(t.wallet, 4, 4) }) }
</script>

<div class="hm">
  {#if view === undefined}
    <div class="skel" style="height: 240px" aria-busy="true" role="status" aria-label="Loading the holders"></div>
  {:else if view === null || tiles.length === 0}
    <p class="muted">The holder list is not available on this pad's engine yet.</p>
  {:else}
    <svg viewBox="0 0 {W} {H}" role="img" aria-label="Treemap of who holds {coin.symbol}: each tile is a wallet's share of the total supply">
      <!-- declared inside the svg so its elements are drawn as svg, not as html -->
      {#snippet body(t: { item: Tn; x: number; y: number; w: number; h: number })}
        {@const d = t.item}
        <title>{d.label}: {pct(d.pct)} of the supply{d.dev ? ', the creator' : ''}{d.kind === 'pool' ? ', a pool vault, never paid' : ''}</title>
        <rect x={t.x + 1} y={t.y + 1} width={Math.max(0, t.w - 2)} height={Math.max(0, t.h - 2)} rx="3" style:fill={fill(d)} style:stroke={d.kind === 'pool' ? 'var(--ink-3)' : wallet.address === d.wallet ? 'var(--ink)' : 'var(--line)'} style:stroke-width={wallet.address === d.wallet ? 2.5 : 1} style:stroke-dasharray={d.kind === 'pool' ? '4 3' : undefined} />
        {#if t.w > 54 && t.h > 30}
          <text x={t.x + 8} y={t.y + 18} class="tl" style:fill={d.dev ? 'var(--paper)' : 'var(--ink)'}>{d.label}</text>
          <text x={t.x + 8} y={t.y + 33} class="tp" style:fill={d.dev ? 'var(--paper)' : 'var(--ink-2)'}>{pct(d.pct)}{d.dev ? ' creator' : ''}{wallet.address === d.wallet ? ' you' : ''}</text>
        {/if}
      {/snippet}
      {#each tiles as t (t.item.wallet || 'rest')}
        {@const d = t.item}
        {#if d.kind === 'holder'}
          <g class="tile pick" onclick={() => pick(d)} onkeydown={(e) => { if (e.key === 'Enter') pick(d) }} role="button" tabindex="0" aria-label="{d.label}, {pct(d.pct)} of supply">{@render body(t)}</g>
        {:else}
          <g class="tile">{@render body(t)}</g>
        {/if}
      {/each}
    </svg>
    <p class="hnote muted">Each tile is a wallet's share of the total supply, the {view.holders.length} largest listed. The dark tile is the creator, dashed tiles are Meteora pool vaults (never paid), the pale tile is everyone beyond the list. Read {ago(view.asOf, now)} from {view.source === 'keeper_sample' ? 'the keeper\'s sample' : 'the chain'}; there is no history behind it, so it shows today's split, not how it changed.</p>
  {/if}
</div>


<style>
  .hm { display: grid; gap: var(--s-2); min-width: 0; }
  svg { width: 100%; height: auto; max-height: 360px; border-radius: var(--r-sm); background: var(--paper-2); box-shadow: var(--sh-1); }
  .tile { outline: none; }
  .tile.pick { cursor: pointer; }
  @media (hover: hover) { .tile.pick:hover rect { stroke: var(--ink); stroke-width: 2; } }
  .tile:focus-visible rect { stroke: var(--pink); stroke-width: 3; }
  .tl { font: 700 11px var(--f-mono, ui-monospace, monospace); pointer-events: none; }
  .tp { font: 400 10px var(--f-mono, ui-monospace, monospace); pointer-events: none; }
  .hnote { font-size: var(--t-12); margin: 0; max-width: 90ch; }
</style>
