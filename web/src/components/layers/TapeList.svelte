<script lang="ts">
  // The pad's pulse as a list that never moves under your thumb: trades, new launches, graduations and payout rounds in one stream,
  // with chips to narrow it (big trades, dev sells, the coins you follow, your own wallet). While the pointer rests on it, focus is
  // inside it, it is scrolled down or Pause is on, new items are held behind a bar ("7 new") instead of pushing the rows; tapping the
  // bar merges them. The count is exact for the items the sources serve and says "+" when the stream is full. A trade's bar is its size
  // against the other trades on this tape. Hovering a trade draws a hairline on that coin's chart.
  import type { Coin, Epoch } from '../../lib/types'
  import { tradeFeed, type FeedState } from '../../lib/tape'
  import { api } from '../../lib/api'
  import { poll } from '../../lib/poll'
  import { zec, ago } from '../../lib/format'
  import { hilite } from '../../lib/hilite.svelte'
  import { wallet } from '../../lib/wallet.svelte'
  import { watched } from '../../lib/looked'
  import { FILTERS, bigAt, fromCoins, fromEpochs, fromTrades, matches, mergePulse, type PulseFilter, type PulseItem } from '../../lib/pulse'

  const { limit = 60, everyMs = 6000, onpick, now = Date.now() }: { limit?: number; everyMs?: number; onpick: (mint: string, symbol: string) => void; now?: number } = $props()

  let trades = $state<PulseItem[]>([])
  let coins = $state<Coin[]>([])
  let epochs = $state<Epoch[]>([])
  let feed = $state<FeedState>('loading')
  let filter = $state<PulseFilter>('all')
  let paused = $state(false)
  let hover = $state(false)
  let focused = $state(false)
  let scrolled = $state(false)
  let fresh = $state(new Set<string>())
  // raw: the list is replaced as a whole, never edited, and assigning a derived array to a proxied state would look like a change every time
  let shown = $state.raw<PulseItem[]>([])
  let box = $state<HTMLElement>()
  let following = $state<ReadonlySet<string>>(new Set())
  const frozen = $derived(paused || hover || focused || scrolled)

  $effect(() => tradeFeed({ limit: 40, everyMs, onRows: (r) => { trades = fromTrades(r) }, onState: (s) => (feed = s) }))
  $effect(() => poll(() => api.coins({ sort: 'new', limit: 40 }).then((r) => (coins = r.coins), () => {}), 30_000))
  $effect(() => poll(() => api.epochs().then((r) => (epochs = r.epochs), () => {}), 60_000))
  $effect(() => {
    const read = () => (following = new Set(Object.keys(watched())))
    read()
    addEventListener('snarks-watch', read)
    return () => removeEventListener('snarks-watch', read)
  })

  const live = $derived(mergePulse([trades, fromCoins(coins, Date.now()), fromEpochs(epochs)], limit))
  // the reader sees the live items unless something holds them still
  $effect(() => {
    if (frozen && shown.length > 0) return
    if (shown === live) return
    const before = new Set(shown.map((x) => x.id))
    const added = live.filter((x) => !before.has(x.id)).map((x) => x.id)
    if (shown.length > 0 && added.length) { fresh = new Set(added); setTimeout(() => (fresh = new Set()), 1400) }
    shown = live
  })
  const queued = $derived.by(() => {
    const seen = new Set(shown.map((x) => x.id))
    return live.filter((x) => !seen.has(x.id)).length
  })
  const big = $derived(bigAt(shown))
  const maxZec = $derived(Math.max(0, ...shown.flatMap((x) => (x.kind === 'trade' ? [x.zec] : []))))
  const ctx = $derived({ wallet: wallet.address, following, big })
  const view = $derived(shown.filter((x) => matches(x, filter, ctx)))
  function merge() { shown = live; hover = false; scrolled = false; paused = false; box?.scrollTo({ top: 0 }) }
  const lit = (x: PulseItem) => x.kind === 'trade' && hilite.chartMint === x.mint && hilite.chartAt !== null && Math.floor(x.at / 1000 / hilite.chartSec) * hilite.chartSec === hilite.chartAt
  const EMPTY = $derived<Record<PulseFilter, string>>({
    all: 'Nothing yet.', trades: 'No trades yet.', big: big === Infinity ? 'Big needs twenty trades on the tape to say what is big.' : 'No big trade on the tape right now.',
    dev: 'No creator has sold on this tape.', launches: 'No launch in the last two days.', grads: 'No graduation in the last two days.', rounds: 'No round yet.',
    mine: wallet.address ? 'None of your trades are on this tape.' : 'Connect a wallet to see your own trades.', following: following.size ? 'Nothing new from the coins you follow.' : 'Star a coin in the ledger and it shows up here.',
  })
</script>

<div class="tl">
  <div class="chips" role="group" aria-label="What the tape shows">
    {#each FILTERS as f (f.id)}<button type="button" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>{f.label}</button>{/each}
    <button type="button" class="pause" aria-pressed={paused} onclick={() => (paused = !paused)} title="Hold the tape still while you read">{paused ? 'Paused' : 'Pause'}</button>
  </div>
  {#if queued > 0 && frozen}
    <button class="ribbon" type="button" onclick={merge} aria-live="polite">{queued}{queued >= limit ? '+' : ''} new, held back. Show</button>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rows"
    bind:this={box}
    onpointerenter={(e) => { if (e.pointerType === 'mouse') hover = true }}
    onpointerleave={() => (hover = false)}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
    onscroll={(e) => (scrolled = (e.currentTarget as HTMLElement).scrollTop > 6)}
  >
    {#if feed === 'loading' && shown.length === 0}
      <div class="skel" style="height: 120px" aria-busy="true" role="status" aria-label="Loading the tape"></div>
    {:else if feed === 'lost' && shown.length === 0}
      <p class="muted pad">Lost the connection to the pad. Trying again.</p>
    {:else if view.length === 0}
      <p class="muted pad">{EMPTY[filter]}</p>
    {:else}
      {#each view as x (x.id)}
        {#if x.kind === 'round'}
          <a class="round" class:new={fresh.has(x.id)} href="#/payouts" title="Open the payouts page">
            <span class="perf" aria-hidden="true"></span>
            <span class="rt"><b class="caps">Round {x.n}</b> paid {x.paid} {x.paid === 1 ? 'wallet' : 'wallets'}, {zec(x.holdersZats, 4)} ZEC to holders</span>
            <span class="muted when">{ago(new Date(x.at).toISOString(), now)}</span>
          </a>
        {:else if x.kind === 'trade'}
          <button class="r" class:new={fresh.has(x.id)} class:lit={lit(x)} class:following={following.has(x.mint)} type="button" onclick={() => onpick(x.mint, x.symbol)} onpointerenter={() => { hilite.tradeAt = x.at / 1000; hilite.tradeMint = x.mint }} onpointerleave={() => { if (hilite.tradeMint === x.mint) hilite.tradeAt = null }} title="Open ${x.symbol}">
            <span class="side caps {x.side}">{x.side}</span>
            <span class="mono sym">${x.symbol}</span>
            <span class="mono amt"><i class="sz {x.side}" style:width="{maxZec ? Math.sqrt(x.zec / maxZec) * 100 : 0}%"></i><b>{zec(String(Math.round(x.zec * 1e8)))}</b>{#if x.dev}<span class="tg">dev</span>{/if}{#if x.zec >= big}<span class="tg bg">big</span>{/if}</span>
            <span class="muted when">{ago(new Date(x.at).toISOString(), now)}</span>
          </button>
        {:else}
          <button class="r ev" class:new={fresh.has(x.id)} type="button" onclick={() => onpick(x.mint, x.symbol)} title="Open ${x.symbol}">
            <span class="side caps ev">{x.kind === 'launch' ? 'new' : 'grad'}</span>
            <span class="evt"><b class="mono">${x.symbol}</b> {x.kind === 'launch' ? 'launched' : 'graduated to Meteora'}</span>
            <span class="muted when">{ago(new Date(x.at).toISOString(), now)}</span>
          </button>
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .tl { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-height: 0; height: 100%; position: relative; }
  .chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--line); }
  .chips button { flex: none; min-height: 28px; padding: 0 10px; border: 0; border-radius: var(--r-full); background: var(--paper-3); color: var(--ink-2); font: inherit; font-size: var(--t-11); font-weight: 700; cursor: pointer; }
  .chips button[aria-pressed='true'] { background: var(--ink); color: var(--paper); }
  .chips .pause { margin-left: auto; background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
  .chips .pause[aria-pressed='true'] { background: var(--ink); color: var(--paper); box-shadow: none; }
  .rows { overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
  .ribbon {
    position: sticky; top: 0; z-index: 2; width: 100%; min-height: 36px; border: 0; background: var(--ink); color: var(--paper);
    font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer;
  }
  .pad { padding: var(--s-3); font-size: var(--t-12); }
  .r {
    width: 100%; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto auto; gap: var(--s-2); align-items: center; text-align: left;
    padding: 6px var(--s-3); min-height: 32px; border: 0; border-bottom: 1px solid var(--line); background: none; color: inherit; font: inherit; font-size: var(--t-12); cursor: pointer;
  }
  @media (hover: hover) { .r:hover { background: var(--hover); } }
  .r.following { box-shadow: inset 2px 0 0 var(--ink-3); }
  .r.lit { background: var(--pink-soft); box-shadow: inset 2px 0 0 var(--ink); }
  .r.new, .round.new { animation: trow-in 500ms var(--ease) 1; }
  @keyframes trow-in { from { opacity: 0; transform: translateY(-6px); background: var(--pink-soft); } }
  .side { font-weight: 700; font-size: var(--t-11); letter-spacing: .06em; }
  .side.sell { color: var(--ink-3); }
  .side.ev { color: var(--ink); }
  .sym { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
  .amt { position: relative; display: inline-flex; gap: 4px; align-items: center; font-variant-numeric: tabular-nums; min-width: 64px; justify-content: flex-end; }
  .amt b { position: relative; font-weight: 700; }
  .sz { position: absolute; right: 0; top: 1px; bottom: 1px; border-radius: 2px; background: var(--good); opacity: .2; max-width: 100%; }
  .sz.sell { background: var(--bad); }
  .tg { position: relative; font-size: var(--t-11); font-weight: 700; color: var(--paper); background: var(--ink); border-radius: var(--r-full); padding: 0 5px; } .tg.bg { background: var(--ink-3); }
  .when { font-size: var(--t-11); white-space: nowrap; text-align: right; }
  .ev .evt { grid-column: 2 / 4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* a payout round is a perforated divider across the tape: the pad's one regular beat */
  .round { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--s-2); align-items: center; padding: 8px var(--s-3); text-decoration: none; color: inherit; font-size: var(--t-12); background: var(--paper-3); border-bottom: 1px solid var(--line); position: relative; }
  .round .perf { grid-column: 1 / -1; height: 0; border-top: 2px dotted var(--ink-3); margin-bottom: 4px; }
  .round .rt { grid-column: 1; line-height: 1.35; }
  .round .when { grid-column: 2; }
  @media (hover: hover) { .round:hover { background: var(--hover-strong); } }
  @media (prefers-reduced-motion: reduce) { .r.new, .round.new { animation: none; } }
</style>
