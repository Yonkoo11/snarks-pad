// Audit view: every number that carries a "how we know" line shows it, all at once. Off by default; this browser remembers the choice.
const KEY = 'snarks-audit'
class Audit {
  on = $state((() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })())
  toggle(): void {
    this.on = !this.on
    try { localStorage.setItem(KEY, this.on ? '1' : '0') } catch { /* private window: the choice lasts this visit */ }
  }
}
export const audit = new Audit()
