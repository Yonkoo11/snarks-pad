// The profile page's plain logic (src/lib/profile.ts, routes.ts, walletMark.ts, explorer.ts): which tabs a visitor and the owner see, what makes a page address a wallet, the pad's coins among
// a wallet's token accounts and what they are worth, the address of #/u/<wallet> and #/me, the picture an address gets, and the Solscan link on each network. No browser needed.
import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import { holdingValueZats, holdingsOf, isProfileTab, isWalletAddress, profileHref, tabFor, visibleTabs } from '../src/lib/profile'
import { parseRoute } from '../src/lib/routes'
import { walletMark } from '../src/lib/walletMark'
import { solscanAccountUrl } from '../src/lib/explorer'
import type { Coin } from '../src/lib/types'

const key = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill))
const A = key(7)
const B = key(9)

describe('tabs', () => {
  test('a visitor sees Holdings, Launched and Trades; only the owner also sees Rewards and Shielded delivery', () => {
    expect(visibleTabs(false)).toEqual(['holdings', 'launched', 'trades'])
    expect(visibleTabs(true)).toEqual(['holdings', 'launched', 'trades', 'rewards', 'shielded'])
  })

  test('a tab the viewer may not see is Holdings, never an error and never the owner tab', () => {
    expect(tabFor('rewards', false)).toBe('holdings')
    expect(tabFor('shielded', false)).toBe('holdings')
    expect(tabFor('rewards', true)).toBe('rewards')
    expect(tabFor('launched', false)).toBe('launched')
    expect(tabFor(null, true)).toBe('holdings')
  })

  test('only the five tab names are tabs', () => {
    for (const t of ['holdings', 'launched', 'trades', 'rewards', 'shielded']) expect(isProfileTab(t)).toBe(true)
    for (const t of ['', null, undefined, 'Rewards', 'admin', 'constructor', '__proto__']) expect(isProfileTab(t)).toBe(false)
  })
})

describe('a wallet address', () => {
  test('a canonical base58 key of 32 bytes is one', () => {
    expect(isWalletAddress(A)).toBe(true)
    expect(isWalletAddress('11111111111111111111111111111111')).toBe(true)
  })

  test('anything else is not: too short, too long, a character base58 does not have, a padded or mistyped key, a script', () => {
    for (const bad of ['', 'abc', A.slice(1), A + 'x', '0'.repeat(44), `${A}\n`, ' ' + A, '<script>alert(1)</script>', '../../etc/passwd', 'I'.repeat(44)]) expect(isWalletAddress(bad)).toBe(false)
  })
})

describe('the address of a profile', () => {
  test('#/u/<wallet>, with ?tab= only for a tab other than the first', () => {
    expect(profileHref(A)).toBe(`#/u/${A}`)
    expect(profileHref(A, 'holdings')).toBe(`#/u/${A}`)
    expect(profileHref(A, 'rewards')).toBe(`#/u/${A}?tab=rewards`)
    expect(profileHref(A, 'launched')).toBe(`#/u/${A}?tab=launched`)
  })

  test('the route reads it back: the wallet and the tab', () => {
    expect(parseRoute(`#/u/${A}`)).toEqual({ name: 'profile', wallet: A, tab: null })
    expect(parseRoute(`#/u/${A}?tab=rewards`)).toEqual({ name: 'profile', wallet: A, tab: 'rewards' })
    expect(parseRoute(`#/u/${A}?tab=nonsense`)).toEqual({ name: 'profile', wallet: A, tab: null })
    expect(parseRoute(`#/u/${A}?all=1&tab=trades`)).toEqual({ name: 'profile', wallet: A, tab: 'trades' })
  })

  test('#/me is its own route, with the same tab query; the other routes are as they were', () => {
    expect(parseRoute('#/me')).toEqual({ name: 'me', tab: null })
    expect(parseRoute('#/me?tab=shielded')).toEqual({ name: 'me', tab: 'shielded' })
    expect(parseRoute('')).toEqual({ name: 'home' })
    expect(parseRoute('#/')).toEqual({ name: 'home' })
    expect(parseRoute(`#/coin/${A}?ref=${B}`)).toEqual({ name: 'coin', mint: A })
    for (const page of ['launch', 'shielded', 'treasury', 'how', 'terms', 'privacy', 'risk']) expect(parseRoute(`#/${page}`)).toEqual({ name: page })
  })

  test('a path that is not a route is no page: a profile with no wallet or an extra part, #/me/x, an unknown name, a mistyped escape', () => {
    for (const hash of ['#/u', '#/u/', `#/u/${A}/extra`, '#/me/x', '#/nope', '#/coin', '#/coin/%E0%A4%A', '#/u/%E0%A4%A']) expect(parseRoute(hash)).toEqual({ name: 'missing' })
  })
})

describe('what a wallet holds', () => {
  const coin = (mint: string, symbol: string, priceZec?: string): Coin => ({ mint, symbol, name: symbol, priceZec } as Coin)
  const [one, two, three] = [key(1), key(2), key(3)]
  const coins = [coin(one, 'ONE', '0.5'), coin(two, 'TWO', '12'), coin(three, 'THREE')]

  test('the value of an amount at the pool price, in zats, exactly and rounded down: 6 decimals of token, up to 12 of price', () => {
    expect(holdingValueZats(250_000n * 1_000_000n, '12')).toBe(3_000_000n) // 250,000 tokens at 12 zats
    expect(holdingValueZats(1_000_000n, '0.37545974197')).toBe(0n) // one token at a third of a zat is under one zat
    expect(holdingValueZats(1_000n * 1_000_000n, '0.37545974197')).toBe(375n) // 1,000 tokens at 0.37545974197 zats: 375.45..., rounded down
    expect(holdingValueZats(999_999n, '1')).toBe(0n)
    expect(holdingValueZats(1_000_000n, '1')).toBe(1n)
  })

  test('no price, or one that is not a plain decimal, is no value (a dash on the page), never 0', () => {
    for (const price of [undefined, '', 'NaN', '-1', '1e3', '1.2.3', 'abc']) expect(holdingValueZats(5_000_000n, price)).toBeNull()
  })

  test('only the pad coins in the accounts are holdings; other mints and empty accounts are left out; accounts of one mint add up', () => {
    const r = holdingsOf(
      [{ mint: one, amount: '4000000' }, { mint: key(99), amount: '1000000000' }, { mint: two, amount: '0' }, { mint: one, amount: '6000000' }],
      coins,
    )
    expect(r.map((h) => [h.coin.symbol, h.amount])).toEqual([['ONE', 10_000_000n]])
    expect(r[0]!.valueZats).toBe(5n) // 10 tokens at 0.5 zat
  })

  test('largest value first, a coin with no price last, ties by ticker', () => {
    const r = holdingsOf(
      [{ mint: three, amount: '5000000' }, { mint: one, amount: '20000000' }, { mint: two, amount: '1000000' }],
      coins,
    )
    expect(r.map((h) => h.coin.symbol)).toEqual(['TWO', 'ONE', 'THREE']) // 12 zats, 10 zats, no price
    const tie = holdingsOf([{ mint: one, amount: '2000000' }, { mint: key(4), amount: '2000000' }], [coin(one, 'BBB', '1'), coin(key(4), 'AAA', '1')])
    expect(tie.map((h) => h.coin.symbol)).toEqual(['AAA', 'BBB'])
  })

  test('a wallet with none of them holds nothing here, and a malformed amount is not counted', () => {
    expect(holdingsOf([], coins)).toEqual([])
    expect(holdingsOf([{ mint: one, amount: '1.5' }, { mint: one, amount: '-3' }, { mint: one, amount: 'x' }], coins)).toEqual([])
  })
})

describe('the picture an address gets', () => {
  const addresses = Array.from({ length: 300 }, (_, i) => bs58.encode(Uint8Array.from({ length: 32 }, (_, j) => (i * 37 + j * 91 + (i >> 3) * j) & 255)))

  test('the same address always gives the same picture, a different address (nearly always) a different one', () => {
    expect(walletMark(A)).toEqual(walletMark(A))
    expect(walletMark(A)).not.toEqual(walletMark(B))
    expect(new Set(addresses.map((a) => JSON.stringify(walletMark(a)))).size).toBeGreaterThan(280)
  })

  test('it is a 5 x 5 grid mirrored left to right, a hue below 360, and never empty', () => {
    for (const a of addresses) {
      const m = walletMark(a)
      expect(m.cells.length).toBe(25)
      expect(m.hue).toBeGreaterThanOrEqual(0)
      expect(m.hue).toBeLessThan(360)
      for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) expect(m.cells[row * 5 + col]).toBe(m.cells[row * 5 + (4 - col)]!)
      const filled = m.cells.filter(Boolean).length
      expect(filled).toBeGreaterThanOrEqual(5) // at worst the centre column
      expect(filled).toBeLessThanOrEqual(25)
    }
  })

  test('text that is not an address still gets a picture, and the same one each time', () => {
    expect(walletMark('not an address')).toEqual(walletMark('not an address'))
    expect(walletMark('').cells.length).toBe(25)
  })
})

describe('View on Solscan', () => {
  test('mainnet is the plain address; devnet adds the cluster; a local stack is a custom cluster', () => {
    expect(solscanAccountUrl(A, 'mainnet')).toBe(`https://solscan.io/account/${A}`)
    expect(solscanAccountUrl(A, 'devnet')).toBe(`https://solscan.io/account/${A}?cluster=devnet`)
    expect(solscanAccountUrl(A, 'local')).toBe(`https://solscan.io/account/${A}?cluster=custom&customUrl=${encodeURIComponent('http://127.0.0.1:8899')}`)
  })

  test('while the network is not known there is no link, rather than one to the wrong network', () => {
    expect(solscanAccountUrl(A, null)).toBeNull()
  })
})
