<script lang="ts">
  // "How we know": the second layer under a number. A small mark opens one line saying where the figure came from, how many
  // observations stand behind it (n), when it was read, and what it does not mean. In the audit view every line is open.
  import { audit } from '../lib/audit.svelte'
  import { ago } from '../lib/format'

  const { label, src, n = null, at = null, now = Date.now(), note = '' }: {
    label: string // what the number is, for the mark's name
    src: string // where it came from
    n?: string | number | null // the count behind it, when there is one
    at?: number | null // when it was read (ms)
    now?: number
    note?: string // what it does not mean
  } = $props()
  let open = $state(false)
  const shown = $derived(open || audit.on)
</script>

<span class="prov">
  <button class="pv" type="button" aria-expanded={shown} aria-label="How we know: {label}" onclick={() => (open = !open)}><span aria-hidden="true">i</span></button>
  {#if shown}
    <span class="pvline mono">{src}{#if n !== null}, n={n}{/if}{#if at}, read {ago(new Date(at).toISOString(), now)}{/if}.{#if note} {note}{/if}</span>
  {/if}
</span>

<style>
  .prov { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; vertical-align: middle; max-width: 100%; }
  .pv {
    width: 16px; height: 16px; padding: 0; border: 1px solid var(--ink-3); border-radius: var(--r-full); background: none; color: var(--ink-3);
    font: italic 700 10px/1 var(--f-body); cursor: pointer; display: inline-grid; place-items: center; margin-left: var(--s-1);
  }
  /* a 44px target around a 16px mark */
  .pv::after { content: ''; position: absolute; width: 44px; height: 44px; translate: -14px -14px; }
  .pv { position: relative; }
  .pv[aria-expanded='true'] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  @media (hover: hover) { .pv:hover { color: var(--ink); border-color: var(--ink); } }
  .pvline { display: block; font-size: var(--t-11); font-weight: 400; color: var(--ink-2); line-height: 1.35; max-width: 34ch; text-wrap: pretty; margin-top: 2px; }
</style>
