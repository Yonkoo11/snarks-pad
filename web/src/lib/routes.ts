// The hash routes and how a page address maps to one: #/ (Explore), #/coin/:mint[?ref=<wallet>], #/u/:wallet[?tab=holdings|launched|trades|rewards|shielded],
// #/me[?tab=...], #/launch, #/shielded, #/treasury, #/how, #/terms, #/privacy, #/risk. Pure, so a test can read it; router.svelte.ts holds the live state.
import { isProfileTab, type ProfileTab } from './profile'

export type PageName = 'launch' | 'shielded' | 'treasury' | 'how' | 'terms' | 'privacy' | 'risk'
export type Route =
  | { name: 'home' }
  | { name: 'coin'; mint: string }
  | { name: 'profile'; wallet: string; tab: ProfileTab | null }
  | { name: 'me'; tab: ProfileTab | null }
  | { name: PageName }
  | { name: 'missing' }

const PAGES: readonly PageName[] = ['launch', 'shielded', 'treasury', 'how', 'terms', 'privacy', 'risk']

/** A path part as typed, or null when it is not valid percent-encoding (a mistyped link is "no page here", never an error). */
function decode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** The profile tab named in the address's query, if it is one of the profile's tabs. */
function tabOf(hash: string): ProfileTab | null {
  const query = hash.split('?')[1]
  const tab = query ? new URLSearchParams(query).get('tab') : null
  return isProfileTab(tab) ? tab : null
}

export function parseRoute(hash: string): Route {
  const parts = hash.split('?')[0].replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'home' }
  if (parts[0] === 'coin' && parts[1]) {
    const mint = decode(parts[1])
    return mint === null ? { name: 'missing' } : { name: 'coin', mint }
  }
  if (parts[0] === 'u' && parts.length === 2) {
    const wallet = decode(parts[1])
    return wallet === null ? { name: 'missing' } : { name: 'profile', wallet, tab: tabOf(hash) }
  }
  if (parts[0] === 'me' && parts.length === 1) return { name: 'me', tab: tabOf(hash) }
  const page = PAGES.find((p) => p === parts[0])
  if (page && parts.length === 1) return { name: page }
  return { name: 'missing' }
}
