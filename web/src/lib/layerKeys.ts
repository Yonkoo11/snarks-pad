// The layer vocabulary: what a layer is and how its address form reads and writes. Pure, so a test can read it; the live stack is layers.svelte.ts.
export type LayerKind = 'dossier' | 'compare' | 'tape' | 'wallet'
export interface Layer {
  uid: number // stable across a rekey, so the sheet is not remounted when its tab changes
  kind: LayerKind
  key: string // the address form: dossier:<mint>:<tab>, compare, tape
  title: string // the crumb; a layer may rewrite it once it knows more
  pushed: boolean // owns a history entry, so closing it goes back
  opener: HTMLElement | null // focus returns here when the layer closes
}

export type DossierTab = 'trades' | 'holders' | 'rewards'
const B58 = /^[1-9A-HJ-NP-Za-km-z]{20,60}$/
const TABS: readonly string[] = ['trades', 'holders', 'rewards']

/** The layer an address names, or null when it names none. Pure, so a test can read it. */
export function parseLayerKey(key: string | null): Omit<Layer, 'uid' | 'pushed' | 'opener'> | null {
  if (!key) return null
  if (key === 'compare') return { kind: 'compare', key, title: 'Compare' }
  if (key === 'tape') return { kind: 'tape', key, title: 'Live tape' }
  const [kind, mint, tab] = key.split(':')
  if (kind === 'wallet' && B58.test(mint ?? '') && B58.test(tab ?? '')) return { kind: 'wallet', key, title: 'Wallet' }
  if (kind === 'dossier' && mint && B58.test(mint) && (!tab || TABS.includes(tab))) {
    return { kind: 'dossier', key: `dossier:${mint}:${tab || 'trades'}`, title: 'Coin' }
  }
  return null
}
export const walletKey = (wallet: string, mint: string) => `wallet:${wallet}:${mint}`
export const walletParts = (key: string): { wallet: string; mint: string } => { const [, wallet = '', mint = ''] = key.split(':'); return { wallet, mint } }
export const dossierKey = (mint: string, tab: DossierTab = 'trades') => `dossier:${mint}:${tab}`
export const dossierMint = (key: string): string => key.split(':')[1] ?? ''
export const dossierTab = (key: string): DossierTab => (TABS.includes(key.split(':')[2]) ? (key.split(':')[2] as DossierTab) : 'trades')
