<script lang="ts">
  // The shelf, always in reach: a small tray at the foot of the page while anything is pinned. It opens the compare sheet.
  import { compare, MAX_PINS } from '../../lib/compare.svelte'
  import { layers } from '../../lib/layers.svelte'
  const n = $derived(compare.pins.length)
  // the sheet's code is fetched as soon as something is pinned, so opening it is instant
  $effect(() => { if (n > 0) void import('./CompareSheet.svelte') })
</script>

{#if n > 0 && !layers.top}
  <div class="tray" role="region" aria-label="Compare shelf">
    <span class="t mono">Shelf {n}/{MAX_PINS}</span>
    <button class="btn open" type="button" onclick={() => layers.open({ kind: 'compare', key: 'compare', title: 'Compare' })}>Compare{#if n < 2}<span class="hint"> (pin another)</span>{/if}</button>
    <button class="clear" type="button" onclick={() => compare.clear()} aria-label="Clear the compare shelf">&times;</button>
  </div>
{/if}

<style>
  .tray {
    position: fixed; z-index: 40; left: 50%; translate: -50% 0; bottom: var(--s-4); display: flex; align-items: center; gap: var(--s-3);
    padding: var(--s-2) var(--s-2) var(--s-2) var(--s-4); background: var(--paper-2); border-radius: var(--r-full); box-shadow: var(--sh-3), 0 0 0 1.5px var(--line);
    animation: tray-in 200ms var(--ease);
  }
  .t { font-size: var(--t-12); color: var(--ink-2); }
  .open { min-height: 40px; font-size: var(--t-14); padding: 0 var(--s-4); }
  .hint { font-weight: 400; color: var(--ink-2); }
  .clear { border: 0; background: none; font-size: 20px; line-height: 1; min-width: 40px; min-height: 40px; border-radius: var(--r-full); color: var(--ink-3); cursor: pointer; }
  @media (hover: hover) { .clear:hover { background: var(--hover); color: var(--ink); } }
  @keyframes tray-in { from { opacity: 0; transform: translateY(8px); } }
  @media (max-width: 640px) { .tray { bottom: calc(104px + env(safe-area-inset-bottom, 0px)); } }
  @media (prefers-reduced-motion: reduce) { .tray { animation: none; } }
</style>
