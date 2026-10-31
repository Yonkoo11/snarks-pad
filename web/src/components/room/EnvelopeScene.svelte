<script lang="ts">
  // The shielded opt-in's envelope, with Snarks living in it. Every pose is a fact about the flow (lib/envelope.ts): only the horns show
  // until a wallet is connected, it stands higher once a valid Zcash address is pasted, your own hold on the seal lifts it, a pending
  // request keeps it halfway, a refusal ducks it in and pulls the flap shut, and only the pad's confirmation lets it out: it leaps onto the
  // top of the envelope, the flap shuts behind it and the wax goes on. While it waits it plays: it ducks inside, comes up somewhere else in
  // the mouth of the envelope, and leans toward the pointer. The envelope is drawn here; the figure is the pad's one drawing, only moved
  // as a whole. The seal's hatching is the pink that marks shielded things, and nothing else.
  import { envelopePose, type EnvState } from '../../lib/envelope'
  import { planHop, pathFrames, bodyFrames, lookAngle } from '../../lib/palMove'
  import { reducedMotion } from '../../lib/motion'

  const { flow }: { flow: EnvState } = $props()
  const W = 220, ENV_H = 165, MW = 64, MH = Math.round((64 * 373) / 260), POCKET = 92, FLAP_TOP = 62
  const pose = $derived(envelopePose(flow))

  let who = $state<HTMLDivElement>()
  let img = $state<HTMLImageElement>()
  let root = $state<HTMLDivElement>()
  let ducked = $state(false)
  let offsetX = $state(0)
  let near = $state(false)
  let tilt = $state(0)
  // arriving with the opt-in already confirmed (the page was revisited): it simply stands on the sealed envelope
  // svelte-ignore state_referenced_locally
  let landed = $state(flow.done) // after the leap: the flap may shut and the wax go on
  // svelte-ignore state_referenced_locally
  let front = $state(flow.done) // the figure is in front of the pocket (after it has left the envelope)
  let popping = $state(false)

  // ---- where it stands in the envelope: how much of it shows above the pocket's edge
  const rise = $derived(flow.done ? 1 : ducked ? 0 : Math.min(0.92, pose.rise + (near && (pose.mood === 'wait' || pose.mood === 'ready') ? 0.1 : 0)))
  const sitting = $derived(flow.done && landed)
  const left = $derived(W / 2 - MW / 2 + (flow.done ? 0 : offsetX))
  const top = $derived(flow.done ? FLAP_TOP - MH + 8 : POCKET - rise * MH * 0.86)
  // the flap stays open through the leap, then shuts behind it
  const flap = $derived(flow.done ? (landed ? 0 : 1) : pose.flap)
  const frontFlap = $derived(Math.max(0, 1 - 2 * flap)) // 1 closed .. 0 on its edge
  const backFlap = $derived(Math.max(0, 2 * flap - 1)) // 0 .. 1 open, pointing up behind the figure
  const sealed = $derived(flow.done && landed)

  // ---- the leap out: it rises from inside to the top of the envelope on one arc, with the same squash and stretch as the companion's hops
  // the mark the effect below compares against: the state at arrival
  // svelte-ignore state_referenced_locally
  let wasDone = flow.done
  $effect(() => {
    const done = flow.done
    if (done === wasDone) return
    wasDone = done
    if (!done) { landed = false; front = false; return }
    if (reducedMotion() || !who || !img) { landed = true; front = true; return }
    // from where it was (halfway up, behind the pocket) to where it now stands (on top, in front)
    const from = { x: 0, y: POCKET - 0.5 * MH * 0.86 - (FLAP_TOP - MH + 8) }
    const plan = planHop(from, { x: 0, y: 0 })
    plan.mid.y -= 18
    const a = who.animate(pathFrames(plan), { duration: plan.dur + 150, easing: 'linear' })
    img.animate(bodyFrames(plan), { duration: plan.dur + 150, easing: 'linear' })
    setTimeout(() => { front = true }, 240) // it clears the pocket's edge before it is drawn in front of it
    a.finished.then(() => { landed = true }, () => { landed = true })
  })

  // ---- while it waits, it plays: ducks in, comes up somewhere else in the mouth of the envelope
  $effect(() => {
    const mood = pose.mood
    if (reducedMotion() || (mood !== 'wait' && mood !== 'ready')) { ducked = false; return }
    let dead = false
    let t: ReturnType<typeof setTimeout> | undefined
    const later = (fn: () => void, ms: number) => { t = setTimeout(() => { if (!dead) fn() }, ms) }
    const loop = () => later(() => {
      ducked = true
      later(() => {
        offsetX = Math.round((Math.random() * 2 - 1) * 34)
        ducked = false; popping = true
        later(() => { popping = false; loop() }, 520)
      }, 950)
    }, 6500 + Math.random() * 6500)
    loop()
    return () => { dead = true; clearTimeout(t); ducked = false; popping = false }
  })
  // ---- and leans toward the pointer when it is near
  $effect(() => {
    if (reducedMotion() || !root) return
    let raf = 0
    const move = (e: PointerEvent) => {
      if (raf || !root) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!root) return
        const r = root.getBoundingClientRect()
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2)
        near = Math.hypot(dx, dy) < 230
        tilt = lookAngle(dx, dy, 260, 9)
      })
    }
    addEventListener('pointermove', move, { passive: true })
    return () => { removeEventListener('pointermove', move); cancelAnimationFrame(raf) }
  })
</script>

<div class="env" class:duck={pose.mood === 'duck'} class:hold={pose.mood === 'hold'} bind:this={root} style:width="{W}px" style:height="{ENV_H}px" aria-hidden="true">
  <!-- behind the figure: the back of the envelope and its open flap -->
  <svg class="layer" viewBox="0 0 {W} {ENV_H}" width={W} height={ENV_H}>
    <polygon class="flap-open" points="4,{FLAP_TOP} {W - 4},{FLAP_TOP} {W / 2},118" style:transform="scaleY({-backFlap})" style:transform-origin="0 {FLAP_TOP}px" />
    <rect class="back" x="4" y={FLAP_TOP} width={W - 8} height={ENV_H - FLAP_TOP - 6} rx="4" />
  </svg>

  <!-- the figure, between the back and the pocket -->
  <div class="who" class:front class:popping bind:this={who} style:left="{left}px" style:top="{top}px" style:width="{MW}px" style:height="{MH}px">
    <div class="tilt" style:transform="rotate({sitting ? 0 : tilt}deg)"><img bind:this={img} src="/mascot-cut.webp" alt="" width={MW} height={MH} draggable="false" /></div>
  </div>

  <!-- in front: the pocket, its creases, the shut flap and the wax -->
  <svg class="layer pocket" viewBox="0 0 {W} {ENV_H}" width={W} height={ENV_H}>
    <defs>
      <pattern id="env-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(-55)"><rect width="3" height="6" fill="var(--pink)" /></pattern>
    </defs>
    <rect class="front-panel" x="4" y={POCKET} width={W - 8} height={ENV_H - POCKET - 6} rx="4" />
    <path class="crease" d="M4 {ENV_H - 8} L{W / 2} 118 L{W - 4} {ENV_H - 8}" />
    <polygon class="flap-closed" points="4,{FLAP_TOP} {W - 4},{FLAP_TOP} {W / 2},118" style:transform="scaleY({frontFlap})" style:transform-origin="0 {FLAP_TOP}px" />
    {#if sealed}<g class="wax"><circle cx={W / 2} cy="112" r="13" class="wax-base" /><circle cx={W / 2} cy="112" r="13" class="wax-hatch" /></g>{/if}
  </svg>
</div>

<style>
  .env { position: relative; margin-top: 40px; flex: none; }
  .layer { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
  .back { fill: var(--paper-3); stroke: var(--ink); stroke-width: 2; }
  .front-panel { fill: var(--paper-2); stroke: var(--ink); stroke-width: 2; }
  .crease { fill: none; stroke: var(--ink-3); stroke-width: 1.5; stroke-linejoin: round; }
  .flap-open, .flap-closed { fill: var(--paper-2); stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; transition: transform 240ms ease-in; }
  .flap-open { transition: transform 240ms ease-out 220ms; fill: var(--paper-3); }
  .wax-base { fill: var(--pink-soft); } .wax-hatch { fill: url(#env-hatch); stroke: var(--pink); stroke-width: 2; }
  .wax { animation: stamp 320ms var(--ease) backwards; transform-origin: 110px 112px; }
  @keyframes stamp { from { transform: scale(1.5); opacity: 0; } }
  .who { position: absolute; z-index: 2; transition: top 420ms var(--ease), left 420ms var(--ease); pointer-events: none; filter: drop-shadow(0 2px 0 rgba(43, 36, 32, .2)); }
  .hold .who { transition: top 140ms linear; }
  .who.front { z-index: 4; }
  .who.popping .tilt { animation: pop 520ms var(--ease); }
  .tilt { width: 100%; height: 100%; transform-origin: 50% 100%; transition: transform 300ms var(--ease); }
  .tilt img { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; }
  .pocket { z-index: 3; }
  .duck .who { transition: top 200ms ease-in; }
  .duck { animation: shake 360ms ease-in-out; }
  @keyframes pop { 0% { transform: scale(.92, 1.1); } 55% { transform: scale(1.06, .94); } 100% { transform: scale(1, 1); } }
  @keyframes shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-4px); } 40% { transform: translateX(4px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } }
  @media (prefers-reduced-motion: reduce) { .who, .hold .who, .duck .who, .tilt, .flap-open, .flap-closed { transition: none; } .duck, .wax, .who.popping .tilt { animation: none; } }
</style>
