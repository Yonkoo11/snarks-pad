<script lang="ts">
  import { pct } from '../lib/format'
  let { progress, stage, compact = false }: { progress: number; stage: 'curve' | 'graduated'; compact?: boolean } = $props()
  const p = $derived(Math.max(0, Math.min(1, progress)))
</script>

<div class="curve" class:compact style:--p={p}>
  {#if !compact}
    <div class="top">
      <span class="label">Meteora bonding curve</span>
      <span class="mono">{stage === 'graduated' ? 'graduated to Meteora' : pct(p) + ' to graduation'}</span>
    </div>
  {/if}
  <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(p * 100)} aria-label="Bonding curve progress">
    <div class="fill"></div>
    {#if p > 0 && p < 1}<span class="clip" aria-hidden="true"><span class="capwrap"><span class="cap"></span></span></span>{/if}
  </div>
</div>

<style>
  .curve { display: grid; gap: var(--s-2); }
  /* label and value each stay on one line; on a narrow card the value drops under the label whole, never word by word */
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s-1) var(--s-3); font-size: var(--t-14); flex-wrap: wrap; }
  .top > span { white-space: nowrap; }
  .track { position: relative; height: 16px; border-radius: var(--r-full); background: var(--paper-3); overflow: visible; }
  .compact .track { height: 10px; }
  /* The fill is clipped, not resized, and the cap rides a full-width wrapper's transform: no width or left ever
     animates (R6.9). Both move to a new value over --d-data on the one curve. */
  .fill {
    position: absolute; inset: 0; border-radius: var(--r-full); background: var(--ink-2);
    clip-path: inset(0 calc((1 - var(--p)) * 100%) 0 0);
    transition: clip-path var(--d-data) var(--ease);
  }
  /* .clip (the track plus 12px all round, overflow hidden) keeps the moved wrapper out of the page's scroll width: a transformed box
     otherwise widens the document at 390. .capwrap is exactly the track's box, so translateX(p * 100%) is p of the track. */
  .clip { position: absolute; inset: -12px; overflow: hidden; pointer-events: none; }
  .capwrap { position: absolute; inset: 12px; transform: translateX(calc(var(--p) * 100%)); transition: transform var(--d-data) var(--ease); }
  /* a triangle end cap marks where the curve stands */
  .cap {
    position: absolute; left: 0; top: 50%; width: 0; height: 0; transform: translate(-2px, -50%);
    border-top: 11px solid transparent; border-bottom: 11px solid transparent; border-left: 12px solid var(--ink-2);
  }
  .compact .cap { border-top-width: 8px; border-bottom-width: 8px; border-left-width: 9px; }
  /* The card-size bar fills to its value once on first paint (600ms); list bars render in place. */
  .curve:not(.compact) .fill { animation: curve-fill var(--d-fill) var(--ease) 1; }
  .curve:not(.compact) .capwrap { animation: curve-cap var(--d-fill) var(--ease) 1; }
  @keyframes curve-fill { from { clip-path: inset(0 100% 0 0); } }
  @keyframes curve-cap { from { transform: translateX(0); } }
</style>
