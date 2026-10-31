// The layer stack: every depth move that is not a page change (a coin's dossier, the compare sheet, the full tape) is a
// layer on this one stack. Opening pushes a history entry, so the phone's back gesture and Esc pop exactly the top layer;
// the address carries the top layer (?sheet=...), so a layer can be linked and survives a reload. A route change clears
// the stack. Peeks (hover cards) are not layers: they never touch history.
import { setHashQuery, hashQuery } from './query'
import { parseLayerKey, type Layer } from './layerKeys'
export { parseLayerKey, dossierKey, dossierMint, dossierTab, type Layer, type LayerKind, type DossierTab } from './layerKeys'

const pathOf = () => location.hash.split('?')[0]
let uids = 0

class Layers {
  stack = $state<Layer[]>([])
  /** The coin page (or any page) names itself for the breadcrumb: "$SNRK". */
  routeLabel = $state<string | null>(null)
  private lastPath = pathOf()

  constructor() {
    const restore = () => this.sync()
    addEventListener('popstate', restore)
    addEventListener('hashchange', restore)
    queueMicrotask(restore) // a link that carries ?sheet= opens its layer on load
  }

  get top(): Layer | null { return this.stack[this.stack.length - 1] ?? null }

  open(next: Omit<Layer, 'uid' | 'pushed' | 'opener'>): void {
    if (this.top?.key === next.key) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.stack.push({ ...next, uid: ++uids, pushed: true, opener })
    const q = new URLSearchParams(location.hash.split('?')[1] || '')
    q.set('sheet', next.key)
    history.pushState({ layer: next.key }, '', `${pathOf()}?${q.toString()}`)
  }

  /** Esc, the close button, the scrim, the phone's back gesture: one layer, the top one. */
  closeTop(): void {
    const top = this.top
    if (!top) return
    if (top.pushed) { history.back(); return }
    this.stack.pop()
    setHashQuery('sheet', this.top?.key ?? null)
    top.opener?.focus?.({ preventScroll: true })
  }

  /** The breadcrumb: pop down to `depth` layers. */
  popTo(depth: number): void {
    let guard = this.stack.length
    while (this.stack.length > depth && guard-- > 0) this.closeTop()
  }

  retitle(key: string, title: string): void {
    const l = this.stack.find((x) => x.key === key)
    if (l && l.title !== title) l.title = title
  }

  /** A layer changed its own tab: the address follows without a new history entry. */
  rekey(from: string, to: string): void {
    const l = this.stack.find((x) => x.key === from)
    if (!l || from === to) return
    l.key = to
    if (this.top === l) setHashQuery('sheet', to)
  }

  /** The address is the truth after any back, forward or hash change. */
  sync(): void {
    const path = pathOf()
    const wanted = parseLayerKey(hashQuery('sheet'))
    if (path !== this.lastPath) {
      this.lastPath = path
      this.stack = []
      if (wanted) this.stack.push({ ...wanted, uid: ++uids, pushed: false, opener: null })
      return
    }
    if (!wanted) { if (this.stack.length) this.stack = []; return }
    const at = this.stack.findIndex((x) => x.key === wanted.key)
    if (at >= 0) { if (at < this.stack.length - 1) this.stack = this.stack.slice(0, at + 1); return }
    this.stack.push({ ...wanted, uid: ++uids, pushed: false, opener: null })
  }
}
export const layers = new Layers()
