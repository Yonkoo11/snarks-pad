// Geometry for the coin page's price chart, kept out of the component so it can be checked on its own.
import type { PricePoint } from './types'

export interface ChartPoint { t: number; v: number }

export interface Plot {
  line: string // SVG path of the price line
  area: string // closed path under the line
  xs: number[] // x of each point, in viewBox units
  ys: number[]
  min: number
  max: number
}

/** The numbers the chart can draw: finite, positive, in time order. Anything else is dropped, never drawn as 0. */
export function toChartPoints(points: PricePoint[]): ChartPoint[] {
  return points
    .map((p) => ({ t: Date.parse(p.at), v: Number(p.priceZec) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t)
}

/** Lays the points out in a w x h box. Time is spread evenly by trade (a coin trades in bursts; a wall-clock axis would be mostly empty). */
export function plot(points: ChartPoint[], w: number, h: number, padRatio = 0.1): Plot | null {
  if (points.length === 0) return null
  const vs = points.map((p) => p.v)
  const min = Math.min(...vs), max = Math.max(...vs)
  const span = max - min || max || 1 // a flat price still draws, in the middle
  const lo = min - (max === min ? span * 0.5 : span * padRatio)
  const hi = max + (max === min ? span * 0.5 : span * padRatio)
  const n = points.length
  // One trade is drawn as a flat line across the box so there is something to read.
  const xs = n === 1 ? [0, w] : points.map((_, i) => (i / (n - 1)) * w)
  const ys = (n === 1 ? [points[0], points[0]] : points).map((p) => h - ((p.v - lo) / (hi - lo)) * h)
  const f = (x: number) => (Math.round(x * 100) / 100).toString()
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${f(x)} ${f(ys[i])}`).join(' ')
  const area = `${line} L${f(xs[xs.length - 1])} ${h} L${f(xs[0])} ${h} Z`
  return { line, area, xs, ys, min, max }
}

/** Index of the drawn point closest to `x` (viewBox units). */
export function nearestIndex(xs: number[], x: number): number {
  let best = 0
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i
  return best
}
