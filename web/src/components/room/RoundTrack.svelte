<script lang="ts">
  // Where a round's money has got to, as three stops the chain records: the holder snapshot is published, its hash is written to
  // Solana in a memo, the payment transactions exist. A stop is lit only when the record for it exists; the mascot stands on the
  // furthest lit stop and is the same picture moved, nothing more. A round that needs the operator lights nothing past what is real.
  import type { Epoch } from '../../lib/types'

  const { e }: { e: Epoch } = $props()
  const stops = $derived([
    { label: 'Snapshot', on: !!e.snapshot },
    { label: 'Hash on Solana', on: !!e.snapshot?.memoSig },
    { label: 'Paid', on: e.solanaPayouts.sigs.length > 0 && e.status !== 'needs_attention' },
  ])
  const at = $derived(Math.max(-1, ...stops.map((s, i) => (s.on ? i : -1))))
</script>

<div class="track" role="img" aria-label="Round progress: {stops.filter((s) => s.on).map((s) => s.label).join(', ') || 'nothing recorded yet'}">
  {#if at >= 0}<img class="who" src="/mascot-256.jpg" alt="" width="28" height="28" style:left="{at * 50}%" />{/if}
  <span class="rail" aria-hidden="true"></span>
  {#each stops as s, i (s.label)}
    <span class="stop" class:on={s.on} style:left="{i * 50}%" aria-hidden="true"><i></i><b>{s.label}</b></span>
  {/each}
</div>

<style>
  .track { position: relative; height: 64px; margin: var(--s-2) 14px var(--s-2); }
  .rail { position: absolute; left: 0; right: 0; top: 36px; border-top: 1.5px dashed var(--ink-3); }
  .stop { position: absolute; top: 30px; display: grid; justify-items: center; gap: 4px; transform: translateX(-50%); white-space: nowrap; }
  .stop i { width: 12px; height: 12px; border-radius: var(--r-full); border: 1.5px dashed var(--ink-3); background: var(--paper-2); }
  .stop.on i { border: 1.5px solid var(--ink); background: var(--ink); }
  .stop b { font-size: var(--t-11); font-weight: 400; color: var(--ink-3); }
  .stop.on b { color: var(--ink); font-weight: 700; }
  .stop:first-of-type { transform: translateX(-14px); justify-items: start; }
  .who { position: absolute; top: -2px; width: 28px; height: 28px; object-fit: cover; object-position: 50% 30%; border-radius: var(--r-xs); transform: translateX(-50%); transition: left 420ms var(--ease); box-shadow: var(--sh-1); }
  @media (prefers-reduced-motion: reduce) { .who { transition: none; } }
</style>
