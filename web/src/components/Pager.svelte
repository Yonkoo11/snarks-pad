<script lang="ts">
  // The house pager, extracted from the Payouts page so every list speaks it: numbered pages with
  // Previous and Next, and the range line "Unit X to Y of N". The caller owns the page state and,
  // per the standard, writes it into the address (history.replaceState) in its `onpage`.
  let { page, pages, total, per, label, unit, note = '', onpage }: {
    page: number; pages: number; total: number; per: number; label: string; unit: string; note?: string; onpage: (p: number) => void
  } = $props()
  const from = $derived(Math.min((page - 1) * per + 1, total))
  const to = $derived(Math.min(page * per, total))
  // every number up to nine pages; beyond that the first, the last and a window around the current one
  const nums = $derived.by(() => {
    if (pages <= 9) return Array.from({ length: pages }, (_, i) => i + 1)
    const set = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages))
    return [...set].sort((a, b) => a - b)
  })
</script>

{#if pages > 1}
  <nav class="pager" aria-label={label}>
    <button class="btn" type="button" disabled={page <= 1} onclick={() => onpage(page - 1)}>Previous</button>
    {#each nums as p, i (p)}
      {#if i > 0 && nums[i - 1] < p - 1}<span class="gap mono" aria-hidden="true">&hellip;</span>{/if}
      <button class="btn pnum" class:primary={p === page} type="button" aria-current={p === page ? 'page' : undefined} onclick={() => onpage(p)}>{p}</button>
    {/each}
    <button class="btn" type="button" disabled={page >= pages} onclick={() => onpage(page + 1)}>Next</button>
    <p class="mono range">{unit} {from} to {to} of {total}{note ? `, ${note}` : ''}</p>
  </nav>
{:else if total > 0}
  <p class="mono range lone">{unit} 1 to {total} of {total}{note ? `, ${note}` : ''}</p>
{/if}

<style>
  .pager { display: flex; gap: var(--s-2); justify-content: center; align-items: center; flex-wrap: wrap; padding-top: var(--s-5); }
  .pnum { min-width: 48px; padding: 0 var(--s-3); }
  .gap { color: var(--ink-3); padding: 0 2px; }
  .range { flex: 1 1 100%; text-align: center; font-size: var(--t-14); color: var(--ink-2); margin: var(--s-2) 0 0; }
  .lone { font-size: var(--t-14); color: var(--ink-2); margin: var(--s-2) 0 0; }
</style>
