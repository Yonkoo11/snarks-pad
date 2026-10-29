<script lang="ts">
  import { factsOfTier, graduationText, liquidityText, windowRowOfTier } from '../lib/launch'
  import type { Tier } from '../lib/types'
  import CoinImage from './CoinImage.svelte'

  // The card a creator watches while filling the Launch form: how the coin will look (picture, name, ticker) and the facts of this launch that are
  // fixed for good, one fact to a row (owner review 2026-10-05: a row that says two things is talking too much). Every fact is read from the tier the
  // creator picked (GET /tiers); a fact the engine does not send is a dash, and while the menu loads each value is a placeholder. Nothing here is typed in as a number.
  let { name, symbol, description, imageSrc, tier, loading }: {
    name: string; symbol: string; description: string; imageSrc: string; tier: Tier | null; loading: boolean
  } = $props()
  const facts = $derived(tier ? factsOfTier(tier) : null)
  const graduation = $derived(tier ? graduationText(tier) : null)
  const liquidity = $derived(tier ? liquidityText(tier.liquidity) : null)
  const win = $derived(tier ? windowRowOfTier(tier) : null)
</script>

<section class="card panel taped" aria-label="Preview of your coin">
  <span class="tape t1" aria-hidden="true"></span>
  <span class="tape t2" aria-hidden="true"></span>
  <div class="top">
    <CoinImage src={imageSrc} symbol={symbol || '?'} size={88} />
    <div class="who">
      <strong class="nm">{name.trim() || 'Your coin'}</strong>
      <span class="mono sym">${symbol || 'TICKER'}</span>
    </div>
  </div>
  {#if description.trim()}<p class="desc muted">{description.trim()}</p>{/if}

  <dl class="facts">
    <div class="row">
      <dt class="label">Paired with</dt>
      <dd>Solana ZEC</dd>
    </div>
    <div class="row">
      <dt class="label">Trade fee</dt>
      <dd>
        {#if facts}<span class="mono">{facts.fee}</span>, fixed at launch
        {:else if loading}<span class="skel sk" aria-busy="true" aria-label="Loading"></span>{:else}–{/if}
      </dd>
    </div>
    <div class="row">
      <dt class="label">To holders</dt>
      <dd>
        {#if facts}<span class="mono">{facts.holdersShare}</span> of every fee, in ZEC
        {:else if loading}<span class="skel sk" aria-busy="true" aria-label="Loading"></span>{:else}–{/if}
      </dd>
    </div>
    {#if facts?.creatorShare}
      <div class="row">
        <dt class="label">To you</dt>
        <dd><span class="mono">{facts.creatorShare}</span> of every fee, claimed from your wallet</dd>
      </div>
    {/if}
    <div class="row">
      <dt class="label">Launch window</dt>
      <dd>
        {#if win}<span class="mono">{win.parts.cliff}</span> at launch, <span class="mono">{win.parts.end}</span> from second&nbsp;<span class="mono">{win.parts.fromSecond}</span>
        {:else if loading}<span class="skel sk" aria-busy="true" aria-label="Loading"></span>{:else}–{/if}
      </dd>
    </div>
    <div class="row">
      <dt class="label">Graduation</dt>
      <dd>
        {#if graduation}When the curve holds <span class="mono">{graduation}</span>
        {:else if loading}<span class="skel sk" aria-busy="true" aria-label="Loading"></span>{:else}–{/if}
      </dd>
    </div>
    <div class="row">
      <dt class="label">Liquidity</dt>
      <dd>
        {#if liquidity}{liquidity}
        {:else if loading}<span class="skel sk" aria-busy="true" aria-label="Loading"></span>{:else}–{/if}
      </dd>
    </div>
  </dl>
</section>
<p class="onchain muted">Name, ticker, image, links and fee are written on chain at launch and cannot be changed after.</p>
<p class="onchain muted">Launching needs about <span class="mono">0.02 SOL</span> in your wallet for the network fee and the coin's accounts, plus any first buy in Solana ZEC.</p>

<style>
  /* the draft coin, taped to the door like the drawing on Home: it is the thing being made */
  .card { display: grid; gap: var(--s-4); padding: var(--s-4); position: relative; transform: rotate(-1deg); }
  .tape {
    position: absolute; width: 84px; height: 26px; top: -12px; z-index: 1;
    background: rgba(236, 222, 190, .82);
    box-shadow: 0 1px 0 rgba(43, 36, 32, .12);
  }
  .t1 { left: 10%; transform: rotate(-8deg); }
  .t2 { right: 8%; transform: rotate(6deg); }
  .top { display: flex; gap: var(--s-4); align-items: center; min-width: 0; }
  .who { display: grid; gap: var(--s-1); min-width: 0; }
  .nm { font-size: var(--t-20); line-height: 1.25; overflow-wrap: anywhere; }
  .sym { font-size: var(--t-14); color: var(--ink-2); }
  .desc { font-size: var(--t-14); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .facts { margin: 0; display: grid; }
  .row { display: grid; grid-template-columns: minmax(0, 7rem) minmax(0, 1fr); gap: var(--s-1) var(--s-4); padding: var(--s-3) 0; border-top: 1px solid var(--line); align-items: baseline; }
  .row dt { margin: 0; }
  .row dd { margin: 0; font-size: var(--t-16); }
  .sk { display: block; height: 20px; max-width: 220px; }
  .onchain { font-size: var(--t-14); }
</style>
