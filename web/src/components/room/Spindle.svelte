<script lang="ts">
  import type { Epoch } from '../../lib/types'
  import { zec, ago } from '../../lib/format'
  import { reducedMotion } from '../../lib/motion'
  import { lookAngle } from '../../lib/palMove'
  import Postmark from '../Postmark.svelte'

  // The spindle: every payout round as a paper slip on a stack, the latest on top at full size.
  // This is the product's mechanism in the first frame: paid receipts, piled up, one more every
  // round. The stack is real (one slip per round the engine reports, capped at 13 visible), the
  // numbers are the round's own, and the drop choreography plays once on entrance. The mascot
  // peeks from behind the pile, whole object, pixels untouched.
  let { epochs, now, newSince = false, paidLine = null, animate = true }: {
    epochs: Epoch[] | null
    now: number
    newSince?: boolean
    /** R3, payout-as-event: "You were paid N ZEC this round", set by the page when the connected wallet is in the newest round. */
    paidLine?: string | null
    /** The drop plays on the session's first arrival only; later visits find the pile settled. */
    animate?: boolean
  } = $props()

  const MAX = 13
  // oldest first so the newest lands last and ends on top
  const stack = $derived(epochs ? [...epochs].slice(0, MAX).reverse() : null)
  const top = $derived(epochs?.[0] ?? null)
  const numberOf = (id: string): number => (epochs ? epochs.length - epochs.findIndex((e) => e.id === id) : 0)
  const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  const stampDate = (iso: string) => when(iso).toUpperCase()

  // seeded placement: the same round always sits at the same angle, like a pile nobody tidied
  function seat(id: string, i: number, n: number): { r: number; x: number; y: number } {
    let h = 7
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
    const r = ((h % 100) / 100 - 0.5) * 4 // -2deg to 2deg: enough to read as a pile, not enough to spill corners
    const back = n - 1 - i // 0 = top
    return { r: i === n - 1 ? -1.2 : r, x: (((h >> 3) % 100) / 100 - 0.5) * 12, y: -back * 6 }
  }

  // the drop: each slip falls in once, oldest first, newest last; the stamp pops after the top slip lands.
  // A slip created later (a round landing mid-session) still drops: `animate` only gates the opening scene,
  // and a mid-session slip is new by definition.
  const still = $derived(reducedMotion() || !animate)
  let opened = false
  $effect(() => { if (stack) opened = true })
  // the figure behind the pile: it ducks out of sight, comes up somewhere else along the slip's top edge, and leans toward the pointer
  let ducked = $state(false)
  let slide = $state(0)
  let tilt = $state(0)
  let popping = $state(false)
  let scene = $state<HTMLElement>()
  $effect(() => {
    if (reducedMotion() || !stack || stack.length === 0) return
    let dead = false
    let t: ReturnType<typeof setTimeout> | undefined
    const later = (fn: () => void, ms: number) => { t = setTimeout(() => { if (!dead) fn() }, ms) }
    const loop = () => later(() => {
      ducked = true
      later(() => {
        slide = Math.round((Math.random() * 2 - 1) * 70)
        ducked = false; popping = true
        later(() => { popping = false; loop() }, 560)
      }, 1000)
    }, 7000 + Math.random() * 7000)
    later(loop, 1800)
    return () => { dead = true; clearTimeout(t); ducked = false; popping = false }
  })
  $effect(() => {
    if (reducedMotion() || !scene) return
    let raf = 0
    const move = (e: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!scene) return
        const r = scene.getBoundingClientRect()
        tilt = lookAngle(e.clientX - (r.left + 80 + slide), e.clientY - (r.top - 40), 280, 9)
      })
    }
    addEventListener('pointermove', move, { passive: true })
    return () => { removeEventListener('pointermove', move); cancelAnimationFrame(raf) }
  })
  function drop(el: HTMLElement, p: { i: number; n: number; r: number }) {
    if (reducedMotion() || (!animate && !opened)) return
    el.animate(
      [
        { transform: `translateY(-54vh) rotate(${p.r - 7}deg)`, opacity: '0' },
        { transform: `translateY(6px) rotate(${p.r + 1.1}deg)`, opacity: '1', offset: 0.72 },
        { transform: `translateY(0) rotate(${p.r}deg)`, opacity: '1' },
      ],
      { duration: 620, delay: 120 + p.i * 65, easing: 'cubic-bezier(.2, .9, .3, 1)', fill: 'backwards' },
    )
  }
</script>

<div class="scene" bind:this={scene}>
  {#if stack === null}
    <div class="skel" style="height: 380px; width: min(400px, 86vw)" aria-busy="true" role="status" aria-label="Loading the payout rounds"></div>
  {:else if stack.length === 0}
    <p class="muted">The first round's receipt lands here once it pays.</p>
  {:else}
    <div class="mascot" class:ducked class:popping class:still style:--slide="{slide}px" aria-hidden="true">
      <div class="lean" style:transform="rotate({tilt}deg)"><img src="/mascot-cut.webp" alt="" width="96" height="138" draggable="false" /></div>
    </div>
    <!-- a group, not an image: the top slip is a real link and must stay reachable to AT -->
    <div class="pile" role="group" aria-label="{stack.length} payout round receipts, newest on top">
      {#each stack as e, i (e.id)}
        {@const p = seat(e.id, i, stack.length)}
        {#if i < stack.length - 1}
          <span class="slip under" use:drop={{ i, n: stack.length, r: p.r }} style:transform="rotate({p.r}deg)" style:--x="{p.x}px" style:--y="{p.y}px" aria-hidden="true"></span>
        {:else}
          <a class="slip topslip" href="#/treasury" use:drop={{ i, n: stack.length, r: p.r }} style:transform="rotate({p.r}deg)">
            <span class="tape ta" aria-hidden="true"></span>
            <span class="tape tb" aria-hidden="true"></span>
            <span class="s-head"><span class="rnd">Round #{numberOf(e.id)}</span><span class="muted s-ago">{ago(e.at, now)}</span>{#if newSince}<span class="chip">New since your last visit</span>{/if}</span>
            <span class="s-line"><span class="label">Claimed</span><span class="mono">{zec(e.harvestedZats)} ZEC</span></span>
            <span class="s-line"><span class="label">Paid to holders</span><span class="mono">{zec(e.split.holdersZats)} ZEC &rarr; {e.solanaPayouts.count + e.shielded.count} wallets</span></span>
            <span class="s-line shd" class:none={e.shielded.count === 0}>
              <span class="label"><span class="key hatch" aria-hidden="true"></span>Shielded</span>
              <span class="mono">{e.shielded.count === 0 ? 'none this round' : `${zec(e.shielded.totalZats)} ZEC to ${e.shielded.count}`}</span>
            </span>
            {#if paidLine}<span class="you">{paidLine}</span>{/if}
            <span class="s-go">Every round, with its transactions &rarr;</span>
            {#if e.solanaPayouts.sigs.length > 0 && e.shielded.zcashTxids.length > 0}
              <span class="stamp" class:pop={!still}><Postmark n={numberOf(e.id)} date={stampDate(e.at)} /></span>
            {/if}
          </a>
        {/if}
      {/each}
    </div>
    <p class="count muted">{stack.length === MAX && epochs && epochs.length > MAX ? `${epochs.length} rounds on the pile, ` : `${stack.length} ${stack.length === 1 ? 'round' : 'rounds'}, `}every one on chain.</p>
  {/if}
</div>

<style>
  .scene { position: relative; display: grid; gap: var(--s-3); justify-items: center; }
  .pile { position: relative; width: min(380px, 100%); }
  /* the slips behind: torn-edged paper showing above the top slip, each at its seeded angle */
  .slip {
    background: var(--paper-2); border-radius: var(--r-xs);
    box-shadow: var(--sh-2), inset 0 1px 0 light-dark(transparent, rgba(239, 231, 218, .07));
  }
  .under {
    /* a touch narrower and shorter than the top slip, so a rotated corner can peek at the top
       and sides but never hang below it like debris */
    position: absolute; inset: 2px 6px 10px; z-index: 0;
    translate: var(--x) var(--y);
    transition: translate var(--d-fn) var(--ease);
    /* a torn top edge where it peeks out over the slip above it on the pile */
    clip-path: polygon(0 0, 4% 1.2%, 9% 0.3%, 15% 1.6%, 22% 0.5%, 30% 1.4%, 38% 0.2%, 47% 1.5%, 55% 0.4%, 63% 1.3%, 71% 0.3%, 79% 1.5%, 86% 0.5%, 93% 1.3%, 100% 0, 100% 100%, 0 100%);
  }
  .topslip {
    position: relative; z-index: 2; display: grid; gap: var(--s-2);
    padding: var(--s-5); padding-right: calc(var(--s-5) + 84px);
    text-decoration: none; color: inherit;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  /* a hand over the pile: the top slip lifts and the slips beneath fan out a little, like paper would */
  @media (hover: hover) {
    .topslip:hover { transform: rotate(-1.2deg) translateY(-3px) !important; box-shadow: var(--sh-3); }
    .pile:hover .under { translate: calc(var(--x) * 1.8) calc(var(--y) * 1.25); }
  }
  .tape { position: absolute; width: 76px; height: 24px; top: -11px; background: rgba(236, 222, 190, .82); box-shadow: 0 1px 0 rgba(43, 36, 32, .12); z-index: 3; }
  .ta { left: 38%; transform: rotate(-7deg); }
  .tb { right: 10%; transform: rotate(5deg); }
  .s-head { display: flex; align-items: baseline; gap: var(--s-3); flex-wrap: wrap; }
  .rnd { font-family: var(--f-display); font-size: clamp(26px, 2.2vw, 32px); line-height: 1; }
  .s-ago { font-size: var(--t-14); }
  .s-line { display: flex; justify-content: space-between; gap: var(--s-3); font-size: var(--t-14); border-bottom: 1px dashed var(--line); padding-bottom: var(--s-1); }
  .s-line .label { display: flex; align-items: center; gap: var(--s-1); }
  .key { display: inline-block; width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }
  .shd.none .key { background: var(--line); }
  .you { font-weight: 700; font-size: var(--t-14); background: var(--paper-3); border-radius: var(--r-sm); padding: var(--s-1) var(--s-2); justify-self: start; }
  .s-go { font-weight: 700; font-size: var(--t-14); margin-top: var(--s-1); }
  .stamp { position: absolute; right: 4px; top: 8px; z-index: 3; pointer-events: none; }
  .stamp.pop { animation: pop 300ms var(--ease) 1.05s backwards; }
  @keyframes pop { from { transform: rotate(-9deg) scale(1.5); opacity: 0; } }
  /* the mascot genuinely peeks: its body sits BEHIND the top slip (z 1 under the slip's 2), only the head and horns rise over the
     paper's edge. The drawing is the pad's one cutout, moved as a whole: slid, tilted, squashed, never altered. */
  .mascot {
    position: absolute; z-index: 1; width: 96px; height: 138px; left: calc(16px + var(--slide, 0px)); top: -94px; pointer-events: none;
    filter: drop-shadow(0 2px 0 rgba(43, 36, 32, .2));
    transition: transform 380ms var(--ease), left 0ms;
    animation: peek 900ms var(--ease) both;
  }
  .mascot.ducked { transform: translateY(120px); transition: transform 240ms ease-in; }
  .lean { width: 100%; height: 100%; transform-origin: 50% 100%; transition: transform 300ms var(--ease); }
  .lean img { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; animation: sway 14s ease-in-out 1.4s infinite; }
  .mascot.popping .lean img { animation: pop 560ms var(--ease); }
  @keyframes peek { from { transform: translateY(60px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes sway { 0%, 100% { rotate: 0deg; } 50% { rotate: -2deg; } }
  @keyframes pop { 0% { transform: scale(.92, 1.1); } 55% { transform: scale(1.06, .94); } 100% { transform: scale(1, 1); } }
  .mascot.still, .mascot.still .lean img { animation: none; }
  @media (prefers-reduced-motion: reduce) { .mascot, .mascot .lean img { animation: none; transition: none; } .stamp.pop { animation: none; } }
  /* this line sits on the enamel, inside a paper-pinned subtree: it takes the door's ink, not the paper's */
  .count { font-size: var(--t-14); color: light-dark(#564e46, #bdb2a4); }
  @media (max-width: 640px) {
    .topslip { padding-right: var(--s-5); padding-top: calc(var(--s-5) + 26px); }
    .stamp { top: -12px; right: 6px; }
    .stamp :global(.pm) { width: 64px; height: 64px; }
    .mascot { width: 76px; height: 109px; left: calc(12px + var(--slide, 0px) * .4); top: -72px; }
  }
</style>
