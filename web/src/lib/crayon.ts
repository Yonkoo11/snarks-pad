// A crayon-drawn disc for a coin without artwork, drawn once per coin in a canvas and cached.
// Deterministic: the symbol seeds the RNG, so the same coin looks the same on every visit and
// every device, like the flat tile it replaces (CoinImage keys its tile hue the same way).
// The look: short waxy strokes laid in jittered rings of the coin's own hue, the first letter
// written over them in the display hand with a doubled, slightly offset pass, and a dusting of
// paper grain. All of it happens once per coin per session; the result is a data URL.

const cache = new Map<string, string>()

/** The same hue rule as CoinImage, so the drawn disc keeps the coin's established color. */
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

/** Draws the disc (async: it waits for the display face once). Returns null when the canvas is unavailable. */
export async function crayonTile(symbol: string, dark: boolean, size = 256): Promise<string | null> {
  const key = `${symbol}/${dark ? 'd' : 'l'}/${size}`
  const hit = cache.get(key)
  if (hit) return hit
  try { await document.fonts.load(`700 ${Math.round(size * 0.56)}px Gaegu`) } catch { /* fallback face still draws */ }

  const c = document.createElement('canvas')
  c.width = size; c.height = size
  const x = c.getContext('2d')
  if (!x) return null
  const rnd = mulberry32([...symbol].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0)
  const hue = hueOf(symbol)

  // the paper the coin is drawn on: the same tile tint CoinImage used, so nothing jumps for a returning visitor
  x.fillStyle = dark ? `hsl(${hue} 22% 26%)` : `hsl(${hue} 45% 82%)`
  x.fillRect(0, 0, size, size)

  // waxy strokes in jittered rings: dense enough to read as filled by hand, never the same twice across coins
  const cx = size / 2, cy = size / 2
  const L = dark ? [34, 30, 42] : [62, 68, 55]
  for (let ring = 0; ring < 7; ring++) {
    const r0 = (size * 0.46 * (ring + 1)) / 7
    const n = 14 + ring * 7
    for (let i = 0; i < n; i++) {
      const a0 = rnd() * Math.PI * 2
      const r = r0 + (rnd() - 0.5) * size * 0.05
      const len = size * (0.04 + rnd() * 0.05)
      const ang = a0 + Math.PI / 2 + (rnd() - 0.5) * 0.9
      const px = cx + Math.cos(a0) * r, py = cy + Math.sin(a0) * r
      x.strokeStyle = `hsla(${hue + (rnd() - 0.5) * 24} ${dark ? 32 : 58}% ${L[Math.floor(rnd() * 3)]}% / ${0.16 + rnd() * 0.2})`
      x.lineWidth = 2.5 + rnd() * 3.5
      x.lineCap = 'round'
      x.beginPath()
      x.moveTo(px - (Math.cos(ang) * len) / 2, py - (Math.sin(ang) * len) / 2)
      x.lineTo(px + (Math.cos(ang) * len) / 2, py + (Math.sin(ang) * len) / 2)
      x.stroke()
    }
  }

  // the letter, written twice with a hand's offset so the edge looks drawn, not typeset
  const letter = symbol.slice(0, 1).toUpperCase()
  x.textAlign = 'center'; x.textBaseline = 'middle'
  x.font = `700 ${Math.round(size * 0.56)}px Gaegu, 'Comic Sans MS', sans-serif`
  const ink = dark ? 'hsl(36 30% 90%)' : 'hsl(20 12% 16%)'
  x.globalAlpha = 0.55
  x.fillStyle = ink
  x.fillText(letter, cx + size * 0.008, cy + size * 0.05 + size * 0.006)
  x.globalAlpha = 1
  x.fillText(letter, cx, cy + size * 0.05)

  // a dusting of grain so the tile sits on the same paper as the page
  const dots = Math.floor(size * size * 0.012)
  for (let i = 0; i < dots; i++) {
    x.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)'
    x.fillRect(rnd() * size, rnd() * size, 1, 1)
  }

  const url = c.toDataURL('image/png')
  cache.set(key, url)
  return url
}
