<script lang="ts">
  import type { FeedTrade, PadMode } from '../lib/types'
  import { zec, tokens, short, ago } from '../lib/format'
  import { tradeFeed, type FeedState } from '../lib/tape'
  import { wallet } from '../lib/wallet.svelte'
  import { solanaTxUrl } from '../lib/explorer'

  // The trades tape: the pad's newest trades (Home, `compact`, every row a link to its coin) or one coin's (the Trades tab).
  // Rows come from the live feed (SSE, else a poll); on an engine without /trades the coin page passes the coin's own
  // recentTrades as `fallback`. A wallet is tagged "dev" when it is the coin's creator and "you" when it is the one connected.
  // A row that arrives after the first paint slides in once; rows already on screen stay put.
  let { mint, creators = {}, fallback = null, fallbackNote = null, limit = 10, everyMs = 6_000, compact = false, mode, now, onstate }: {
    mint?: string; creators?: Record<string, string>; fallback?: FeedTrade[] | null; fallbackNote?: string | null; limit?: number; everyMs?: number; compact?: boolean; mode: PadMode | null; now: number
    onstate?: (s: FeedState) => void // the parent can hide the whole block on an engine without the route
  } = $props()

  let rows = $state<FeedTrade[]>([])
  let feed = $state<FeedState>('loading')
  let lastRead = $state<number | null>(null)
  let known = new Set<string>()
  let fresh = $state(new Set<string>())
  let primed = false

  $effect(() => tradeFeed({
    mint, limit, everyMs,
    onRows: (r) => {
      if (primed) {
        const f = new Set(fresh)
        for (const t of r) if (!known.has(t.sig)) f.add(t.sig)
        fresh = f
      }
      known = new Set(r.map((t) => t.sig)); primed = true
      rows = r; lastRead = Date.now()
    },
    onState: (s) => { feed = s; onstate?.(s) },
  }))

  const shown = $derived(feed === 'absent' ? (fallback ?? []).slice(0, limit) : rows)
  // "dev" from the engine's own tag (or the creator the page knows, for the fallback rows); "you" is the web's
  const tag = (t: FeedTrade): string | null => (t.tags?.includes('dev') || creators[t.mint] === t.wallet ? 'dev' : wallet.address === t.wallet ? 'you' : null)
</script>

<div class="tape" class:compact>
  {#if feed === 'lost'}<p class="live error">Lost the connection to the pad. Trying again every {everyMs / 1000}s.</p>
  {:else if feed === 'absent' && fallbackNote}<p class="live muted" aria-live="off">{fallbackNote}</p>{/if}

  {#if feed === 'loading'}
    <div class="skel sk" aria-busy="true" aria-label="Loading the trades"></div>
  {:else if shown.length === 0}
    <p class="muted">{mint ? 'No trades yet. The first buy starts the curve.' : 'No trades yet.'}</p>
  {:else}
    <div class="rows">
      {#each shown as t (t.sig)}
        {#if compact}
          <a class="row" class:new={fresh.has(t.sig)} href="#/coin/{t.mint}" title="{t.side} of {t.symbol} by {t.wallet}">
            <span class="side caps {t.side}">{t.side}</span>
            <span class="mono sym">${t.symbol}</span>
            <span class="mono amt">{zec(t.amountZec)} ZEC{#if tag(t)}<span class="tg">{tag(t)}</span>{/if}</span>
            <span class="muted when">{ago(t.at, now)}</span>
          </a>
        {:else}
          <div class="row" class:new={fresh.has(t.sig)}>
            <span class="side caps {t.side}">{t.side}</span>
            <span class="mono amt">{zec(t.amountZec)} ZEC</span>
            <span class="mono muted hide-sm">{tokens(t.amountToken)} {t.symbol}</span>
            <span class="mono muted who">{short(t.wallet)}{#if tag(t)}<span class="tg">{tag(t)}</span>{/if}</span>
            <span class="muted when">{ago(t.at, now)}</span>
            {#if solanaTxUrl(t.sig, mode)}<a class="tx" href={solanaTxUrl(t.sig, mode)} target="_blank" rel="noreferrer" aria-label="This trade on the Solana explorer" title={t.sig}>↗</a>{:else}<span class="tx muted" title={t.sig} aria-hidden="true"></span>{/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .tape { display: grid; gap: var(--s-2); }
  .live { font-size: var(--t-14); }
  .sk { height: 160px; }
  .compact .sk { height: 136px; }
  .rows { display: grid; }
  .row {
    display: grid; grid-template-columns: 48px 1fr 1fr 1fr auto 44px; gap: var(--s-3); align-items: center;
    padding: var(--s-2) 0; border-bottom: 1px solid var(--line); font-size: var(--t-14); color: inherit; text-decoration: none;
  }
  /* the home tape is 320px wide: side, coin, amount (with a dev or you tag), age; the wallet itself is on the coin page. Each row is a 44px link. */
  .compact .row { grid-template-columns: 40px auto 1fr auto; gap: var(--s-2); min-height: 44px; padding: 4px 0; }
  .compact .sym, .compact .amt, .compact .when { white-space: nowrap; }
  .compact .amt { display: inline-flex; gap: var(--s-1); align-items: center; }
  /* a trade that arrived after the page loaded slides in once; the rows already on screen do not move */
  .row.new { animation: trow-in var(--d-row) var(--ease) 1; }
  @keyframes trow-in { from { opacity: 0; transform: translateY(-8px); } }
  .side { font-weight: 700; font-size: var(--t-12); letter-spacing: .06em; }
  .side.sell { color: var(--ink-3); }
  .sym { font-weight: 500; }
  .who { display: inline-flex; gap: var(--s-1); align-items: center; }
  .tg { font-family: var(--f-body); font-size: var(--t-12); font-weight: 700; color: var(--ink); background: var(--paper-3); border-radius: var(--r-full); padding: 0 6px; }
  .when { text-align: right; white-space: nowrap; }
  /* a 44px square target on the row's own height */
  .tx { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; margin: -12px 0; color: var(--ink-2); text-decoration: none; border-radius: var(--r-xs); }
  @media (hover: hover) { .compact .row:hover { background: var(--paper-2); } a.tx:hover { color: var(--ink); } }
  /* on a phone a coin-page row takes two lines: side, amount and age on the first, the wallet with its tag on the second; the link spans both */
  @media (max-width: 640px) {
    .tape:not(.compact) .row { grid-template-columns: 40px 1fr auto 44px; grid-template-areas: 'side amt when tx' 'side who who tx'; row-gap: 2px; }
    .tape:not(.compact) .side { grid-area: side; }
    .tape:not(.compact) .amt { grid-area: amt; white-space: nowrap; }
    .tape:not(.compact) .who { grid-area: who; }
    .tape:not(.compact) .when { grid-area: when; }
    .tape:not(.compact) .tx { grid-area: tx; }
    .hide-sm { display: none; }
  }
</style>
