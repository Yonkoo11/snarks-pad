<script lang="ts">
  import { countdown } from '../lib/format'
  // The next payout in words, with only the time in mono: "Next payout in 0h 56m 16s", "Payout due now" (the page cannot see whether the keeper has started it),
  // "No payout scheduled yet". `at` is GET /treasury nextEpochAt; `now` is the caller's one-second ticker.
  let { at, now }: { at: string | null; now: number } = $props()
  const due = $derived(at !== null && Date.parse(at) - now <= 0)
</script>

{#if at === null}No payout scheduled yet{:else if due}Payout due now{:else}Next payout in <span class="mono">{countdown(at, now)}</span>{/if}
