<script lang="ts">
  // The full live tape as a sheet: the phone's way into the rail. Picking a trade opens that coin's dossier on top, one layer deeper.
  import { layers, dossierKey } from '../../lib/layers.svelte'
  import TapeList from './TapeList.svelte'
  let now = $state(Date.now())
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })
</script>

<div class="ts">
  <p class="muted tnote">The pad's pulse: trades, launches, graduations and payout rounds, newest first. Narrow it with the chips. Rest a finger or pointer on the list, or press Pause, and new items queue behind a bar instead of pushing the rows.</p>
  <div class="box"><TapeList limit={80} {now} onpick={(mint, symbol) => layers.open({ kind: 'dossier', key: dossierKey(mint), title: `$${symbol}` })} /></div>
</div>

<style>
  .ts { display: grid; gap: var(--s-3); }
  .tnote { font-size: var(--t-14); }
  .box { height: min(60svh, 560px); border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
</style>
