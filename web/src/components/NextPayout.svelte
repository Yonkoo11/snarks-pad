<script lang="ts">
  import { countdown } from '../lib/format'
  // The next payout in words, with only the time in mono: "Next payout in 0h 56m 16s", "Payout due now" (the page cannot see whether the keeper has started it),
  // "No payout scheduled yet". `at` is GET /treasury nextEpochAt; `now` is the caller's one-second ticker.
  // With no scheduled time but a known cadence (GET /treasury cadence.roundEveryMs), the line gives the rhythm instead of nothing.
  // `bare` drops the leading words for a slot whose label already says "next payout" (the Explore stats row).
  let { at, now, everyMs = null, bare = false }: { at: string | null; now: number; everyMs?: number | null; bare?: boolean } = $props()
  const due = $derived(at !== null && Date.parse(at) - now <= 0)
  const everyH = $derived(everyMs !== null && everyMs > 0 ? Math.round(everyMs / 3_600_000) : null)
</script>

{#if at === null}{#if everyH !== null}{bare ? 'about every' : 'Rounds run about every'} <span class="mono">{everyH}h</span>{#if !bare}; times are not announced{/if}{:else}{bare ? 'not scheduled yet' : 'No payout scheduled yet'}{/if}{:else if due}{bare ? 'due now' : 'Payout due now'}{:else}{bare ? 'in' : 'Next payout in'} <span class="mono">{countdown(at, now)}</span>{/if}
