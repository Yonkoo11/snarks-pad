// Every coin without artwork gets its own crayon creature: a blob-bodied cousin of the mascot,
// grown deterministically from the coin's symbol, drawn once per session in a canvas and cached.
// The same coin is the same creature on every visit and device. The look is the mascot's: waxy
// strokes over a paper tile, a body that wobbles, one or two eyes, horns or ears or antennae,
// patches, little feet. Nothing is random at view time; the seed decides everything.

const cache = new Map<string, string>()

/** The same hue rule as CoinImage, so a coin keeps its established color. */
export const hueOf = (symbol: string): number => [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 360

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A wobbly closed blob around (cx, cy): the creature's body, never a perfect circle. */
function blobPath(rnd: () => number, cx: number, cy: number, r: number): Path2D {
  const path = new Path2D()
  const n = 9
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const rr = r * (0.82 + rnd() * 0.36)
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * (0.9 + rnd() * 0.2)])
  }
  path.moveTo((pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2)
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n]
    path.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
  }
  path.closePath()
  return path
}

/** Waxy crayon fill: short angled strokes clipped inside a path, dense in the middle, ragged at the edge. */
function crayonFill(x: CanvasRenderingContext2D, rnd: () => number, clip: Path2D, cx: number, cy: number, r: number, hue: number, sat: number, lit: number[]) {
  x.save()
  x.clip(clip)
  const n = Math.round(r * r * 0.055)
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2
    const rr = Math.sqrt(rnd()) * r * 1.1
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr
    const len = r * (0.12 + rnd() * 0.16)
    const ang = -0.9 + (rnd() - 0.5) * 0.8 // crayon hand: mostly one diagonal
    x.strokeStyle = `hsla(${hue + (rnd() - 0.5) * 18} ${sat}% ${lit[Math.floor(rnd() * lit.length)]}% / ${0.18 + rnd() * 0.22})`
    x.lineWidth = 2 + rnd() * 3
    x.lineCap = 'round'
    x.beginPath()
    x.moveTo(px - Math.cos(ang) * len / 2, py - Math.sin(ang) * len / 2)
    x.lineTo(px + Math.cos(ang) * len / 2, py + Math.sin(ang) * len / 2)
    x.stroke()
  }
  x.restore()
  // the drawn outline, a touch off the fill like a hand traced it
  x.strokeStyle = `hsla(${hue} ${sat}% ${Math.min(...lit) - 8}% / .5)`
  x.lineWidth = 2.5
  x.stroke(clip)
}

/** The creature (async: it waits for the paper tile's own look once). Null when the canvas is unavailable. */
export async function crayonTile(symbol: string, dark: boolean, size = 256): Promise<string | null> {
  const key = `${symbol}/${dark ? 'd' : 'l'}/${size}`
  const hit = cache.get(key)
  if (hit) return hit

  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const x = c.getContext('2d')
  if (!x) return null
  const rnd = mulberry32([...symbol].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0)
  const hue = hueOf(symbol)
  const s = size / 100 // creature units: the drawing thinks in a 100-wide room

  // the paper tile the creature is drawn on: cream in the light, deep-tinted at night
  x.fillStyle = dark ? `hsl(${hue} 18% 22%)` : '#f6f0e3'
  x.fillRect(0, 0, size, size)
  // paper grain
  for (let i = 0; i < size * size * 0.008; i++) {
    x.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)'
    x.fillRect(rnd() * size, rnd() * size, 1, 1)
  }

  const sat = dark ? 45 : 60
  const lit = dark ? [52, 60, 44] : [58, 66, 48]
  const cx = size / 2 + (rnd() - 0.5) * 6 * s
  const cy = size / 2 + 4 * s
  const r = size * (0.3 + rnd() * 0.05)

  // little feet first, so the body stands on them
  const feet = 2 + Math.floor(rnd() * 2)
  for (let i = 0; i < feet; i++) {
    const fx = cx + (i - (feet - 1) / 2) * r * 0.7 + (rnd() - 0.5) * 4 * s
    const foot = blobPath(rnd, fx, cy + r * 0.95, r * 0.16)
    crayonFill(x, rnd, foot, fx, cy + r * 0.95, r * 0.2, 25, dark ? 25 : 35, dark ? [30, 38] : [28, 36])
  }

  // horns, ears or antennae on top
  const topKind = Math.floor(rnd() * 3)
  const tops = topKind === 2 ? 1 : 2
  for (let i = 0; i < tops; i++) {
    const tx = cx + (tops === 1 ? 0 : (i === 0 ? -1 : 1) * r * (0.45 + rnd() * 0.15))
    const ty = cy - r * (0.85 + rnd() * 0.15)
    const tr = r * (topKind === 0 ? 0.2 : topKind === 1 ? 0.26 : 0.14)
    const top = blobPath(rnd, tx, ty, tr)
    crayonFill(x, rnd, top, tx, ty, tr * 1.2, hue + 20, sat, lit)
  }

  // wings sometimes, like the mascot's
  if (rnd() > 0.5) {
    for (const side of [-1, 1]) {
      const wx = cx + side * r * 1.05, wy = cy - r * 0.1
      const wing = blobPath(rnd, wx, wy, r * 0.22)
      crayonFill(x, rnd, wing, wx, wy, r * 0.26, hue, Math.max(20, sat - 25), dark ? [60, 70] : [80, 88])
    }
  }

  // the body
  const body = blobPath(rnd, cx, cy, r)
  crayonFill(x, rnd, body, cx, cy, r, hue, sat, lit)

  // patches on the body, a second hue like the mascot's pepperoni
  const patches = 2 + Math.floor(rnd() * 4)
  for (let i = 0; i < patches; i++) {
    const a = rnd() * Math.PI * 2
    const rr = rnd() * r * 0.55
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr
    const pr = r * (0.08 + rnd() * 0.08)
    const patch = blobPath(rnd, px, py, pr)
    crayonFill(x, rnd, patch, px, py, pr * 1.3, hue + 140 + rnd() * 40, sat - 5, dark ? [45, 55] : [50, 60])
  }

  // eyes: one big, or two; white, iris, pupil, a paper glint
  const eyes = rnd() > 0.6 ? 2 : 1
  for (let i = 0; i < eyes; i++) {
    const ex = cx + (eyes === 1 ? r * 0.05 : (i === 0 ? -1 : 1) * r * 0.32)
    const ey = cy - r * 0.28
    const er = r * (eyes === 1 ? 0.3 : 0.2)
    x.fillStyle = dark ? '#efe7da' : '#fdfaf2'
    x.beginPath(); x.ellipse(ex, ey, er, er * (0.92 + rnd() * 0.12), (rnd() - 0.5) * 0.3, 0, Math.PI * 2); x.fill()
    x.strokeStyle = 'rgba(38, 32, 28, .65)'; x.lineWidth = 2; x.stroke()
    const look = rnd() * Math.PI * 2
    x.fillStyle = '#262220'
    x.beginPath(); x.arc(ex + Math.cos(look) * er * 0.25, ey + Math.sin(look) * er * 0.25, er * 0.42, 0, Math.PI * 2); x.fill()
    x.fillStyle = 'rgba(255,255,255,.8)'
    x.beginPath(); x.arc(ex + er * 0.12, ey - er * 0.18, er * 0.1, 0, Math.PI * 2); x.fill()
  }

  // a small mouth: a happy or wiggly stroke
  x.strokeStyle = 'rgba(38, 32, 28, .6)'
  x.lineWidth = 2.5; x.lineCap = 'round'
  x.beginPath()
  const mx = cx, my = cy + r * 0.22
  if (rnd() > 0.4) { x.arc(mx, my - r * 0.06, r * 0.16, 0.3, Math.PI - 0.3) } else { x.moveTo(mx - r * 0.14, my); x.quadraticCurveTo(mx, my + r * 0.1 * (rnd() > 0.5 ? 1 : -1), mx + r * 0.14, my) }
  x.stroke()

  // the ticker's first letter, written small in the corner like a signature
  try { await document.fonts.load(`700 ${Math.round(size * 0.16)}px Gaegu`) } catch { /* fallback face still draws */ }
  x.font = `700 ${Math.round(size * 0.16)}px Gaegu, 'Comic Sans MS', sans-serif`
  x.textAlign = 'right'; x.textBaseline = 'alphabetic'
  x.fillStyle = dark ? 'rgba(239, 231, 218, .75)' : 'rgba(38, 32, 28, .65)'
  x.fillText(symbol.slice(0, 1).toUpperCase(), size - 6 * s, size - 6 * s)

  const url = c.toDataURL('image/png')
  cache.set(key, url)
  return url
}
