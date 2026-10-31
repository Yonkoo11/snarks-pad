<script lang="ts">
  import { reducedMotion } from '../../lib/motion'
  // The opt-in as a ceremony: an envelope sealed by holding, not by a passing click. Hold the seal
  // for a second (pointer, or hold Space or Enter) and the wax ring draws itself shut; release early
  // and it falls open again. The hold is theatre with a purpose - the choice should feel deliberate -
  // while the real safety stays where it was: the wallet shows the exact message before anything is
  // signed. Reduced motion (or any assistive pressure) gets a plain click; the wallet still confirms.
  let { label, busy = null, disabled = false, onseal, onhold }: {
    label: string; busy?: string | null; disabled?: boolean; onseal: () => void
    onhold?: (k: number) => void // the user's own hold, 0..1, for whatever should follow it
  } = $props()

  const HOLD_MS = 900
  const still = reducedMotion()
  let k = $state(0) // 0 open .. 1 sealed
  let holding = $state(false)
  let raf = 0
  let t0 = 0

  function start() {
    if (disabled || busy) return
    if (still) { onseal(); return }
    holding = true
    t0 = performance.now()
    const step = (t: number) => {
      k = Math.min(1, (t - t0) / HOLD_MS)
      if (k >= 1) { holding = false; k = 0; onhold?.(0); onseal(); return }
      onhold?.(k)
      if (holding) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }
  function stop() {
    holding = false
    cancelAnimationFrame(raf)
    k = 0
    onhold?.(0)
  }
  function onKey(e: KeyboardEvent, down: boolean) {
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    if (down && !e.repeat) start()
    if (!down) stop()
  }

  const R = 15
  const C = 2 * Math.PI * R
</script>

<button
  class="seal-btn"
  class:holding
  type="button"
  {disabled}
  aria-describedby="seal-how"
  onpointerdown={start}
  onpointerup={stop}
  onpointerleave={stop}
  onpointercancel={stop}
  onkeydown={(e) => onKey(e, true)}
  onkeyup={(e) => onKey(e, false)}
>
  <svg class="env" viewBox="0 0 44 32" aria-hidden="true">
    <rect x="1.5" y="1.5" width="41" height="29" rx="2.5" />
    <path class="flap" d="M2 3 L22 17 L42 3" />
    <g class="wax" transform="translate(22, 20)">
      <circle class="ring" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - k)} />
      <circle class="core" r="10" style:opacity={0.25 + k * 0.75} />
    </g>
  </svg>
  <span class="t">{busy ?? (holding ? 'Hold to seal…' : label)}</span>
</button>
<p class="small muted" id="seal-how">{still ? 'Your wallet shows the exact message before anything is signed.' : 'Press and hold for a second to seal it. Your wallet then shows the exact message before anything is signed.'}</p>

<style>
  .seal-btn {
    display: inline-flex; align-items: center; gap: var(--s-3);
    min-height: 56px; padding: var(--s-2) var(--s-5) var(--s-2) var(--s-3);
    border: 0; border-radius: var(--r-md); cursor: pointer;
    background: var(--pink); color: var(--pink-ink);
    font: inherit; font-weight: 700; font-size: var(--t-16);
    box-shadow: var(--sh-2); user-select: none; touch-action: none;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .seal-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  .seal-btn.holding { transform: translateY(1px) scale(.99); box-shadow: var(--sh-1); }
  .seal-btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
  .env { width: 44px; height: 32px; flex: none; }
  .env rect, .env .flap { fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
  /* the wax: the ring draws shut with the hold; the core is the hatch, the one mark of a shielded thing */
  .wax .ring { fill: none; stroke: currentColor; stroke-width: 2.5; transform: rotate(-90deg); }
  .wax .core { fill: currentColor; }
  .small { font-size: var(--t-14); max-width: 44ch; margin-top: var(--s-2); }
</style>
