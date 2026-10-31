// The compare shelf: up to three coins pinned from anywhere, kept in this browser. The compare sheet reads these and nothing else.
const KEY = 'snarks-pins'
export const MAX_PINS = 3

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string').slice(0, MAX_PINS) : []
  } catch { return [] }
}

class Compare {
  pins = $state<string[]>(read())
  has(mint: string): boolean { return this.pins.includes(mint) }
  /** Pin or unpin. Returns false when the shelf is full, so the caller can say so. */
  toggle(mint: string): boolean {
    if (this.has(mint)) this.pins = this.pins.filter((m) => m !== mint)
    else if (this.pins.length >= MAX_PINS) return false
    else this.pins = [...this.pins, mint]
    try { localStorage.setItem(KEY, JSON.stringify(this.pins)) } catch { /* private window: the shelf lasts this visit */ }
    return true
  }
  clear(): void {
    this.pins = []
    try { localStorage.removeItem(KEY) } catch { /* private window */ }
  }
}
export const compare = new Compare()
