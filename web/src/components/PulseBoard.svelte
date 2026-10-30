<script lang="ts">
  import type { Coin } from '../lib/types'
  import { zec, pct, ago } from '../lib/format'
  import CoinImage from './CoinImage.svelte'
  import CurveBar from './CurveBar.svelte'

  // The pulse board: the market as three live lanes instead of one anonymous strip. Just launched
  // (newest first), filling the curve (nearest graduation first) and graduated (biggest first);
  // every row is a coin on its way to paying holders, which is the pad's one job. One coin on the
  // curve wears the "busiest today" tag: the largest 24h-volume-to-market-cap ratio among the lane,
  // a relative mark that needs no invented threshold. Lanes refresh with the page's own poll.
  let { fresh, filling, graduated, now }: { fresh: Coin[] | null; filling: Coin[] | null; graduated: Coin[] | null; now: number } = $props()

  const heat = (c: Coin): number => {
    const v = Number(c.volume24hZats ?? 0)
    const m = Number(c.marketCapZec ?? 0)
    return m > 0 ? v / m : 0
  }
  const busiest = $derived.by(() => {
    const cs = (filling ?? []).filter((c) => heat(c) > 0)
    if (cs.length < 2) return null // a tag on the only coin marks nothing
    return cs.reduce((a, b) => (heat(b) > heat(a) ? b : a)).mint
  })
  const lanes = $derived([
    { id: 'fresh', title: 'Just launched', coins: fresh, empty: 'Nothing launched today. The next coin starts here.' },
    { id: 'filling', title: 'Filling the curve', coins: filling, empty: 'No coin is on a curve right now.' },
    { id: 'graduated', title: 'Graduated', coins: graduated, empty: 'No coin has graduated yet.' },
  ])
</script>

<div class="pwrap">
<div class="pulse">
  {#each lanes as lane (lane.id)}
    <section class="lane" aria-labelledby="lane-{lane.id}">
      <h3 class="h3" id="lane-{lane.id}">{lane.title}</h3>
      {#if lane.coins === null}
        <div class="skel lane-sk" aria-busy="true" aria-label="Loading {lane.title}"></div>
      {:else if lane.coins.length === 0}
        <p class="muted none">{lane.empty}</p>
      {:else}
        <div class="rows">
          {#each lane.coins as c, i (c.mint)}
            <a class="prow panel" href="#/coin/{c.mint}" style:--i={i}>
              <CoinImage src={c.imageUrl} symbol={c.symbol} size={32} />
              <span class="pt"><strong class="name">{c.name}</strong><span class="mono sym">${c.symbol}</span>{#if c.mint === busiest}<span class="busy">busiest today</span>{/if}</span>
              {#if lane.id === 'fresh'}
                <span class="pm"><span class="muted">{ago(c.createdAt, now)}</span><span class="muted">&middot;</span><span class="muted">cap</span><span class="mono">{c.marketCapZec === undefined ? '–' : `${zec(c.marketCapZec, 2)} ZEC`}</span></span>
              {:else if lane.id === 'filling'}
                <span class="pm bar-line">{#if c.curveProgress === undefined}<span class="mono">–</span>{:else}<span class="bar"><CurveBar progress={c.curveProgress} stage={c.stage} compact /></span><span class="mono pc">{pct(c.curveProgress)}</span>{/if}</span>
                {#if c.curveRoomZats !== undefined}<span class="pm muted"><span class="mono">{zec(c.curveRoomZats, 2)} ZEC</span>&nbsp;to go</span>{/if}
              {:else}
                <span class="pm"><span class="muted">Market cap</span><span class="mono">{c.marketCapZec === undefined ? '–' : `${zec(c.marketCapZec, 2)} ZEC`}</span></span>
                <span class="pm"><span class="muted">24h</span><span class="mono">{c.volume24hZats === undefined ? '–' : `${zec(c.volume24hZats, 2)} ZEC`}</span></span>
              {/if}
            </a>
          {/each}
        </div>
      {/if}
    </section>
  {/each}
</div>
</div>

<style>
  /* the board measures its own box: three lanes side by side when it is wide, stacked when its
     column is narrow (the door's center, a phone). A container query, so the same board works
     wherever it is pinned. */
  .pwrap { container-type: inline-size; min-width: 0; }
  .pulse { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-4); align-items: start; }
  @container (max-width: 720px) {
    .pulse { grid-template-columns: 1fr; gap: var(--s-4); }
  }
  .lane { display: grid; gap: var(--s-2); min-width: 0; }
  .lane-sk { height: 168px; border-radius: var(--r-md); }
  .none { font-size: var(--t-14); }
  .rows { display: grid; gap: var(--s-2); }
  .prow {
    display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: var(--s-1) var(--s-3); align-items: center;
    padding: var(--s-2) var(--s-3); border-radius: var(--r-md); text-decoration: none; color: inherit;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
    /* the board settles in once, each row a beat after the one above (entrance-only) */
    animation: prow-in 300ms var(--ease) both;
    animation-delay: calc(var(--i) * 50ms);
  }
  @keyframes prow-in { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { .prow { animation: none; } }
  @media (hover: hover) { .prow:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  .prow:active { transform: translateY(1px); box-shadow: var(--sh-1); transition-duration: var(--d-press); }
  .pt { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; flex-wrap: wrap; }
  .name { font-size: var(--t-16); line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .sym { font-size: var(--t-12); color: var(--ink-2); }
  /* the one relative mark on the board: ink on paper, not a siren */
  .busy { font-size: var(--t-12); font-weight: 700; background: var(--ink); color: var(--paper); border-radius: var(--r-full); padding: 1px 8px; white-space: nowrap; }
  .pm { grid-column: 2; display: flex; align-items: center; gap: var(--s-2); font-size: var(--t-14); min-width: 0; }
  .pm .mono { white-space: nowrap; }
  .bar-line .bar { flex: 1; min-width: 0; }
  .pc { color: var(--ink-2); min-width: 4ch; text-align: right; }
</style>
