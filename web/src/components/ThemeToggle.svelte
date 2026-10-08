<script lang="ts">
  import { theme } from '../lib/theme.svelte'
  // Sun while the page is light (press for dark), moon while it is dark (press for light). The icon swaps with no
  // transition: a theme switch animates nothing.
  const dark = $derived(theme.effective === 'dark')
</script>

<button class="tt" type="button" aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} onclick={() => theme.toggle()}>
  {#if dark}
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
  {:else}
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.2v2.3M12 19.5v2.3M2.2 12h2.3M19.5 12h2.3M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M5.1 18.9l1.6-1.6M17.3 6.7l1.6-1.6" /></svg>
  {/if}
</button>

<style>
  .tt {
    width: 48px; height: 48px; flex: none; display: grid; place-items: center; padding: 0;
    border: 0; border-radius: var(--r-md); background: var(--paper-3); color: var(--ink);
    box-shadow: var(--sh-2); cursor: pointer;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; display: block; }
  @media (hover: hover) { .tt:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  .tt:active { transform: translateY(1px); box-shadow: var(--sh-1); transition-duration: var(--d-press); }
  @media (max-width: 640px) { .tt { width: 44px; height: 44px; } }
</style>
