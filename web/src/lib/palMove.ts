// The arithmetic of Snarks' motion, apart from the page, so a test can read it. A hop is planned from two points; the figure's path
// and its body (squash, stretch, tilt) are keyframes over the same time. Springs drive whatever follows the pointer.
export interface P { x: number; y: number }
export interface HopPlan { from: P; to: P; mid: P; dist: number; dur: number; arc: number; tilt: number; leap: boolean }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function planHop(from: P, to: P, slow = false): HopPlan {
  const dx = to.x - from.x, dy = to.y - from.y
  const dist = Math.hypot(dx, dy)
  const dur = clamp(520 + dist * 0.45, 520, 1150) * (slow ? 1.4 : 1)
  const arc = clamp(60 + dist * 0.18, 60, 230)
  return { from, to, mid: { x: from.x + dx / 2, y: Math.min(from.y, to.y) - arc }, dist, dur, arc, tilt: Math.sign(dx || 1) * 8, leap: dist > 500 }
}

const T = (p: P) => `translate(${p.x}px, ${p.y}px)`

/** The whole figure's path: wait out the crouch, rise to the apex, come down on the target. */
export function pathFrames(h: HopPlan): Keyframe[] {
  return [{ transform: T(h.from), offset: 0 }, { transform: T(h.from), offset: 0.1 }, { transform: T(h.mid), offset: 0.5 }, { transform: T(h.to), offset: 0.92 }, { transform: T(h.to), offset: 1 }]
}

/** The body over the same time: anticipation (crouch), stretch in the air, lean into the move, landing squash, settle. A leap adds a half turn of lean. */
export function bodyFrames(h: HopPlan): Keyframe[] {
  const t = h.tilt, lean = h.leap ? t * 2 : t
  return [
    { transform: 'scale(1,1) rotate(0deg)', offset: 0 },
    { transform: 'scale(1.07,.88) rotate(0deg)', offset: 0.1 },
    { transform: `scale(.95,1.08) rotate(${lean}deg)`, offset: 0.5 },
    { transform: `scale(1.02,1.02) rotate(${lean / 2}deg)`, offset: 0.85 },
    { transform: 'scale(1.09,.86) rotate(0deg)', offset: 0.93 },
    { transform: 'scale(1,1) rotate(0deg)', offset: 1 },
  ]
}

/** A wave: a small hop's worth of wiggle, three beats each side, then still. */
export const waveFrames = (): Keyframe[] => [0, -12, 12, -10, 10, -6, 6, 0].map((deg, i, a) => ({ transform: `rotate(${deg}deg) scale(${i === 0 || i === a.length - 1 ? 1 : 1.03})`, offset: i / (a.length - 1) }))
/** A cheer: a crouch, a jump with a full turn, a landing squash. Whole-figure rotation only; never mirrored. */
export const cheerFrames = (): Keyframe[] => [
  { transform: 'translateY(0) scale(1,1) rotate(0deg)', offset: 0 }, { transform: 'translateY(0) scale(1.08,.88) rotate(0deg)', offset: 0.12 },
  { transform: 'translateY(-52px) scale(.96,1.08) rotate(180deg)', offset: 0.4 }, { transform: 'translateY(0) scale(1.1,.86) rotate(360deg)', offset: 0.62 },
  { transform: 'translateY(-26px) scale(.98,1.04) rotate(360deg)', offset: 0.8 }, { transform: 'translateY(0) scale(1.06,.9) rotate(360deg)', offset: 0.92 }, { transform: 'translateY(0) scale(1,1) rotate(360deg)', offset: 1 },
]
/** An alert: it leans back and holds, then eases upright. */
export const alertFrames = (): Keyframe[] => [{ transform: 'rotate(0deg) scale(1)', offset: 0 }, { transform: 'rotate(-10deg) scale(1.03)', offset: 0.18 }, { transform: 'rotate(-10deg) scale(1.03)', offset: 0.8 }, { transform: 'rotate(0deg) scale(1)', offset: 1 }]

/** One step of a damped spring toward `target` (semi-implicit Euler, substepped so a long frame cannot blow it up). */
export function springStep(pos: number, vel: number, target: number, dt: number, k = 170, c = 18): { pos: number; vel: number } {
  let p = pos, v = vel
  const n = Math.max(1, Math.ceil(dt / 0.008))
  const h = dt / n
  for (let i = 0; i < n; i++) { v += (-k * (p - target) - c * v) * h; p += v * h }
  return { pos: p, vel: v }
}

/** How far to tilt toward a pointer that is `dx` px to the side, within `reach` px; none beyond it. Degrees, at most `max`. */
export function lookAngle(dx: number, dy: number, reach = 240, max = 5): number {
  if (Math.hypot(dx, dy) > reach) return 0
  return clamp(dx / 60, -1, 1) * max
}
