<script lang="ts">
  // The tape that outlives the page: a docked column on a wide screen, one line above the bottom bar on a narrow one. It is
  // mounted once at the root, so a route change never unmounts it and the stream never restarts. Clicking a trade opens that
  // coin's dossier as a layer instead of leaving the page. Key t folds it away; this browser remembers.
  import { layers, dossierKey } from '../../lib/layers.svelte'
  import { tradeFeed } from '../../lib/tape'
  import { zec, ago } from '../../lib/format'
  import type { FeedTrade } from '../../lib/types'
  import TapeList from './TapeList.svelte'

  const KEY = 'snarks-rail'
  // open from the start only where there is room for it; a choice made with the t key wins from then on
  let open = $state((() => { try { const v = localStorage.getItem(KEY); return v === null ? innerWidth >= 1500 : v !== '0' } catch { return innerWidth >= 1500 } })())
  let now = $state(Date.now())
  let last = $state<FeedTrade | null>(null)
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })
  // the one-line ticker only needs the newest trade
  $effect(() => tradeFeed({ limit: 1, everyMs: 8000, onRows: (r) => (last = r[0] ?? null), onState: () => {} }))
  function set(v: boolean) { open = v; try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* private window */ } }
  $effect(() => { document.body.dataset.rail = open ? 'on' : 'off' })
  $effect(() => { document.body.dataset.ticker = last ? 'on' : 'off' })
  $effect(() => {
    const onT = (e: KeyboardEvent) => {
      if (e.key !== 't' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const el = e.target
      if (el instanceof HTMLElement && el.closest('input, select, textarea, [contenteditable]')) return
      set(!open)
    }
    addEventListener('keydown', onT)
    return () => removeEventListener('keydown', onT)
  })
  const pick = (mint: string, symbol: string) => layers.open({ kind: 'dossier', key: dossierKey(mint), title: `$${symbol}` })
</script>

{#if open}
  <aside class="rail" aria-label="Live tape">
    <header><h2 class="label">The pulse</h2><button type="button" class="fold" onclick={() => set(false)} aria-label="Fold the tape away" title="Fold away (key t)">&rsaquo;</button></header>
    <div class="body"><TapeList limit={80} {now} onpick={pick} /></div>
    <p class="muted foot">Trades, launches, graduations and payout rounds, newest first. Click a coin to open it without leaving this page.</p>
  </aside>
{:else}
  <button class="tab" type="button" onclick={() => set(true)} title="Open the live tape (key t)"><span>Tape</span></button>
{/if}

{#if last}
  <button class="ticker" type="button" onclick={() => layers.open({ kind: 'tape', key: 'tape', title: 'Live tape' })} aria-label="Open the live tape">
    <span class="side caps {last.side}">{last.side}</span> <span class="mono">${last.symbol}</span> <span class="mono">{zec(last.amountZec)} ZEC</span> <span class="muted">{ago(last.at, now)}</span>
    <span class="more" aria-hidden="true">Tape &rsaquo;</span>
  </button>
{/if}

<style>
  .rail, .tab { display: none; }
  .ticker {
    position: fixed; z-index: 29; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: var(--s-2); min-height: 40px; padding: 0 var(--s-4);
    border: 0; border-top: 1.5px solid var(--line); background: var(--paper-2); color: inherit; font: inherit; font-size: var(--t-12); cursor: pointer; text-align: left;
  }
  .ticker .side { font-weight: 700; font-size: var(--t-11); letter-spacing: .06em; }
  .ticker .side.sell { color: var(--ink-3); }
  .more { margin-left: auto; font-weight: 700; }
  @media (max-width: 1359px) { :global(body[data-ticker='on']) :global(#app) { margin-bottom: 40px; } }
  @media (max-width: 640px) { .ticker { bottom: calc(56px + env(safe-area-inset-bottom, 0px)); } }
  @media (min-width: 1360px) {
    .ticker { display: none; }
    .rail {
      display: grid; grid-template-rows: auto minmax(0, 1fr) auto; position: fixed; z-index: 20; top: 0; bottom: 0; right: 0; width: 272px;
      background: var(--paper-2); border-left: 1.5px solid var(--line);
    }
    .rail header { display: flex; align-items: center; justify-content: space-between; padding: var(--s-3) var(--s-3) var(--s-3) var(--s-4); border-bottom: 1px solid var(--line); }
    .fold { border: 0; background: none; font-size: 22px; line-height: 1; width: 44px; height: 44px; margin: -8px 0; color: var(--ink-2); cursor: pointer; border-radius: var(--r-sm); }
    @media (hover: hover) { .fold:hover { background: var(--hover); color: var(--ink); } }
    .body { min-height: 0; }
    .foot { margin: 0; padding: var(--s-3) var(--s-4); font-size: var(--t-11); border-top: 1px solid var(--line); }
    .tab {
      display: block; position: fixed; z-index: 20; right: 0; top: 40%; border: 0; border-radius: var(--r-sm) 0 0 var(--r-sm); padding: var(--s-3) var(--s-2);
      background: var(--paper-2); color: var(--ink-2); box-shadow: var(--sh-2); font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer;
    }
    .tab span { writing-mode: vertical-rl; }
    :global(body[data-rail='on']) :global(#app) { padding-right: 272px; }
  }
</style>
