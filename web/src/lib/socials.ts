// The creator's links on the launch form: what a person types (a handle, a bare domain, a full link) turned into the one
// https URL the engine stores, or a plain reason why it cannot be. Only https ever leaves the browser; nothing is
// rendered as a link that did not pass here. The engine judges the same inputs by the same rules (engine/src/socials.ts,
// and engine/test/socials.test.ts checks that the two agree): change one, change the other.
import type { Socials } from './types'

export interface SocialCheck { url: string | null; error: string | null }

const MAX = 100

/** A host made of plain letters, digits, hyphens and dots, no empty label and no punycode label (a way to dress one site as another). */
function plainHost(host: string): boolean {
  return /^[a-z0-9.-]+$/.test(host) && !host.split('.').some((label) => label === '' || label.startsWith('xn--'))
}

function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (u.protocol !== 'https:' || !/\.[a-z]{2,}$/i.test(u.hostname) || !plainHost(u.hostname) || u.username || u.password) return null
    return u
  } catch { return null }
}

const tooLong: SocialCheck = { url: null, error: `At most ${MAX} characters.` }

export function checkWebsite(raw: string): SocialCheck {
  const s = raw.trim()
  if (!s) return { url: null, error: null }
  if (s.length > MAX) return tooLong
  const u = httpsUrl(s)
  if (!u || /^(x|twitter|t)\.(com|me)$/i.test(u.hostname.replace(/^www\./, ''))) return { url: null, error: 'A website link that starts with https://' }
  if (u.href.length > MAX) return tooLong
  return { url: u.href, error: null }
}

export function checkX(raw: string): SocialCheck {
  const s = raw.trim()
  if (!s) return { url: null, error: null }
  if (s.length > MAX) return tooLong
  const bad = { url: null, error: 'An X handle like @snarkspad, or a link to x.com/snarkspad' }
  let handle = s.replace(/^@/, '')
  if (/[/.]/.test(handle)) {
    const u = httpsUrl(s)
    if (!u || !/^(www\.)?(x|twitter)\.com$/i.test(u.hostname)) return bad
    handle = u.pathname.split('/').filter(Boolean)[0] ?? ''
  }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return bad
  return { url: `https://x.com/${handle}`, error: null }
}

export function checkTelegram(raw: string): SocialCheck {
  const s = raw.trim()
  if (!s) return { url: null, error: null }
  if (s.length > MAX) return tooLong
  const bad = { url: null, error: 'A Telegram name like @snarkspad, or a link to t.me/snarkspad' }
  let name = s.replace(/^@/, '')
  if (/[/.]/.test(name)) {
    const u = httpsUrl(s)
    if (!u || !/^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname)) return bad
    name = u.pathname.split('/').filter(Boolean)[0] ?? ''
  }
  if (!/^[A-Za-z0-9_]{5,32}$/.test(name)) return bad
  return { url: `https://t.me/${name}`, error: null }
}

/** The three checks folded into the payload: only valid links, or undefined when there is none. */
export function socialsPayload(x: string, website: string, telegram: string): Socials | undefined {
  const out: Socials = {}
  const cx = checkX(x).url, cw = checkWebsite(website).url, ct = checkTelegram(telegram).url
  if (cx) out.x = cx
  if (cw) out.website = cw
  if (ct) out.telegram = ct
  return Object.keys(out).length ? out : undefined
}

/** Two coins look alike when their names or tickers are the same once case, spaces and punctuation are ignored. */
export const lookalikeKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The host of a link a creator gave, as a person reads it: no "www.". The coin page prints it beside the Website chip, so a lookalike address is seen before it is clicked. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

/** Said on the coin page beside the creator's links: the pad shows them, it does not vouch for what is behind them. */
export const LINKS_WARNING = 'Added by the creator, not checked by the pad. Check the address before you connect a wallet.'
