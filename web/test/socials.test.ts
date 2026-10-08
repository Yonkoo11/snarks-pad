// The creator's links (src/lib/socials.ts): a handle, a bare domain or a link in, one https address or a plain reason out. The engine judges the same
// inputs by the same rules (engine/src/socials.ts); engine/test/socials.test.ts runs both against one table, so a rule changed in one place shows there.
import { describe, expect, test } from 'bun:test'
import { LINKS_WARNING, checkTelegram, checkWebsite, checkX, hostOf, lookalikeKey, socialsPayload } from '../src/lib/socials'

describe('website', () => {
  test('a bare domain becomes an https link', () => {
    expect(checkWebsite('example.com/coin')).toEqual({ url: 'https://example.com/coin', error: null })
    expect(checkWebsite('  https://example.com  ')).toEqual({ url: 'https://example.com/', error: null })
  })

  test('nothing typed is not an error', () => {
    expect(checkWebsite('')).toEqual({ url: null, error: null })
    expect(checkWebsite('   ')).toEqual({ url: null, error: null })
  })

  test('http, other schemes, credentials in the address, a lookalike letter set and social hosts are refused', () => {
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'https://user:pass@example.com', 'notaurl', 'xn--e1afmkfd.com', 'https://x.com/snarkspad', 't.me/snarkspad', 'https://exa mple.com']) {
      const r = checkWebsite(bad)
      expect(r.url).toBeNull()
      expect(r.error).toBe('A website link that starts with https://')
    }
  })

  test('at most 100 characters', () => {
    const long = 'https://example.com/' + 'a'.repeat(100)
    expect(checkWebsite(long)).toEqual({ url: null, error: 'At most 100 characters.' })
  })
})

describe('X and Telegram', () => {
  test('a handle, a link and the old twitter address all give the canonical address', () => {
    expect(checkX('@snarkspad').url).toBe('https://x.com/snarkspad')
    expect(checkX('snarkspad').url).toBe('https://x.com/snarkspad')
    expect(checkX('x.com/snarkspad').url).toBe('https://x.com/snarkspad')
    expect(checkX('https://twitter.com/snarkspad?ref=1').url).toBe('https://x.com/snarkspad')
    expect(checkTelegram('@snarkspad').url).toBe('https://t.me/snarkspad')
    expect(checkTelegram('t.me/snarkspad').url).toBe('https://t.me/snarkspad')
    expect(checkTelegram('https://telegram.me/snarkspad').url).toBe('https://t.me/snarkspad')
  })

  test('a name that cannot be an account says what is wanted', () => {
    expect(checkX('bad handle!').error).toMatch(/@snarkspad/)
    expect(checkX('a'.repeat(16)).error).toMatch(/@snarkspad/)
    expect(checkX('https://example.com/snarkspad').error).toMatch(/@snarkspad/)
    expect(checkTelegram('ab').error).toMatch(/t\.me/)
    expect(checkTelegram('https://example.com/snarkspad').error).toMatch(/t\.me/)
  })
})

describe('the three together', () => {
  test('only the links that pass are sent; none gives undefined', () => {
    expect(socialsPayload('@a_b', 'example.com', 'not valid!')).toEqual({ x: 'https://x.com/a_b', website: 'https://example.com/' })
    expect(socialsPayload('', '', '')).toBeUndefined()
    expect(socialsPayload('bad handle!', 'notaurl', 'ab')).toBeUndefined()
  })

  test('the host shown beside a link has no www and survives a bad address', () => {
    expect(hostOf('https://www.example.com/a?b=1')).toBe('example.com')
    expect(hostOf('https://sub.example.org')).toBe('sub.example.org')
    expect(hostOf('not a url')).toBe('')
  })

  test('two names are alike when only case, spaces and punctuation differ', () => {
    expect(lookalikeKey('Release The Snarks')).toBe(lookalikeKey('release-the-snarks!'))
    expect(lookalikeKey('SNARKS')).not.toBe(lookalikeKey('SNARK'))
  })

  test('the warning beside the links says who added them and what to do', () => {
    expect(LINKS_WARNING).toMatch(/creator/)
    expect(LINKS_WARNING).toMatch(/not checked/)
    expect(LINKS_WARNING).toMatch(/address/)
  })
})
