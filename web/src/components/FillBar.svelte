<script lang="ts">
  // The round's clock drawn as a filling track: how far the pad is through the current round,
  // from the last payout to the next. Time, not money: the pot's amount stands beside it as text.
  // Without both ends there is nothing honest to draw, so the bar is not rendered at all.
  let { fromIso, toIso, now }: { fromIso: string | null; toIso: string | null; now: number } = $props()
  const frac = $derived.by(() => {
    if (!fromIso || !toIso) return null
    const a = Date.parse(fromIso), b = Date.parse(toIso)
    if (!(b > a)) return null
    return Math.min(1, Math.max(0, (now - a) / (b - a)))
  })
</script>

{#if frac !== null}
  <div class="track" role="img" aria-label="The round is {Math.round(frac * 100)}% of the way to the next payout">
    <span class="fill" style:width="{frac * 100}%"></span>
  </div>
{/if}

<style>
  /* an ice-tray of a track: paper recess, ink fill, tick marks every eighth so the eye can read progress without a number */
  .track {
    position: relative; height: 10px; border-radius: var(--r-xs); background: var(--paper-3); overflow: hidden;
    box-shadow: inset 0 1px 0 var(--line);
  }
  .track::after {
    content: ''; position: absolute; inset: 0;
    background: repeating-linear-gradient(90deg, transparent 0 calc(12.5% - 1px), var(--line) calc(12.5% - 1px) 12.5%);
    pointer-events: none;
  }
  .fill { position: absolute; inset: 0 auto 0 0; background: var(--ink); border-radius: var(--r-xs); transition: width 1s linear; }
  @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
</style>
