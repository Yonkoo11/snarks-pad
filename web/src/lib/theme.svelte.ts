// Three states: follow the OS (the default), or an override this browser remembers ('light' | 'dark'). The one-line
// script in index.html applies a stored override before the first paint; this store keeps <html data-theme> and the
// header button in step after that. Storage is read and written inside try/catch: a blocked storage still toggles
// for the page, it just forgets on reload.
const KEY = 'snarks-theme'
type Pref = 'system' | 'light' | 'dark'
type Mode = 'light' | 'dark'
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

function stored(): Pref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch { return 'system' }
}
function remember(p: Pref) {
  try {
    if (p === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch { /* storage blocked: the choice lasts for this page */ }
}

class Theme {
  pref = $state<Pref>(stored())
  system = $state<Mode>(mq?.matches ? 'dark' : 'light')
  effective = $derived<Mode>(this.pref === 'system' ? this.system : this.pref)
  constructor() {
    mq?.addEventListener('change', (e) => (this.system = e.matches ? 'dark' : 'light'))
    this.apply()
  }
  /** Switch to the other theme. Switching back to what the OS shows drops the override, so the page follows the OS again. */
  toggle() {
    const next: Mode = this.effective === 'dark' ? 'light' : 'dark'
    this.pref = next === this.system ? 'system' : next
    remember(this.pref)
    this.apply()
  }
  private apply() {
    const el = document.documentElement
    if (this.pref === 'system') el.removeAttribute('data-theme')
    else el.setAttribute('data-theme', this.pref)
  }
}
export const theme = new Theme()
