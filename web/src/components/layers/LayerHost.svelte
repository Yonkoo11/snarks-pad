<script lang="ts">
  // The one place layers are drawn. Reads the stack and lays a Sheet per layer, the lowest with the scrim. Esc and the scrim
  // close the top layer only. Each kind's body is its own component, loaded the first time a layer of that kind opens.
  import { layers } from '../../lib/layers.svelte'
  import Sheet from './Sheet.svelte'
  import DossierSheet from './DossierSheet.svelte'
  import CompareTray from './CompareTray.svelte'

  const Compare = () => import('./CompareSheet.svelte')
  const TapeSheet = () => import('./TapeSheet.svelte')

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || !layers.top) return
    e.preventDefault()
    layers.closeTop()
  }
  $effect(() => {
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })
  const n = $derived(layers.stack.length)
</script>

<CompareTray />
{#if n > 0}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => layers.closeTop()}></div>
{/if}
{#each layers.stack as l, i (l.uid)}
  <Sheet layer={l} below={n - 1 - i}>
    {#if l.kind === 'dossier'}<DossierSheet layerKey={l.key} />
    {:else if l.kind === 'compare'}{#await Compare()}<div class="skel" style="height: 160px" aria-busy="true"></div>{:then M}<M.default />{:catch e}<p class="error" role="alert">Could not open the shelf: {e?.message ?? 'load failed'}</p>{/await}
    {:else}{#await TapeSheet() then M}<M.default />{/await}{/if}
  </Sheet>
{/each}

<style>
  .scrim { position: fixed; inset: 0; z-index: 50; background: light-dark(rgba(43, 36, 32, .22), rgba(0, 0, 0, .5)); animation: scrim-in 200ms var(--ease); }
  @keyframes scrim-in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .scrim { animation: none; } }
</style>
