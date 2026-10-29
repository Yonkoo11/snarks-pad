<script lang="ts">
  import { EASE, reducedMotion } from '../lib/motion'
  // The proof meters' entrance: the number rises from 0 to its first real value once, on the one curve,
  // then later changes land directly (LiveNumber covers numbers that keep moving). Entrance-only, per the
  // design system; reduced motion lands at the value with no run.
  let { value, format, ms = 900 }: { value: number; format: (v: number) => string; ms?: number } = $props()
  let shown = $state(0)
  let entered = false
  $effect(() => {
    const target = value
    if (entered || reducedMotion() || ms <= 0 || target === 0) { entered = true; shown = target; return }
    entered = true
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      shown = target * EASE(k)
      if (k < 1) raf = requestAnimationFrame(step)
      else shown = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  })
</script>

<span class="mono">{format(shown)}</span>
