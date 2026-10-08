<script lang="ts">
  import type { FeeShares } from '../lib/fees'
  // Where every trade's fee goes, the one component for it (Home, Coin, Launch, Treasury): a 12px bar whose segments are as
  // wide as the shares passed in, one legend row per share with its percentage aligned right, and one line (no per-$100 figures: research/COPY-AUDIT.md). The shares
  // arrive computed (lib/fees.ts); nothing here is typed in. Tones are steps of the text ink, so they read on light and dark
  // paper alike, and the swatch beside each name is the segment's own tone. No pink: this bar says where the fee goes, not
  // what is shielded. `split` undefined = loading, null = the request failed.
  let { split, title = "Where every trade's fee goes", creatorWho = 'Creator', line, onretry }: {
    split?: FeeShares | null; title?: string | null; creatorWho?: string; line?: string; onretry?: () => void
  } = $props()
  const id = $props.id()
  const rows = $derived(split ? [
    { key: 'holders', who: 'Holders', bps: split.holdersBps },
    { key: 'team', who: 'Team', bps: split.teamBps },
    { key: 'creator', who: creatorWho, bps: split.creatorBps },
    { key: 'meteora', who: 'Meteora', bps: split.meteoraBps },
  ].filter((r) => r.bps > 0) : [])
  const pct = (bps: number) => `${Math.round(bps / 10) / 10}%`
  const text = $derived(line ?? (split && split.creatorBps > 0
    ? 'Holders are paid in ZEC each round. The creator claims their share from the coin page.'
    : 'Holders are paid in ZEC each round.'))
</script>

<section class="fs" aria-labelledby={title ? `${id}-h` : undefined}>
  {#if title}<h2 class="h2" id="{id}-h">{title}</h2>{/if}
  {#if split === undefined}
    <div class="body" aria-busy="true" aria-label="Loading the fee split">
      <div class="skel bar-sk"></div>
      <div class="cols"><div class="skel legend-sk"></div><div class="skel line-sk"></div></div>
    </div>
  {:else if split === null}
    <div class="body">
      <p class="error">Could not load the fee split from the pad.</p>
      {#if onretry}<button class="btn retry" type="button" onclick={onretry}>Try again</button>{/if}
    </div>
  {:else}
    <div class="body">
      <div class="bar" aria-hidden="true">
        {#each rows as r (r.key)}<span class="seg {r.key}" style:flex-grow={r.bps}></span>{/each}
      </div>
      <div class="cols">
        <div class="legend">
          <p class="hdr"><span>Where the <span class="mono">{split.feeBps / 100}%</span> curve fee goes</span></p>
          <dl>
            {#each rows as r (r.key)}
              <div class="row">
                <dt><span class="key {r.key}" aria-hidden="true"></span>{r.who}</dt>
                <dd class="mono">{pct(r.bps)}</dd>
              </div>
            {/each}
          </dl>
        </div>
        <p class="line">{text}</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .fs { display: grid; gap: var(--s-4); container-type: inline-size; }
  .body { display: grid; gap: var(--s-4); }
  .bar { display: flex; gap: 2px; height: 12px; }
  .seg { flex-basis: 0; min-width: 4px; border-radius: var(--r-xs); }
  /* four steps of the one ink: on light paper dark greys, on night paper light ones */
  .holders { background: var(--ink); }
  .creator { background: color-mix(in srgb, var(--ink) 80%, transparent); }
  .team { background: color-mix(in srgb, var(--ink) 55%, transparent); }
  .meteora { background: color-mix(in srgb, var(--ink) 25%, transparent); }
  .cols { display: grid; gap: var(--s-4); }
  .legend { display: grid; gap: var(--s-2); }
  .legend dl { margin: 0; display: grid; gap: var(--s-2); }
  .hdr, .row { display: flex; justify-content: space-between; gap: var(--s-4); align-items: baseline; margin: 0; }
  .hdr { font-size: var(--t-14); color: var(--ink-2); }
  .row { font-size: var(--t-16); }
  .row dt { display: flex; align-items: center; gap: var(--s-2); }
  .row dd { margin: 0; }
  .key { width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }
  .line { font-size: var(--t-16); color: var(--ink-2); max-width: 44ch; }
  .retry { justify-self: start; }
  /* loading: the heights of the loaded block, so nothing under it moves */
  .bar-sk { height: 12px; }
  .legend-sk { height: 116px; }
  .line-sk { height: 72px; }
  @container (min-width: 640px) {
    .cols { grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: var(--s-7); align-items: start; }
  }
  @container (max-width: 639px) { .line-sk { height: 96px; } }
</style>
