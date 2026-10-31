// Snarks the companion's settings, kept in this browser: how it behaves (roam over the page, stay where it is, or be away) and the
// coin it was asked to watch. Nothing here leaves the browser.
const MODE_KEY = 'snarks-pal'
const COIN_KEY = 'snarks-pal-coin'
export type PalMode = 'roam' | 'stay' | 'away'

const get = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const put = (k: string, v: string | null): void => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private window: the choice lasts this visit */ } }

class Pal {
  mode = $state<PalMode>((() => { const v = get(MODE_KEY); return v === 'stay' || v === 'away' || v === 'roam' ? v : 'roam' })())
  adopted = $state<string | null>(get(COIN_KEY))
  /** a line to say, from outside (the palette, a page); the companion shows it once */
  say = $state<string | null>(null)
  setMode(m: PalMode): void { this.mode = m; put(MODE_KEY, m) }
  adopt(mint: string | null): void { this.adopted = mint; put(COIN_KEY, mint) }
}
export const pal = new Pal()
