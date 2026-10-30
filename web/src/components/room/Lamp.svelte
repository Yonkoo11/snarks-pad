<script lang="ts">
  // The room's one light. A warm pool over the scene whose warmth follows the real payout clock:
  // cold just after a round, warmest as the next payout nears. It is the page's only ambient
  // signal and it is honest, because the light literally is the time to payout. The value steps
  // once a minute (derived from `now`, which the page already ticks), so no frame work happens.
  let { lastAt, nextAt, now }: { lastAt: string | null; nextAt: string | null; now: number } = $props()
  const k = $derived.by(() => {
    if (!lastAt || !nextAt) return 0.4
    const a = Date.parse(lastAt), b = Date.parse(nextAt)
    if (!(b > a)) return 0.4
    // minute resolution: the lamp is a clock hand, not an animation
    const t = Math.floor(now / 60_000) * 60_000
    return Math.min(1, Math.max(0, (t - a) / (b - a)))
  })
</script>

<div class="lamp" aria-hidden="true" style:--k={k}></div>

<style>
  .lamp {
    position: absolute; inset: 0; pointer-events: none; z-index: 1;
    background: radial-gradient(90% 70% at 72% 8%, hsl(38 90% 62% / calc(0.05 + var(--k) * 0.09)), transparent 60%);
    mix-blend-mode: multiply;
    transition: background 2s linear;
  }
  /* at night the lamp is the reason the papers stay readable: a touch stronger, blended as light */
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme='light'])) .lamp {
    mix-blend-mode: soft-light;
    background: radial-gradient(90% 70% at 72% 8%, hsl(38 85% 60% / calc(0.12 + var(--k) * 0.16)), transparent 62%);
  } }
  :global(:root[data-theme='dark']) .lamp {
    mix-blend-mode: soft-light;
    background: radial-gradient(90% 70% at 72% 8%, hsl(38 85% 60% / calc(0.12 + var(--k) * 0.16)), transparent 62%);
  }
  @media (prefers-reduced-motion: reduce) { .lamp { transition: none; } }
</style>
