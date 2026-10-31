<script lang="ts">
  // The mascot in the envelope, its height out of the paper tracking what is actually happening: the user's own hold lifts it
  // toward halfway, the pending request keeps it there, and only a success from the pad lets it out. A refusal sends it back in.
  // It can show nothing the page does not know, and the hold alone can never take it past halfway.
  import { reducedMotion } from '../../lib/motion'
  const { p, settle = false }: { p: number; settle?: boolean } = $props() // 0 in the envelope .. 1 out of it
  const still = reducedMotion()
  const UP = 58
</script>

<span class="ep" class:settle aria-hidden="true">
  <img src="/mascot-256.jpg" alt="" width="56" height="56" style:transform="translateY({-p * UP}px)" class:ease={!still} />
  <svg viewBox="0 0 72 56" class="front"><rect x="1.5" y="1.5" width="69" height="53" rx="3" /><path d="M2 3 L36 30 L70 3" /></svg>
</span>

<style>
  .ep { position: relative; display: inline-block; width: 72px; height: 56px; margin-top: 60px; flex: none; }
  img { position: absolute; left: 8px; bottom: 6px; width: 56px; height: 56px; object-fit: cover; object-position: 50% 30%; border-radius: var(--r-xs); }
  img.ease { transition: transform 360ms var(--ease); }
  .front { position: absolute; inset: 0; width: 72px; height: 56px; fill: var(--paper-2); stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; }
  .settle img { animation: out 560ms var(--ease) backwards; }
  @keyframes out { from { transform: translateY(-29px); } }
  @media (prefers-reduced-motion: reduce) { .settle img { animation: none; } }
</style>
