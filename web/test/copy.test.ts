// The page carries no em dash (design/build-brief.md, "Banned anywhere: ... em dashes"); a value the pad does not know is the en dash.
// Every source file under web/src, and web/index.html, is scanned, so a string added later in a page, a card, the mock or a lib file is checked too.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const EM_DASH = '—'
const SOURCE = /\.(svelte|ts|css|html)$/

/** Every source file of the web app, as a path relative to web/. */
const sources = (): string[] =>
  [...readdirSync(join(WEB, 'src'), { recursive: true, encoding: 'utf8' }).map((f) => join('src', f)), 'index.html']
    .filter((f) => SOURCE.test(f) && statSync(join(WEB, f)).isFile())

describe('the em dash', () => {
  test('no source file of the web app has one', () => {
    const found = sources().flatMap((f) => readFileSync(join(WEB, f), 'utf8').split('\n').flatMap((line, i) => (line.includes(EM_DASH) ? [`${f}:${i + 1}`] : [])))
    expect(found).toEqual([])
  })

  test('the scan sees the pages, cards, mock and styles it guards', () => {
    const seen = sources()
    for (const f of ['src/components/CoinCard.svelte', 'src/routes/Home.svelte', 'src/routes/Coin.svelte', 'src/lib/mock/index.ts', 'src/app.css', 'index.html']) expect(seen).toContain(f)
    expect(seen.length).toBeGreaterThan(50)
  })
})
