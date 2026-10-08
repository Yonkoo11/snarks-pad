// 2026-10-06 review shots of what changed: the profile (visitor and owner), the wallet menu, the coin page's share row. Live devnet pad, test wallet.
//   node qa/review-1006.cjs <base url> <out dir>
const path = require('node:path')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const BASE = (process.argv[2] || 'https://test.snarks.fun/').replace(/\/?$/, '/')
const OUT = process.argv[3]
const CREATOR = 'AopHbhiNu3VMXDg1cwKecU7FQaSPRpGrZEXsnKXyyVta'
const COIN = 'HQ2ywEpeac1rz45mk9p32eAXMZrUVbjdPt1LGY4AWVE5'
const W = { 1440: { width: 1440, height: 900, deviceScaleFactor: 1 }, 390: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function page(browser, width, theme) {
  const p = await browser.newPage()
  await p.setViewport(W[width])
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
  await p.evaluateOnNewDocument((t) => { try { localStorage.setItem('snarks-theme', t) } catch {} }, theme)
  p.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  return p
}
async function clickText(p, re) {
  const ok = await p.evaluate((src) => {
    const rx = new RegExp(src, 'i')
    const el = [...document.querySelectorAll('button, a, [role=menuitem], [role=option]')].find((e) => rx.test(e.textContent || '') && e.offsetParent !== null)
    if (el) { el.click(); return true }
    return false
  }, re.source)
  if (!ok) console.log('no element for', re)
  return ok
}
async function shot(p, name) { await sleep(1800); await p.screenshot({ path: path.join(OUT, name + '.png') }); console.log('shot', name) }
;(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: require('./launch-helpers.cjs').CHROME })
  for (const [w, t] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']]) {
    const p = await page(browser, w, t)
    await p.goto(`${BASE}#/u/${CREATOR}`, { waitUntil: 'networkidle2' })
    await shot(p, `profile-visitor-${w}-${t}`)
    if ((w === 1440 && t === 'light') || (w === 390 && t === 'dark')) {
      await p.goto(`${BASE}#/coin/${COIN}`, { waitUntil: 'networkidle2' })
      await shot(p, `coin-${w}-${t}`)
    }
    if ((w === 1440 && t === 'dark') || (w === 390 && t === 'light')) {
      await p.goto(`${BASE}#/`, { waitUntil: 'networkidle2' })
      await sleep(800)
      await clickText(p, /^\s*connect/)
      await sleep(500)
      await clickText(p, /test wallet/)
      await sleep(1200)
      await clickText(p, /…|\.\.\./) // the address button shows the short address with an ellipsis
      await shot(p, `wallet-menu-${w}-${t}`)
      await p.goto(`${BASE}#/me`, { waitUntil: 'networkidle2' })
      await shot(p, `profile-owner-${w}-${t}`)
    }
    await p.close()
  }
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
