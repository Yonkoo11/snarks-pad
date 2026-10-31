<script lang="ts">
  // Snarks, the pad's mascot, living on the page (docs/COMPANION.md is the design). One drawing, moved only as a whole: it hops between
  // the top edges of real things (cards, headings, ledger rows) or hovers in empty paper, breathes while it stands, tilts toward the
  // pointer, dozes when nothing happens, and can be picked up and dropped on a coin to follow it. Motion is free; speech is fact: every
  // line is a number or a time the pad holds, said with the network it comes from, and it reacts only to real events (a round paid, a
  // coin graduated, a followed coin grew, its creator sold), at most once a minute. It never lands over a control or words, never moves
  // while you type or while a sheet, the palette or its menu is open, honours Stay and Away, and on a phone starts away.
  import { tick } from 'svelte'
  import { api, onMode } from '../../lib/api'
  import type { CoinDetail, Epoch, PadMode, Treasury } from '../../lib/types'
  import { pal, validMint } from '../../lib/pal.svelte'
  import { layers } from '../../lib/layers.svelte'
  import { router } from '../../lib/router.svelte'
  import { poll } from '../../lib/poll'
  import { countdown, ago } from '../../lib/format'
  import { isWatched, lookDelta, snapOf, toggleWatch, watched } from '../../lib/looked'
  import { planHop, pathFrames, bodyFrames, shadowFrames, waveFrames, cheerFrames, alertFrames, springStep, lookAngle } from '../../lib/palMove'
  import { newRound, newGraduations, holdersGained, creatorSell } from '../../lib/palEvents'
  import { ReactionQueue } from '../../lib/palQueue'
  import { poseSrc, type PoseName } from '../../lib/palPoses'

  const W = 70, H = Math.round((70 * 373) / 260) // the drawing's own proportions
  let host = $state<HTMLDivElement>()
  let fig = $state<HTMLButtonElement>()
  let body = $state<HTMLImageElement>()
  let lookEl = $state<HTMLSpanElement>()
  let breatheEl = $state<HTMLSpanElement>()
  let shadowEl = $state<HTMLSpanElement>()
  let line = $state<string | null>(null)
  let bubbleSide = $state<'mid' | 'left' | 'right'>('mid')
  let doze = $state(false)
  let deep = $state(false)
  let dragging = $state(false)
  let shown = $state(false)
  let menu = $state(false)
  let hovering = $state(false)
  let corner = $state(false) // a phone that asked for it: fixed at the foot of the screen
  let pose = $state<PoseName>('stand')

  // ---- the screen it is on
  let narrow = $state(typeof matchMedia === 'function' && matchMedia('(max-width: 800px)').matches)
  let reduced = $state(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const still = $derived(narrow || reduced) // no travel: it is placed, and presses and reactions play in place
  $effect(() => {
    const a = matchMedia('(max-width: 800px)'), b = matchMedia('(prefers-reduced-motion: reduce)')
    const fa = () => (narrow = a.matches), fb = () => (reduced = b.matches)
    a.addEventListener('change', fa); b.addEventListener('change', fb)
    return () => { a.removeEventListener('change', fa); b.removeEventListener('change', fb) }
  })
  const away = $derived(pal.mode === 'away')

  // ---- what it knows
  let epochs = $state<Epoch[] | null>(null) // null until a read has landed: not the same as "no rounds"
  let treasury = $state<Treasury | null>(null)
  let followed = $state<CoinDetail | null>(null)
  let padMode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (padMode = m)))
  const visitStart = Date.now()
  let seenRound: string | null = null
  const announcedGrads = new Set<string>()
  let announcedHolders: number | null = null
  let sellMark = Date.now()

  // ---- where it stands: page coordinates inside #app, so scrolling carries it without a line of script
  let cur = { x: 0, y: 0 }
  let origin = { x: 0, y: 0 }
  let perch: { el: Element; dx: number } | null = null
  const measureOrigin = () => { const r = (host?.offsetParent as HTMLElement | null)?.getBoundingClientRect(); origin = r ? { x: r.left + scrollX, y: r.top + scrollY } : { x: 0, y: 0 } }
  const put = (p: { x: number; y: number }) => { cur = p; if (host) host.style.transform = `translate(${p.x}px, ${p.y}px)` }
  const toPage = (x: number, y: number) => ({ x: x + scrollX - origin.x, y: y + scrollY - origin.y })
  const viewportOf = (p: { x: number; y: number }) => ({ left: p.x + origin.x - scrollX, top: p.y + origin.y - scrollY })
  /** where the figure is right now, even in the middle of a hop */
  function livePos(): { x: number; y: number } {
    if (!host) return cur
    const m = new DOMMatrix(getComputedStyle(host).transform)
    return Number.isFinite(m.m41) && Number.isFinite(m.m42) ? { x: m.m41, y: m.m42 } : cur
  }

  // ---- places to stand: the top edge of a real element, or empty paper, with nothing clickable and no words under the figure
  const ANCHORS = 'main h1, main .panel, main .card, main .cardcell, main .tc, main .ms, main .strip, main .bs, main .drow, [data-perch]'
  const CLICKABLE = 'a, button, input, select, textarea, summary, canvas, [role="button"], [role="tab"], [role="dialog"], [onclick], [data-pick]'
  const CONTENT = 'img, svg, canvas, video, input, textarea, select'
  const isContent = (n: Element) => n.matches(CONTENT) || [...n.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== '')
  function blocked(left: number, top: number, except: Element): boolean {
    if (left < 4 || left + W > innerWidth - 4) return true
    const a = { l: left - 6, t: top - 2, r: left + W + 6, b: top + H - 12 } // the figure's box, a little generous, its feet excluded
    for (const n of document.querySelectorAll(CLICKABLE)) {
      if (n === except || n.contains(except) || host?.contains(n)) continue
      const r = n.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.left < a.r && r.right > a.l && r.top < a.b && r.bottom > a.t) return true
    }
    // a grid of points across the figure: none may land on words or pictures
    for (let i = 0; i < 5; i++) for (let j = 0; j < 6; j++) {
      const x = left + (W * (i + 0.5)) / 5, y = top + ((H - 14) * (j + 0.5)) / 6
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
      if (document.elementsFromPoint(x, y).some((n) => n !== except && !n.contains(except) && !host?.contains(n) && isContent(n))) return true
    }
    return false
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
  type Spot = { el: Element | null; dx: number; x: number; y: number }
  const homeEl = () => (pal.adopted ? document.querySelector(`[data-coin-mint="${CSS.escape(pal.adopted)}"]`) : null)
  let visits = 0
  function pick(): Spot | null {
    const home = homeEl()
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

  // ---- motion: one mover owns the figure. A new move cancels the old one, starts from where the figure really is, and only the current move commits.
  let moveId = 0
  let moving = false
  const cancelAll = () => host?.getAnimations({ subtree: true }).forEach((a) => a.cancel())
  async function hop(to: { x: number; y: number }, slow = false): Promise<void> {
    if (!host || !body) return
    corner = false
    if (still) { moveId++; moving = false; cancelAll(); put(to); return }
    const id = ++moveId
    const from = livePos()
    cancelAll(); put(from)
    const plan = planHop(from, to, slow)
    moving = true
    const path = host.animate(pathFrames(plan), { duration: plan.dur, easing: 'linear' })
    body.animate(bodyFrames(plan), { duration: plan.dur, easing: 'linear' })
    shadowEl?.animate(shadowFrames(plan), { duration: plan.dur, easing: 'linear' })
    try { await path.finished } catch { /* a newer move took over */ }
    if (id !== moveId) return
    moving = false
    put(to)
  }
  async function hopTo(s: Spot) { perch = s.el ? { el: s.el, dx: s.dx } : null; hovering = !s.el; await hop(s) }
  async function play(kind: 'wave' | 'cheer' | 'alert') {
    if (!body || reduced) return // with reduced motion a still frame: the words carry it
    pose = kind === 'wave' ? 'stand' : kind
    const frames = kind === 'wave' ? waveFrames() : kind === 'cheer' ? cheerFrames() : alertFrames()
    const a = body.animate(frames, { duration: kind === 'wave' ? 900 : kind === 'cheer' ? 1250 : 1400, easing: 'linear' })
    try { await a.finished } catch { /* cancelled */ }
    pose = 'stand'
  }

  // ---- what it can say: facts, nearest first, said with the network they come from and never when the pad says otherwise
  const note = () => (padMode && padMode !== 'mainnet' ? 'Test network. ' : '')
  function facts(): string {
    const m = pal.adopted
    if (m && followed) {
      const base = watched()[m] ?? null
      if (!base) return `${note()}$${followed.symbol}: no earlier look in this browser to compare with.`
      const d = lookDelta(base, snapOf(followed))
      return `${note()}$${followed.symbol}: ${d.length ? d.join(', ') : 'no change'} since you followed it.`
    }
    if (treasury?.paused) return `${note()}Payouts are paused.`
    const next = treasury?.nextEpochAt
    if (next && Date.parse(next) > Date.now()) return `${note()}The next round pays in ${countdown(next, Date.now())}.`
    if (epochs === null) return `${note()}Round data has not loaded.`
    const last = epochs[0]
    if (last) return `${note()}Round ${epochs.length} paid ${last.solanaPayouts.count + last.shielded.count} wallets, ${ago(last.at)}.`
    return `${note()}No round has paid yet.`
  }
  let sayTimer: ReturnType<typeof setTimeout> | undefined
  function say(text: string) {
    if (host) { const x = host.getBoundingClientRect().left; bubbleSide = x < 140 ? 'left' : x > innerWidth - 260 ? 'right' : 'mid' }
    line = text; clearTimeout(sayTimer); sayTimer = setTimeout(() => (line = null), 5400)
  }
  $effect(() => pal.onSay(say))

  // ---- real events: each waits in a queue (one per kind, expiring, at most once a minute) and plays when nothing else is going on
  const queue = new ReactionQueue()
  let playing = false
  const busy = () => dragging || menu || !!layers.top || document.hidden || !!document.querySelector('.slip[role="dialog"]') || (document.activeElement instanceof HTMLElement && !!document.activeElement.closest('input, textarea, select, [contenteditable]'))
  async function drain() {
    if (playing || moving || busy() || pal.mode === 'away') return
    const r = queue.next(Date.now())
    if (!r) return
    playing = true
    try { await r.run() } finally { queue.played(r, Date.now()); playing = false }
  }
  function homeSpot(): Spot | null {
    const el = homeEl()
    if (!el) return null
    const r = el.getBoundingClientRect()
    const dx = Math.min(Math.max(20, r.width * 0.3), Math.max(20, r.width - W - 20))
    const s = spotAt(el, dx)
    return s ? { el, dx, ...s } : null
  }
  const react = (key: string, kind: 'wave' | 'cheer' | 'alert', text: string, goHome = false) => queue.push(key, async () => {
    measureOrigin()
    if (goHome && pal.mode === 'roam' && !still) { const h = homeSpot(); if (h) await hopTo(h) }
    say(text); await play(kind)
  }, Date.now())

  $effect(() => poll(async () => {
    if (pal.mode === 'away') return
    const [e, t] = await Promise.all([api.epochs().catch(() => null), api.treasury().catch(() => null)])
    if (t) treasury = t
    if (e) {
      epochs = e.epochs
      const hit = newRound(seenRound, e.epochs)
      seenRound = e.epochs[0]?.id ?? seenRound
      if (hit) react('round', 'wave', `${note()}Round ${hit.n} paid ${hit.paid} ${hit.paid === 1 ? 'wallet' : 'wallets'}.`)
    }
  }, 60_000))
  $effect(() => poll(async () => {
    if (pal.mode === 'away') return
    const r = await api.coins({ stage: 'graduated', limit: 20 }).catch(() => null)
    if (!r) return
    for (const c of newGraduations(r.coins, visitStart, announcedGrads)) { announcedGrads.add(c.mint); react(`grad:${c.mint}`, 'cheer', `${note()}$${c.symbol} graduated to Meteora.`) }
  }, 60_000))
  const adoptedMint = $derived(pal.adopted)
  $effect(() => {
    const m = adoptedMint
    followed = null; announcedHolders = null; sellMark = Date.now()
    queue.drop('holders:'); queue.drop('sell:')
    if (!m) return
    const stopA = poll(async () => {
      if (pal.mode === 'away') return
      const c = await api.coin(m).catch(() => null)
      if (!c || adoptedMint !== m) return
      followed = c
      const gained = holdersGained(announcedHolders, c.holders)
      announcedHolders = c.holders ?? announcedHolders
      if (gained) react(`holders:${m}`, 'wave', `${note()}$${c.symbol}: +${gained} ${gained === 1 ? 'holder' : 'holders'} since the last check.`, true)
    }, 30_000)
    const stopB = poll(async () => {
      if (pal.mode === 'away') return
      const r = await api.trades({ mint: m, limit: 15 }).catch(() => null)
      if (!r || adoptedMint !== m) return
      const s = creatorSell(r.trades, sellMark)
      if (s) { sellMark = Date.parse(s.at); react(`sell:${m}`, 'alert', `${note()}Creator sold on $${s.symbol}.`, true) }
    }, 30_000)
    return () => { stopA(); stopB() }
  })

  // ---- the life: arrive, stand, hop on, doze when nothing happens
  let lastActive = Date.now()
  function wake() {
    if (!doze && !deep) return
    doze = false; deep = false
    if (!reduced) breatheEl?.animate([{ transform: 'rotate(-4deg) scale(.97)' }, { transform: 'rotate(0deg) translateY(-4px) scale(1.02)', offset: 0.55 }, { transform: 'rotate(0deg) scale(1)' }], { duration: 260, easing: 'ease-out' })
  }
  const poke = () => { lastActive = Date.now(); wake() }
  const hintKey = 'snarks-pal-hint'
  function place() { // where it stands when it does not travel: a clear spot on a computer, the foot of the screen on a phone
    cancelAll(); moving = false; measureOrigin()
    if (narrow) { corner = true; perch = null; hovering = false; return }
    corner = false
    const n = pick()
    if (n) { perch = n.el ? { el: n.el, dx: n.dx } : null; hovering = !n.el; put(n) }
  }
  $effect(() => {
    if (away || !host) return
    const mode = pal.mode, stillNow = still
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (ms: number) => new Promise<void>((res) => { timer = setTimeout(res, ms) })
    measureOrigin()
    ;(async () => {
      try {
        await wait(1500)
        if (dead) return
        if (stillNow) { place(); shown = true }
        else {
          const first = pick()
          if (!first) { place(); shown = true }
          else { put({ x: innerWidth + 40, y: first.y }); shown = true; await hopTo(first) }
        }
        if (!stillNow && !localStorage.getItem(hintKey) && !busy()) { try { localStorage.setItem(hintKey, '1') } catch { /* private window */ } say('Drag me onto a coin to follow it. Press and hold for my settings.') }
        while (!dead) {
          await wait(12_000 + Math.random() * 12_000)
          if (dead) return
          await drain()
          if (mode !== 'roam' || stillNow || busy()) continue
          const idle = Date.now() - lastActive
          if (idle > 120_000) { deep = true; continue }
          if (idle > 24_000) { doze = true; continue }
          measureOrigin()
          const next = pick()
          if (next) await hopTo(next)
        }
      } catch { /* a failed read of the page must not end its life; the effect restarts it when the page changes */ }
    })()
    // every two seconds: is the footing still good (images loading, a panel opening move the page under it)?
    const foot = setInterval(async () => {
      if (document.hidden || moving || playing || dragging || menu || stillNow) return
      measureOrigin()
      if (!perch) { // hovering: no edge to keep, but the page may have moved a control under it
        const v = viewportOf(cur)
        if (hovering && blocked(v.left, v.top, document.body) && mode === 'roam' && !busy()) { const n = pick(); if (n) await hopTo(n) }
        return
      }
      if (!perch.el.isConnected) { if (mode === 'roam' && !busy()) { const n = pick(); if (n) await hopTo(n) } return }
      const s = spotAt(perch.el, perch.dx)
      if (!s) { if (mode === 'roam' && !busy()) { const n = pick(); if (n) await hopTo(n) } return }
      if (Math.hypot(s.x - cur.x, s.y - cur.y) > 8) await hop(s) // a small correction, allowed even in Stay
    }, 2000)
    const reactTimer = setInterval(() => { if (!document.hidden) void drain() }, 2500)
    const onResize = () => { measureOrigin(); if (stillNow) place() }
    addEventListener('resize', onResize)
    for (const ev of ['pointermove', 'keydown', 'scroll', 'pointerdown'] as const) addEventListener(ev, poke, { passive: true })
    return () => { dead = true; clearTimeout(timer); clearInterval(foot); clearInterval(reactTimer); clearTimeout(sayTimer); removeEventListener('resize', onResize); for (const ev of ['pointermove', 'keydown', 'scroll', 'pointerdown'] as const) removeEventListener(ev, poke) }
  })
  // a new page: where it stood may be gone
  $effect(() => {
    void router.route
    if (!host || away) return
    const t = setTimeout(() => {
      measureOrigin()
      if (still) { place(); return }
      if (pal.mode !== 'roam' || busy()) return
      const n = pick(); if (n) void hopTo(n)
    }, 900)
    return () => clearTimeout(t)
  })

  // ---- it looks toward the pointer: attention without eyes (the whole figure tilts a few degrees)
  $effect(() => {
    if (away || reduced) return
    let raf = 0
    const onMove = (e: PointerEvent) => {
      if (raf || dragging || !host || !lookEl) return
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
  let down: { x: number; y: number; moved: boolean; dx: number; dy: number } | null = null
  let over: Element | null = null
  let swing = { pos: 0, vel: 0 }, lastX = 0, lastT = 0, vx = 0, carryRaf = 0, moveRaf = 0
  let press: ReturnType<typeof setTimeout> | undefined
  function carryLoop(t: number) {
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000); lastT = t
    swing = springStep(swing.pos, swing.vel, Math.max(-26, Math.min(26, -vx * 0.05)), dt)
    vx *= Math.pow(0.9, dt * 60) // the same decay at 60 and 120 Hz
    if (body) body.style.transform = `rotate(${swing.pos.toFixed(2)}deg)`
    if (dragging || Math.abs(swing.pos) > 0.2 || Math.abs(swing.vel) > 1) carryRaf = requestAnimationFrame(carryLoop)
    else { if (body) body.style.transform = ''; carryRaf = 0 }
  }
  function onDown(e: PointerEvent) {
    if (!host || !fig || e.button === 2 || (e.target instanceof Element && e.target.closest('.menu'))) return
    measureOrigin()
    const here = livePos() // grabbed mid-hop: it stops where it is
    cancelAll(); moveId++; moving = false; put(here)
    down = { x: e.clientX, y: e.clientY, moved: false, dx: e.clientX + scrollX - origin.x - here.x, dy: e.clientY + scrollY - origin.y - here.y }
    fig.setPointerCapture(e.pointerId); poke(); lastX = e.clientX
    press = setTimeout(() => { if (down && !down.moved) { down = null; menu = true } }, 650)
  }
  function onMove(e: PointerEvent) {
    if (!down || !host) return
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 7) return
    if (!down.moved) { clearTimeout(press); menu = false; line = null; perch = null; hovering = false; corner = false }
    down.moved = true; dragging = true
    vx = (e.clientX - lastX) * 60; lastX = e.clientX
    if (!carryRaf && !reduced) { lastT = 0; carryRaf = requestAnimationFrame(carryLoop) }
    if (moveRaf) return
    const px = e.clientX, py = e.clientY
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0
      if (!down || !host) return
      put({ x: px + scrollX - origin.x - down.dx, y: py + scrollY - origin.y - down.dy })
      const hit = document.elementsFromPoint(px, py).find((n) => n !== host && !host!.contains(n) && n.closest('[data-coin-mint]'))?.closest('[data-coin-mint]') ?? null
      if (hit !== over) { over?.removeAttribute('data-pal-over'); over = hit; over?.setAttribute('data-pal-over', '') }
    })
  }
  async function onUp(e: PointerEvent) {
    clearTimeout(press)
    if (!down || !host || !fig) return
    const d = down; down = null; dragging = false
    try { fig.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    const target = over; over?.removeAttribute('data-pal-over'); over = null
    if (e.type === 'pointercancel') return
    if (!d.moved) { // a press: a small hop on the spot (also on a phone) and the nearest fact
      if (!reduced) await hopInPlace(cur)
      say(facts()); return
    }
    const mint = validMint(target?.getAttribute('data-coin-mint') ?? null)
    if (mint) { await adopt(mint, target!); return }
    // dropped on empty paper: it stays where it was put, with a small settle; on top of something, it finds a clear place
    measureOrigin()
    const v = viewportOf(cur)
    if (!blocked(v.left, v.top, document.body)) { hovering = true; perch = null; await settle(); return }
    const n = pick(); if (n) await hopTo(n)
  }
  async function hopInPlace(here: { x: number; y: number }) {
    if (!host || !body) return
    const id = ++moveId; moving = true
    const up = { x: here.x, y: here.y - 18 }
    const a = host.animate([{ transform: `translate(${here.x}px, ${here.y}px)` }, { transform: `translate(${up.x}px, ${up.y}px)`, offset: 0.4, easing: 'cubic-bezier(.33,0,1,1)' }, { transform: `translate(${here.x}px, ${here.y}px)` }], { duration: 380, easing: 'cubic-bezier(.33,0,.67,1)' })
    body.animate([{ transform: 'scale(1.08,.88)' }, { transform: 'scale(.96,1.06)', offset: 0.4 }, { transform: 'scale(1.06,.9)', offset: 0.88 }, { transform: 'scale(1,1)' }], { duration: 380, easing: 'linear' })
    try { await a.finished } catch { /* superseded */ }
    if (id === moveId) { moving = false; put(here) }
  }
  async function settle() {
    if (!body || reduced) return
    const a = body.animate([{ transform: 'scale(1.06,.9)' }, { transform: 'scale(.98,1.03)', offset: 0.5 }, { transform: 'scale(1,1)' }], { duration: 300, easing: 'ease-out' })
    try { await a.finished } catch { /* cancelled */ }
  }
  async function adopt(mint: string, el?: Element | null) {
    const m = validMint(mint)
    if (!m) return
    try {
      const c = await api.coin(m)
      if (!isWatched(m)) toggleWatch(m, snapOf(c))
      pal.adopt(m)
      say(`Following $${c.symbol}. I will say when it gains holders or its creator sells.`)
    } catch { say('That coin did not load, so I did not follow it.'); return }
    if (still) return
    measureOrigin()
    const target = el ?? document.querySelector(`[data-coin-mint="${CSS.escape(m)}"]`)
    if (!target) return
    const r = target.getBoundingClientRect()
    const dx = Math.min(Math.max(20, r.width * 0.3), Math.max(20, r.width - W - 20))
    const s = spotAt(target, dx)
    if (s) await hopTo({ el: target, dx, ...s })
  }

  // ---- its menu: how it behaves, following the coin on this page without a drag, and the coin it follows
  const routeMint = $derived(router.route.name === 'coin' ? router.route.mint : null)
  $effect(() => {
    if (!menu) return
    void tick().then(() => host?.querySelector<HTMLButtonElement>('.menu button')?.focus())
    const close = (e: Event) => { if (!(e.target instanceof Node && host?.contains(e.target))) menu = false }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { menu = false; line = null; fig?.focus() } }
    addEventListener('pointerdown', close); addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', esc) }
  })
  const MODES: { id: 'roam' | 'stay' | 'away'; label: string }[] = [{ id: 'roam', label: 'Roam' }, { id: 'stay', label: 'Stay here' }, { id: 'away', label: 'Away' }]
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); say(facts()) }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); menu = true }
    else if (e.key === 'Escape') { line = null; menu = false }
  }
</script>

{#if !away}
  <div class="pal" class:on={shown} class:drag={dragging} class:corner bind:this={host} style:width="{W}px" style:height="{H}px">
    <span class="shadow" bind:this={shadowEl} aria-hidden="true"></span>
    <button
      type="button"
      class="fig"
      bind:this={fig}
      aria-label="Snarks, the mascot. Press for a fact. Menu key for its settings and to follow a coin."
      aria-haspopup="menu"
      aria-expanded={menu}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
      oncontextmenu={(e) => { e.preventDefault(); menu = !menu }}
      onkeydown={onKey}
    >
      <span class="look" bind:this={lookEl}>
        <span class="breathe" bind:this={breatheEl} class:doze class:deep class:bob={hovering}>
          <img bind:this={body} class="body" src={poseSrc(pose)} alt="" width={W} height={H} draggable="false" />
        </span>
      </span>
    </button>
    <!-- said once to a screen reader, outside the button; the bubble below is its picture -->
    <p class="sr" role="status" aria-live="polite">{line ?? ''}</p>
    {#if line}<span class="bubble mono {bubbleSide}" aria-hidden="true">{line}</span>{/if}
    {#if menu}
      <div class="menu" role="menu" aria-label="Snarks">
        {#each MODES as m (m.id)}<button type="button" role="menuitemradio" aria-checked={pal.mode === m.id} onclick={() => { pal.setMode(m.id); menu = false }}>{m.label}</button>{/each}
        {#if routeMint && pal.adopted !== routeMint}<button type="button" role="menuitem" onclick={() => { const m = routeMint; menu = false; void adopt(m) }}>Follow this coin</button>{/if}
        {#if pal.adopted}<button type="button" role="menuitem" onclick={() => { pal.adopt(null); menu = false; say('Not following any coin now.') }}>Stop following{followed ? ` $${followed.symbol}` : ''}</button>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .pal { position: absolute; left: 0; top: 0; z-index: 25; opacity: 0; pointer-events: none; }
  .pal.corner { position: fixed; left: 8px; top: auto; bottom: calc(112px + env(safe-area-inset-bottom, 0px)); transform: none !important; }
  .pal.on { opacity: 1; transition: opacity 300ms var(--ease); }
  .pal.drag { z-index: 45; }
  .fig {
    display: block; width: 100%; height: 100%; padding: 0; border: 0; background: none; cursor: grab; pointer-events: auto; touch-action: none; outline: none;
    -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
  }
  .pal.drag .fig { cursor: grabbing; }
  .fig:focus-visible .body { outline: 3px solid var(--pink); border-radius: var(--r-sm); }
  /* the ground contact: a flat shape under the feet that the hop shrinks and pales with height (not part of the drawing) */
  .shadow { position: absolute; left: 12%; right: 12%; bottom: -3px; height: 8px; border-radius: 50%; background: rgb(43, 36, 32); opacity: .22; filter: blur(1.5px); }
  .look { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; transform: rotate(var(--look, 0deg)); transition: transform 380ms cubic-bezier(.2, .8, .2, 1); }
  .breathe { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; animation: breathe 3.2s ease-in-out infinite; }
  .breathe.bob { animation: bob 2.6s ease-in-out infinite; }
  .breathe.doze { animation: doze 3.6s ease-in-out infinite alternate; }
  .breathe.deep { animation: doze 5s ease-in-out infinite alternate; opacity: .88; scale: .94; transition: scale 600ms var(--ease), opacity 600ms var(--ease); }
  .body { display: block; width: 100%; height: 100%; transform-origin: 50% 100%; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  @keyframes breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.03, 1.04); } }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  @keyframes doze { from { transform: rotate(0deg) translateY(0) scale(.98); } to { transform: rotate(-4deg) translateY(1.5px) scale(.96); } }
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .bubble {
    position: absolute; bottom: calc(100% + 8px); width: max-content; max-width: 230px; padding: 8px 12px;
    background: var(--paper-2); color: var(--ink); border-radius: var(--r-sm); box-shadow: var(--sh-2), 0 0 0 1.5px var(--line);
    font-size: var(--t-12); line-height: 1.4; pointer-events: none; animation: say 180ms var(--ease);
  }
  .bubble.mid { left: 50%; translate: -30% 0; } .bubble.left { left: 0; } .bubble.right { right: 0; }
  @keyframes say { from { opacity: 0; transform: translateY(4px); } }
  .menu {
    position: absolute; bottom: calc(100% + 8px); left: 50%; translate: -30% 0; display: grid; min-width: 170px; padding: 4px; background: var(--paper-2); border-radius: var(--r-sm);
    box-shadow: var(--sh-3), 0 0 0 1.5px var(--line); pointer-events: auto; animation: say 160ms var(--ease);
  }
  .menu button { min-height: 44px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-xs); background: none; color: var(--ink); font: inherit; font-size: var(--t-14); font-weight: 700; text-align: left; cursor: pointer; white-space: nowrap; }
  .menu button[aria-checked='true'] { background: var(--ink); color: var(--paper); }
  @media (hover: hover) { .menu button:hover:not([aria-checked='true']) { background: var(--hover); } }
  @media (prefers-reduced-motion: reduce) { .breathe, .breathe.bob, .breathe.doze, .breathe.deep { animation: none; } .look { transition: none; } .bubble, .menu { animation: none; } .pal.on { transition: none; } .shadow { display: none; } }
</style>
