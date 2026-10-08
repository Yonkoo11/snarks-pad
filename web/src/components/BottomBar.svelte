<script lang="ts">
  import { router } from '../lib/router.svelte'
  // The phone's bottom bar (shown at 640px and below, app.css gives the page room for it): Explore, Launch, Shielded,
  // Treasury, each a 44px-plus target, the current page in full ink. Shielded carries the hatched key, the one device.
  const items = [
    { href: '#/', name: 'home', label: 'Explore' },
    { href: '#/launch', name: 'launch', label: 'Launch' },
    { href: '#/shielded', name: 'shielded', label: 'Shielded' },
    { href: '#/treasury', name: 'treasury', label: 'Payouts' },
  ] as const
  const current = $derived(router.route.name === 'coin' ? 'home' : router.route.name)
</script>

<nav class="bar" aria-label="Pages">
  {#each items as it (it.name)}
    <a href={it.href} aria-current={current === it.name ? 'page' : undefined}>
      {#if it.name === 'home'}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></svg>
      {:else if it.name === 'launch'}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></svg>
      {:else if it.name === 'shielded'}
        <span class="key hatch" aria-hidden="true"></span>
      {:else}
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="1.5" /><path d="M8 8.5h8M8 12.5h8M8 16.5h5" /></svg>
      {/if}
      <span>{it.label}</span>
    </a>
  {/each}
</nav>

<style>
  .bar {
    display: none; position: fixed; inset: auto 0 0 0; z-index: 30;
    grid-template-columns: repeat(4, 1fr); background: var(--paper-2); box-shadow: 0 -2px 0 var(--line);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  a {
    display: grid; justify-items: center; align-content: center; gap: 2px; min-height: 56px; padding: var(--s-1) 0;
    font-size: var(--t-12); font-weight: 700; color: var(--ink-2); text-decoration: none; letter-spacing: .02em;
  }
  a[aria-current='page'] { color: var(--ink); }
  svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: block; }
  .key { display: block; width: 22px; height: 22px; border-radius: var(--r-xs); }
  @media (max-width: 640px) { .bar { display: grid; } }
</style>
