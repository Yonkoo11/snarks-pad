// Snarks the companion's settings, kept in this browser: how it behaves (roam over the page, stay where it is, or be away) and the
// coin it was asked to follow. Nothing here leaves the browser. On a phone it starts away: a screen that small has no empty paper to
// stand on, so it is the visitor's choice to bring it.
const MODE_KEY = 'snarks-pal'
const COIN_KEY = 'snarks-pal-coin'
export type PalMode = 'roam' | 'stay' | 'away'
const MINT = /^[1-9A-HJ-NP-Za-km-z]{20,60}$/

const get = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const put = (k: string, v: string | null): void => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private window: the choice lasts this visit */ } }
/** A stored coin address is used in a selector, so it must look like one. */
export const validMint = (v: string | null): string | null => (v && MINT.test(v) ? v : null)

class Pal {
  mode = $state<PalMode>((() => {
    const v = get(MODE_KEY)
    if (v === 'stay' || v === 'away' || v === 'roam') return v
    return typeof matchMedia === 'function' && matchMedia('(max-width: 800px)').matches ? 'away' : 'roam'
  })())
  adopted = $state<string | null>(validMint(get(COIN_KEY)))
  private speak: ((t: string) => void) | null = null
  setMode(m: PalMode): void { this.mode = m; put(MODE_KEY, m) }
  cycle(): void { this.setMode(this.mode === 'roam' ? 'stay' : this.mode === 'stay' ? 'away' : 'roam') }
  adopt(mint: string | null): void { this.adopted = validMint(mint); put(COIN_KEY, this.adopted) }
  /** The companion registers here to be told what to say (from the palette, a page). */
  onSay(fn: (t: string) => void): () => void { this.speak = fn; return () => { if (this.speak === fn) this.speak = null } }
  say(text: string): void { this.speak?.(text) }
}
export const pal = new Pal()
