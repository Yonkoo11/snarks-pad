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

/** The whole figure's path, one timing for both tracks (the body frames share these offsets): hold through the crouch, rise decelerating to the
 *  apex, fall accelerating (gravity), touch down at .92. The animation itself runs linear; the easing lives on each segment. */
export const OFF = { crouch: 0.16, apex: 0.5, down: 0.92, settle: 0.96 } as const
export function pathFrames(h: HopPlan): Keyframe[] {
  return [
    { transform: T(h.from), offset: 0, easing: 'linear' },
    { transform: T(h.from), offset: OFF.crouch, easing: 'cubic-bezier(.33,0,.67,1)' },
    { transform: T(h.mid), offset: OFF.apex, easing: 'cubic-bezier(.33,0,1,1)' },
    { transform: T(h.to), offset: OFF.down, easing: 'linear' },
    { transform: T(h.to), offset: 1 },
  ]
}

/** The body over the same time: anticipation (a held crouch), stretch at the apex, lean into the move, squash at the touchdown, a small settle, rest. */
export function bodyFrames(h: HopPlan): Keyframe[] {
  const t = h.tilt, lean = h.leap ? t * 2 : t
  return [
    { transform: 'scale(1,1) rotate(0deg)', offset: 0, easing: 'ease-in-out' },
    { transform: 'scale(1.1,.84) rotate(0deg)', offset: OFF.crouch, easing: 'ease-out' },
    { transform: `scale(.95,1.08) rotate(${lean}deg)`, offset: OFF.apex, easing: 'ease-in' },
    { transform: 'scale(1.09,.86) rotate(0deg)', offset: OFF.down, easing: 'ease-out' },
    { transform: 'scale(1.04,.96) rotate(0deg)', offset: OFF.settle, easing: 'ease-in-out' },
    { transform: 'scale(1,1) rotate(0deg)', offset: 1 },
  ]
}

/** The contact shadow under the feet: it stays on the ground while the figure rises, shrinks and pales with height, and is darkest at the landing. It is a separate flat shape, not part of the drawing. */
export function shadowFrames(h: HopPlan): Keyframe[] {
  const up = Math.max(0, h.from.y - h.mid.y), end = Math.max(0, h.to.y - h.mid.y)
  return [
    { transform: 'translateY(0) scaleX(1)', opacity: 0.22, offset: 0, easing: 'linear' },
    { transform: 'translateY(0) scaleX(1)', opacity: 0.22, offset: OFF.crouch, easing: 'cubic-bezier(.33,0,.67,1)' },
    { transform: `translateY(${Math.round((up + end) / 2)}px) scaleX(.62)`, opacity: 0.07, offset: OFF.apex, easing: 'cubic-bezier(.33,0,1,1)' },
    { transform: 'translateY(0) scaleX(1.1)', opacity: 0.3, offset: OFF.down, easing: 'ease-out' },
    { transform: 'translateY(0) scaleX(1)', opacity: 0.22, offset: 1 },
  ]
}

/** A wave: four beats that die away, a small lift on the first. */
export const waveFrames = (): Keyframe[] => [
  { transform: 'rotate(0deg) translateY(0)', offset: 0, easing: 'ease-out' }, { transform: 'rotate(-10deg) translateY(-4px)', offset: 0.2, easing: 'ease-in-out' },
  { transform: 'rotate(8deg) translateY(0)', offset: 0.42, easing: 'ease-in-out' }, { transform: 'rotate(-6deg)', offset: 0.62, easing: 'ease-in-out' },
  { transform: 'rotate(3deg)', offset: 0.82, easing: 'ease-out' }, { transform: 'rotate(0deg)', offset: 1 },
]
/** A cheer: a crouch, two bounces leaning opposite ways, a landing squash after each. No inversion and no full turn. */
export const cheerFrames = (): Keyframe[] => [
  { transform: 'translateY(0) scale(1,1) rotate(0deg)', offset: 0, easing: 'ease-out' }, { transform: 'translateY(0) scale(1.1,.84) rotate(0deg)', offset: 0.12, easing: 'cubic-bezier(.33,0,.67,1)' },
  { transform: 'translateY(-50px) scale(.95,1.08) rotate(11deg)', offset: 0.34, easing: 'cubic-bezier(.33,0,1,1)' }, { transform: 'translateY(0) scale(1.1,.85) rotate(0deg)', offset: 0.5, easing: 'cubic-bezier(.33,0,.67,1)' },
  { transform: 'translateY(-34px) scale(.96,1.06) rotate(-11deg)', offset: 0.68, easing: 'cubic-bezier(.33,0,1,1)' }, { transform: 'translateY(0) scale(1.08,.88) rotate(0deg)', offset: 0.85, easing: 'ease-out' },
  { transform: 'translateY(0) scale(1,1) rotate(0deg)', offset: 1 },
]
/** An alert: it snaps back, trembles, holds, and eases upright with a small overshoot. */
export const alertFrames = (): Keyframe[] => [
  { transform: 'rotate(0deg) scale(1)', offset: 0, easing: 'ease-out' }, { transform: 'rotate(-10deg) scale(1.03)', offset: 0.14 }, { transform: 'rotate(-11.5deg) scale(1.03)', offset: 0.4 },
  { transform: 'rotate(-8.5deg) scale(1.03)', offset: 0.5 }, { transform: 'rotate(-10.5deg) scale(1.03)', offset: 0.6 }, { transform: 'rotate(-10deg) scale(1.03)', offset: 0.8, easing: 'ease-in-out' },
  { transform: 'rotate(2deg) scale(1)', offset: 0.92, easing: 'ease-out' }, { transform: 'rotate(0deg) scale(1)', offset: 1 },
]

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
  const d = Math.hypot(dx, dy)
  if (d >= reach + 120) return 0
  const fall = d <= reach ? 1 : 1 - (d - reach) / 120 // a smooth fade over the next 120 px, not a snap
  return clamp(dx / 60, -1, 1) * max * fall
}
