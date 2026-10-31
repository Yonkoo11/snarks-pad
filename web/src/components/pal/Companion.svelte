<script lang="ts">
  // Snarks, the pad's mascot, living on the page (docs/COMPANION.md is the design). One drawing, moved only as a whole: it hops between
  // the top edges of real things (cards, headings, ledger rows), breathes while it stands, tilts toward the pointer, dozes when nothing
  // happens, and can be picked up and dropped on a coin to follow it. Motion is free; speech is fact: every line it says is a number or
  // a time the pad holds, and it reacts only to real events (a round paid, a coin graduated, a followed coin grew, its creator sold).
  // It never covers a control, never moves while you type or while a sheet or the palette is open, stays put on a phone and with reduced
  // motion, and can be sent away.
  import { api } from '../../lib/api'
  import type { CoinDetail, Epoch, Treasury } from '../../lib/types'
  import { pal } from '../../lib/pal.svelte'
  import { layers } from '../../lib/layers.svelte'
  import { router } from '../../lib/router.svelte'
  import { reducedMotion } from '../../lib/motion'
  import { poll } from '../../lib/poll'
  import { countdown, ago } from '../../lib/format'
  import { isWatched, lookDelta, snapOf, toggleWatch, watched } from '../../lib/looked'
  import { planHop, pathFrames, bodyFrames, waveFrames, cheerFrames, alertFrames, springStep, lookAngle } from '../../lib/palMove'
  import { newRound, newGraduations, holdersGained, creatorSell } from '../../lib/palEvents'
  import { poseSrc, type PoseName } from '../../lib/palPoses'

  const W = 70, H = Math.round((70 * 373) / 260) // the drawing's own proportions
  let host = $state<HTMLDivElement>()
  let body = $state<HTMLImageElement>()
  let lookEl = $state<HTMLDivElement>()
  let line = $state<string | null>(null)
  let bubbleSide = $state<'mid' | 'left' | 'right'>('mid')
  let doze = $state(false)
  let deep = $state(false)
  let dragging = $state(false)
  let shown = $state(false)
  let menu = $state(false)
  let pose = $state<PoseName>('stand')

  // ---- what it knows
  let epochs = $state<Epoch[]>([])
  let treasury = $state<Treasury | null>(null)
  let followed = $state<CoinDetail | null>(null)
  const visitStart = Date.now()
  let seenRound: string | null = null
  const announcedGrads = new Set<string>()
  let announcedHolders: number | null = null
  let sellMark = Date.now()

  const phone = () => matchMedia('(max-width: 800px)').matches
  const still = () => reducedMotion() || phone()
  const away = $derived(pal.mode === 'away')

  // ---- where it stands: page coordinates inside #app, so scrolling carries it without a line of script
  let cur = { x: 0, y: 0 }
  let origin = { x: 0, y: 0 }
  let perch: { el: Element; dx: number } | null = null
  const measureOrigin = () => { const r = (host?.offsetParent as HTMLElement | null)?.getBoundingClientRect(); origin = r ? { x: r.left + scrollX, y: r.top + scrollY } : { x: 0, y: 0 } }
  const put = (p: { x: number; y: number }) => { cur = p; if (host) host.style.transform = `translate(${p.x}px, ${p.y}px)` }
  const toPage = (x: number, y: number) => ({ x: x + scrollX - origin.x, y: y + scrollY - origin.y })

  // ---- places to stand: the top edge of a real element with nothing clickable under the figure (every clickable box is checked)
  const ANCHORS = 'main h1, main .panel, main .card, main .cardcell, main .tc, main .ms, main .strip, main .bs, main .drow, [data-perch]'
  const CLICKABLE = 'a, button, input, select, textarea, summary, canvas, [role="button"], [role="tab"], [role="dialog"]'
  // text, pictures and drawings are content: the figure may stand over empty paper, not over words
  const CONTENT = 'img, svg, canvas, video, input, textarea, select'
  const isContent = (n: Element) => n.matches(CONTENT) || [...n.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== '')
  function blocked(left: number, top: number, except: Element): boolean {
    const a = { l: left - 6, t: top - 2, r: left + W + 6, b: top + H - 12 } // the figure's box, a little generous, its feet excluded
    for (const n of document.querySelectorAll(CLICKABLE)) {
      if (n === except || n.contains(except) || host?.contains(n)) continue
      const r = n.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < a.r && r.right > a.l && r.top < a.b && r.bottom > a.t) return true
    }
    // a grid of points across the figure: at most a few may land on content
    let onContent = 0
    for (let i = 0; i < 5; i++) for (let j = 0; j < 6; j++) {
      const x = left + (W * (i + 0.5)) / 5, y = top + ((H - 14) * (j + 0.5)) / 6
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
      if (document.elementsFromPoint(x, y).some((n) => n !== except && !n.contains(except) && !host?.contains(n) && isContent(n))) onContent++
    }
    return onContent > 3
  }
  function spotAt(el: Element, dx: number): { x: number; y: number } | null {
    const r = el.getBoundingClientRect()
    const left = r.left + dx, top = r.top - H + 4
    if (r.width < W + 60 || r.top < 96 || r.top > innerHeight - 40 || dx < 8 || dx > r.width - W - 8) return null
    if (blocked(left, top, el)) return null
    return toPage(left, top)
  }
  // when no edge is free it hovers in empty paper (it has wings): a spot with nothing under it, found by trying places across the screen
  function freeSpot(): { x: number; y: number } | null {
    for (let i = 0; i < 40; i++) {
      const left = 8 + Math.random() * Math.max(0, innerWidth - W - 16)
      const top = 104 + Math.random() * Math.max(0, innerHeight - H - 190)
      if (blocked(left, top, document.body)) continue
      const p = toPage(left, top)
      if (Math.hypot(p.x - cur.x, p.y - cur.y) > 120) return p
    }
    return null
  }
  let visits = 0
  type Spot = { el: Element | null; dx: number; x: number; y: number }
  function pick(): Spot | null {
    const home = pal.adopted ? document.querySelector(`[data-coin-mint="${pal.adopted}"]`) : null
    const pool = [...document.querySelectorAll(ANCHORS)].sort(() => Math.random() - 0.5)
    const ledges = (): Spot | null => {
      for (const el of [...(home && Math.random() < 0.5 ? [home] : []), ...pool]) {
        const r = el.getBoundingClientRect()
        const dx = 20 + ((Math.sin(++visits * 9301 + 49297) + 1) / 2) * Math.max(0, r.width - W - 40)
        const s = spotAt(el, dx)
        if (s && Math.hypot(s.x - cur.x, s.y - cur.y) > 80) return { el, dx, ...s }
      }
      return null
    }
    const free = (): Spot | null => { const f = freeSpot(); return f ? { el: null, dx: 0, ...f } : null }
    return Math.random() < 0.55 ? ledges() ?? free() : free() ?? ledges()
  }

  // ---- motion
  async function hop(to: { x: number; y: number }, slow = false): Promise<void> {
    if (!host || !body) return
    if (still()) { put(to); return }
    const plan = planHop(cur, to, slow)
    const path = host.animate(pathFrames(plan), { duration: plan.dur, easing: 'cubic-bezier(.3,.1,.3,1)' })
    body.animate(bodyFrames(plan), { duration: plan.dur, easing: 'ease-in-out' })
    try { await path.finished } catch { /* a newer move took over */ }
    put(to)
  }
  let hovering = $state(false)
  async function hopTo(s: { el: Element | null; dx: number; x: number; y: number }) { perch = s.el ? { el: s.el, dx: s.dx } : null; hovering = !s.el; await hop(s) }
  async function play(kind: 'wave' | 'cheer' | 'alert') {
    if (!body || still()) return
    pose = kind === 'wave' ? 'stand' : kind
    const frames = kind === 'wave' ? waveFrames() : kind === 'cheer' ? cheerFrames() : alertFrames()
    const a = body.animate(frames, { duration: kind === 'wave' ? 900 : kind === 'cheer' ? 1200 : 1400, easing: 'ease-in-out' })
    try { await a.finished } catch { /* cancelled */ }
    pose = 'stand'
  }

  // ---- what it can say: facts, nearest first
  function facts(): string {
    const m = pal.adopted
    if (m && followed) {
      const d = lookDelta(watched()[m] ?? null, snapOf(followed))
      return `$${followed.symbol}: ${d.length ? d.join(', ') : 'no change'} since you followed it.`
    }
    const next = treasury?.nextEpochAt
    if (next && Date.parse(next) > Date.now()) return `The next round pays in ${countdown(next, Date.now())}.`
    const last = epochs[0]
    if (last) return `Round ${epochs.length} paid ${last.solanaPayouts.count + last.shielded.count} wallets, ${ago(last.at)}.`
    return 'No round has paid yet.'
  }
  let sayTimer: ReturnType<typeof setTimeout> | undefined
  function say(text: string) {
    if (host) { const x = host.getBoundingClientRect().left; bubbleSide = x < 140 ? 'left' : x > innerWidth - 260 ? 'right' : 'mid' }
    line = text; clearTimeout(sayTimer); sayTimer = setTimeout(() => (line = null), 5400)
  }
  $effect(() => { if (pal.say) { say(pal.say); pal.say = null } })

  // ---- real events: each is queued and played when nothing else is going on
  const queue: (() => Promise<void>)[] = []
  let playing = false
  const busy = () => !!layers.top || document.hidden || !!document.querySelector('.slip[role="dialog"]') || (document.activeElement instanceof HTMLElement && !!document.activeElement.closest('input, textarea, select, [contenteditable]'))
  async function drain() {
    if (playing || busy() || queue.length === 0 || pal.mode === 'away') return
    playing = true
    try { await queue.shift()!() } finally { playing = false }
  }
  const homeSpot = () => { const el = pal.adopted ? document.querySelector(`[data-coin-mint="${pal.adopted}"]`) : null; if (!el) return null; const r = el.getBoundingClientRect(); const dx = Math.min(Math.max(20, r.width * 0.3), Math.max(20, r.width - W - 20)); const s = spotAt(el, dx); return s ? { el, dx, ...s } : null }
  const react = (kind: 'wave' | 'cheer' | 'alert', text: string, goHome = false) => queue.push(async () => {
    measureOrigin()
    if (goHome && !still()) { const h = homeSpot(); if (h) await hopTo(h) }
    say(text); await play(kind)
  })

  $effect(() => poll(async () => {
    const [e, t] = await Promise.all([api.epochs().catch(() => null), api.treasury().catch(() => null)])
    if (t) treasury = t
    if (e) {
      epochs = e.epochs
      const hit = newRound(seenRound, e.epochs)
      seenRound = e.epochs[0]?.id ?? seenRound
      if (hit) react('wave', `Round ${hit.n} paid ${hit.paid} ${hit.paid === 1 ? 'wallet' : 'wallets'}.`)
    }
  }, 60_000))
  $effect(() => poll(async () => {
    const r = await api.coins({ stage: 'graduated', limit: 20 }).catch(() => null)
    if (!r) return
    for (const c of newGraduations(r.coins, visitStart, announcedGrads)) { announcedGrads.add(c.mint); react('cheer', `$${c.symbol} graduated to Meteora.`) }
  }, 60_000))
  const adoptedMint = $derived(pal.adopted)
  $effect(() => {
    const m = adoptedMint
    followed = null; announcedHolders = null; sellMark = Date.now()
    if (!m) return
    const stopA = poll(async () => {
      const c = await api.coin(m).catch(() => null)
      if (!c || adoptedMint !== m) return
      followed = c
      const gained = holdersGained(announcedHolders, c.holders)
      announcedHolders = c.holders ?? announcedHolders
      if (gained) react('wave', `$${c.symbol}: +${gained} ${gained === 1 ? 'holder' : 'holders'}.`, true)
    }, 30_000)
    const stopB = poll(async () => {
      const r = await api.trades({ mint: m, limit: 15 }).catch(() => null)
      const s = r ? creatorSell(r.trades, sellMark) : null
      if (s) { sellMark = Date.parse(s.at); react('alert', `Creator sold on $${s.symbol}.`, true) }
    }, 30_000)
    return () => { stopA(); stopB() }
  })

  // ---- the life: arrive, stand, hop on, doze when nothing happens
  let lastActive = Date.now()
  const poke = () => { lastActive = Date.now(); if (doze || deep) { doze = false; deep = false } }
  $effect(() => {
    if (away || !host) return
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (ms: number) => new Promise<void>((res) => { timer = setTimeout(res, ms) })
    measureOrigin()
    ;(async () => {
      await wait(1500)
      const first = phone() ? null : pick()
      if (!first) { cornerStay(); shown = true; return }
      put({ x: innerWidth + 40, y: first.y }); shown = true
      await hopTo(first)
      while (!dead) {
        await wait(7000 + Math.random() * 7000)
        if (dead || pal.mode !== 'roam') continue
        await drain()
        if (busy()) continue
        const idle = Date.now() - lastActive
        if (idle > 120_000) { deep = true; continue }
        if (idle > 24_000) { doze = true; continue }
        measureOrigin()
        const next = pick()
        if (next) await hopTo(next)
      }
    })()
    // every two seconds: is the footing still good (images loading, a panel opening move the page under it)?
    const foot = setInterval(async () => {
      if (dragging || playing || still() || pal.mode === 'away') { void drain(); return }
      if (!perch) { // hovering: no edge to keep, but the page may have moved a control under it
        measureOrigin()
        if (hovering && blocked(cur.x + origin.x - scrollX, cur.y + origin.y - scrollY, document.body)) { const n = pick(); if (n) await hopTo(n) }
        void drain(); return
      }
      if (!perch.el.isConnected) { const n = pick(); if (n) await hopTo(n); return }
      measureOrigin()
      const s = spotAt(perch.el, perch.dx)
      if (!s) { const n = pick(); if (n) await hopTo(n); return }
      if (Math.hypot(s.x - cur.x, s.y - cur.y) > 8) await hop(s)
      void drain()
    }, 2000)
    const onResize = () => { measureOrigin(); if (still()) cornerStay() }
    addEventListener('resize', onResize)
    for (const ev of ['pointermove', 'keydown', 'scroll', 'pointerdown'] as const) addEventListener(ev, poke, { passive: true })
    return () => { dead = true; clearTimeout(timer); clearInterval(foot); removeEventListener('resize', onResize); for (const ev of ['pointermove', 'keydown', 'scroll', 'pointerdown'] as const) removeEventListener(ev, poke) }
  })
  // phone and reduced motion: it stands at the foot of the screen, above the tape's line
  function cornerStay() {
    measureOrigin()
    perch = null
    put(toPage(8, innerHeight - H - (phone() ? 112 : 24)))
  }
  // a new page: where it stood may be gone
  $effect(() => { void router.route; if (!host || away) return; const t = setTimeout(() => { measureOrigin(); if (!still()) { const n = pick(); if (n) void hopTo(n) } else cornerStay() }, 900); return () => clearTimeout(t) })

  // ---- it looks toward the pointer: attention without eyes (the whole figure tilts a few degrees)
  $effect(() => {
    if (away) return
    let raf = 0
    const onMove = (e: PointerEvent) => {
      if (raf || dragging || still() || !host || !lookEl) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!host || !lookEl) return
        const r = host.getBoundingClientRect()
        lookEl.style.setProperty('--look', `${lookAngle(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)).toFixed(2)}deg`)
      })
    }
    addEventListener('pointermove', onMove, { passive: true })
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(raf) }
  })

  // ---- pick it up: a press says something true; a drag carries it (it swings from the pointer on a spring) and a coin under it is followed
  let down: { x: number; y: number; moved: boolean; dx: number; dy: number; t: number } | null = null
  let over: Element | null = null
  let swing = { pos: 0, vel: 0 }, lastX = 0, lastT = 0, vx = 0, carryRaf = 0
  let press: ReturnType<typeof setTimeout> | undefined
  function carryLoop(t: number) {
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000); lastT = t
    swing = springStep(swing.pos, swing.vel, Math.max(-26, Math.min(26, -vx * 0.05)), dt)
    vx *= 0.9
    if (body) body.style.transform = `rotate(${swing.pos.toFixed(2)}deg)`
    if (dragging || Math.abs(swing.pos) > 0.2 || Math.abs(swing.vel) > 1) carryRaf = requestAnimationFrame(carryLoop)
    else { if (body) body.style.transform = ''; carryRaf = 0 }
  }
  function onDown(e: PointerEvent) {
    if (!host || e.button === 2) return
    measureOrigin()
    down = { x: e.clientX, y: e.clientY, moved: false, dx: e.clientX + scrollX - origin.x - cur.x, dy: e.clientY + scrollY - origin.y - cur.y, t: Date.now() }
    host.setPointerCapture(e.pointerId); doze = false; deep = false; lastX = e.clientX
    press = setTimeout(() => { if (down && !down.moved) { down = null; menu = true } }, 650)
  }
  function onMove(e: PointerEvent) {
    if (!down || !host) return
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 7) return
    if (!down.moved) { clearTimeout(press); menu = false; line = null; perch = null; host.getAnimations().forEach((a) => a.cancel()) }
    down.moved = true; dragging = true
    vx = (e.clientX - lastX) * 60; lastX = e.clientX
    if (!carryRaf && !still()) { lastT = 0; carryRaf = requestAnimationFrame(carryLoop) }
    put({ x: e.clientX + scrollX - origin.x - down.dx, y: e.clientY + scrollY - origin.y - down.dy })
    const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n !== host && !host!.contains(n) && n.closest('[data-coin-mint]'))?.closest('[data-coin-mint]') ?? null
    if (hit !== over) { over?.removeAttribute('data-pal-over'); over = hit; over?.setAttribute('data-pal-over', '') }
  }
  async function onUp(e: PointerEvent) {
    clearTimeout(press)
    if (!down || !host) return
    const d = down; down = null; dragging = false
    try { host.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    const target = over; over?.removeAttribute('data-pal-over'); over = null
    if (!d.moved) { // a press: a small hop on the spot and the nearest fact
      const here = cur
      if (!still()) { await hop({ x: here.x, y: here.y - 18 }); await hop(here) }
      say(facts()); return
    }
    const mint = target?.getAttribute('data-coin-mint')
    if (mint) { await adopt(mint, target!); return }
    measureOrigin(); const n = pick(); if (n) await hopTo(n)
  }
  async function adopt(mint: string, el: Element) {
    try {
      const c = await api.coin(mint)
      if (!isWatched(mint)) toggleWatch(mint, snapOf(c))
      pal.adopt(mint)
      say(`Following $${c.symbol}. I will say what changes.`)
    } catch { say('That coin did not load, so I did not follow it.'); return }
    measureOrigin()
    const r = el.getBoundingClientRect()
    const dx = Math.min(Math.max(20, r.width * 0.3), Math.max(20, r.width - W - 20))
    const s = spotAt(el, dx)
    if (s) await hopTo({ el, dx, ...s })
  }

  // ---- its menu: how it behaves, and the coin it follows
  $effect(() => {
    if (!menu) return
    const close = (e: Event) => { if (!(e.target instanceof Node && host?.contains(e.target))) menu = false }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { menu = false; line = null } }
    addEventListener('pointerdown', close); addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', esc) }
  })
  const MODES: { id: 'roam' | 'stay' | 'away'; label: string }[] = [{ id: 'roam', label: 'Roam' }, { id: 'stay', label: 'Stay here' }, { id: 'away', label: 'Away' }]
</script>

{#if !away}
  <div
    class="pal"
    class:on={shown}
    class:drag={dragging}
    bind:this={host}
    role="button"
    tabindex="0"
    aria-label="Snarks, the mascot. Press for a fact, drag onto a coin to follow it, long press or the menu key for its settings."
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    oncontextmenu={(e) => { e.preventDefault(); menu = !menu }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); say(facts()) } else if (e.key === 'Escape') { line = null; menu = false } }}
    style:width="{W}px"
    style:height="{H}px"
  >
    <div class="look" bind:this={lookEl}>
      <div class="breathe" class:doze class:deep class:bob={hovering}>
        <img bind:this={body} class="body" src={poseSrc(pose)} alt="" width={W} height={H} draggable="false" />
      </div>
    </div>
    {#if line}<span class="bubble mono {bubbleSide}" role="status">{line}</span>{/if}
    {#if menu}
      <div class="menu" role="menu" aria-label="Snarks">
        {#each MODES as m (m.id)}<button type="button" role="menuitemradio" aria-checked={pal.mode === m.id} onclick={() => { pal.setMode(m.id); menu = false }}>{m.label}</button>{/each}
        {#if pal.adopted}<button type="button" role="menuitem" onclick={() => { pal.adopt(null); menu = false; say('Not following any coin now.') }}>Stop following{followed ? ` $${followed.symbol}` : ''}</button>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .pal {
    position: absolute; left: 0; top: 0; z-index: 25; opacity: 0; touch-action: none; cursor: grab; outline: none;
    filter: drop-shadow(0 3px 0 rgba(43, 36, 32, .22));
  }
  .pal.on { opacity: 1; transition: opacity 300ms var(--ease); }
  .pal.drag { cursor: grabbing; z-index: 45; filter: drop-shadow(0 10px 0 rgba(43, 36, 32, .25)); }
  .pal:focus-visible .body { outline: 3px solid var(--pink); border-radius: var(--r-sm); }
  .look { width: 100%; height: 100%; transform-origin: 50% 100%; transform: rotate(var(--look, 0deg)); transition: transform 260ms var(--ease); }
  .breathe { width: 100%; height: 100%; transform-origin: 50% 100%; animation: breathe 3.2s ease-in-out infinite; }
  .breathe.bob { animation: bob 2.6s ease-in-out infinite; }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  .breathe.doze { animation: doze 3.4s ease-in-out infinite alternate; }
  .breathe.deep { animation: doze 5s ease-in-out infinite alternate; opacity: .88; scale: .94; transition: scale 600ms var(--ease), opacity 600ms var(--ease); }
  .body { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  @keyframes breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.02); } }
  @keyframes doze { from { transform: rotate(-7deg) scale(.97); } to { transform: rotate(-13deg) scale(.95); } }
  .bubble {
    position: absolute; bottom: calc(100% + 8px); width: max-content; max-width: 230px; padding: 8px 12px;
    background: var(--paper-2); color: var(--ink); border-radius: var(--r-sm); box-shadow: var(--sh-2), 0 0 0 1.5px var(--line);
    font-size: var(--t-12); line-height: 1.4; pointer-events: none; animation: say 180ms var(--ease);
  }
  .bubble.mid { left: 50%; translate: -30% 0; } .bubble.left { left: 0; } .bubble.right { right: 0; }
  @keyframes say { from { opacity: 0; transform: translateY(4px); } }
  .menu {
    position: absolute; bottom: calc(100% + 8px); left: 50%; translate: -30% 0; display: grid; min-width: 150px; padding: 4px; background: var(--paper-2); border-radius: var(--r-sm);
    box-shadow: var(--sh-3), 0 0 0 1.5px var(--line); cursor: default; animation: say 160ms var(--ease);
  }
  .menu button { min-height: 40px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-xs); background: none; color: var(--ink); font: inherit; font-size: var(--t-14); font-weight: 700; text-align: left; cursor: pointer; white-space: nowrap; }
  .menu button[aria-checked='true'] { background: var(--ink); color: var(--paper); }
  @media (hover: hover) { .menu button:hover:not([aria-checked='true']) { background: var(--hover); } }
  @media (prefers-reduced-motion: reduce) { .breathe, .breathe.bob, .breathe.doze, .breathe.deep { animation: none; } .look { transition: none; } .bubble, .menu { animation: none; } .pal.on { transition: none; } }
</style>
