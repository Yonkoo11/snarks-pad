// One curve for everything: cubic-bezier(.16, 1, .3, 1), solved here so a number tweened in JS
// moves exactly as the CSS transitions do. Under prefers-reduced-motion the duration is 0.
export const DATA_MS = 240

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const ax = 1 - 3 * x2 + 3 * x1, bx = 3 * x2 - 6 * x1, cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1, by = 3 * y2 - 6 * y1, cy = 3 * y1
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t
  const sy = (t: number) => ((ay * t + by) * t + cy) * t
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const d = dx(t), e = sx(t) - x
      if (Math.abs(e) < 1e-6) return sy(t)
      if (Math.abs(d) < 1e-6) break
      t -= e / d
    }
    let lo = 0, hi = 1
    for (let i = 0; i < 24; i++) { t = (lo + hi) / 2; if (sx(t) < x) lo = t; else hi = t }
    return sy(t)
  }
}

export const EASE = bezier(0.16, 1, 0.3, 1)

/** Tween options for a number moving to a new value: 240ms on the one curve, 0ms when the OS asks for reduced motion. */
export const dataTween = () => ({ duration: reducedMotion() ? 0 : DATA_MS, easing: EASE })
