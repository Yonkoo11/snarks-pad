<script lang="ts">
  import { audit } from '../lib/audit.svelte'
</script>

<button class="aud" type="button" aria-pressed={audit.on} onclick={() => audit.toggle()} title="Show where every number comes from (key a)">
  <span class="mono" aria-hidden="true">i</span> Audit view
</button>

<style>
  .aud { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-full); background: transparent; color: var(--ink-2); font: inherit; font-size: var(--t-12); font-weight: 700; cursor: pointer; }
  .aud > span { width: 16px; height: 16px; border: 1px solid currentColor; border-radius: var(--r-full); display: inline-grid; place-items: center; font-style: italic; font-size: 10px; }
  .aud[aria-pressed='true'] { color: var(--ink); background: var(--hover-strong); }
  @media (hover: hover) { .aud:hover { color: var(--ink); background: var(--hover); } }
</style>
