// A torn paper edge as a clip-path polygon, the same tear for the same seed. `left` tears the left side of a sheet that slides
// from the right; `top` tears the top of a sheet that rises from the bottom. The jitter is a few pixels, never more.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function tornClip(seed: number, side: 'left' | 'top', steps = 46, depth = 0.9): string {
  const r = rng(seed * 7919 + 13)
  const pts: string[] = []
  if (side === 'left') {
    pts.push('100% 0%', '100% 100%')
    for (let i = steps; i >= 0; i--) pts.push(`${(r() * depth).toFixed(2)}% ${((i / steps) * 100).toFixed(2)}%`)
  } else {
    pts.push('100% 100%', '0% 100%')
    for (let i = 0; i <= steps; i++) pts.push(`${((i / steps) * 100).toFixed(2)}% ${(r() * depth).toFixed(2)}%`)
  }
  return `polygon(${pts.join(', ')})`
}
