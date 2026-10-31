// A squarified treemap: values to rectangles that fill a box, each as close to square as the values allow (Bruls, Huizing, van Wijk).
// Pure, so a test can read it. Zero and negative values get no tile; the areas add up to the box.
export interface Tile<T> { item: T; x: number; y: number; w: number; h: number }

export function squarify<T>(entries: { item: T; value: number }[], W: number, H: number): Tile<T>[] {
  const live = entries.filter((e) => e.value > 0 && Number.isFinite(e.value)).sort((a, b) => b.value - a.value)
  const total = live.reduce((a, e) => a + e.value, 0)
  if (live.length === 0 || total <= 0 || W <= 0 || H <= 0) return []
  const scale = (W * H) / total
  const items = live.map((e) => ({ item: e.item, area: e.value * scale }))
  const out: Tile<T>[] = []
  let x = 0, y = 0, w = W, h = H
  let row: typeof items = []
  const worst = (r: typeof items, side: number) => {
    const s = r.reduce((a, i) => a + i.area, 0)
    const max = Math.max(...r.map((i) => i.area)), min = Math.min(...r.map((i) => i.area))
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min))
  }
  const place = (r: typeof items) => {
    const s = r.reduce((a, i) => a + i.area, 0)
    if (w >= h) { // a column on the left, as wide as its area needs
      const cw = s / h
      let cy = y
      for (const i of r) { const ch = i.area / cw; out.push({ item: i.item, x, y: cy, w: cw, h: ch }); cy += ch }
      x += cw; w -= cw
    } else { // a row along the top
      const rh = s / w
      let cx = x
      for (const i of r) { const cw = i.area / rh; out.push({ item: i.item, x: cx, y, w: cw, h: rh }); cx += cw }
      y += rh; h -= rh
    }
  }
  for (const it of items) {
    const side = Math.min(w, h)
    if (row.length === 0 || worst([...row, it], side) <= worst(row, side)) row.push(it)
    else { place(row); row = [it] }
  }
  if (row.length) place(row)
  return out
}
