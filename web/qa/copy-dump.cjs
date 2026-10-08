// Copy audit (2026-10-07): the visible text of every page and coin tab of a live pad, one file each, plus a 1440 screenshot, for a line-by-line review.
//   node qa/copy-dump.cjs <base url> <out dir> <coin mint> <wallet>
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const [BASE, OUT, COIN, WALLET] = [process.argv[2].replace(/\/?$/, '/'), process.argv[3], process.argv[4], process.argv[5]]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROUTES = [['home', '#/'], ['launch', '#/launch'], ['shielded', '#/shielded'], ['treasury', '#/treasury'], ['how', '#/how'], ['terms', '#/terms'], ['privacy', '#/privacy'], ['risk', '#/risk'], ['profile', `#/u/${WALLET}`], ['coin', `#/coin/${COIN}`]]
;(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: require('./launch-helpers.cjs').CHROME })
  const p = await browser.newPage()
  await p.setViewport({ width: 1440, height: 900 })
  for (const [name, hash] of ROUTES) {
    await p.goto(BASE + hash, { waitUntil: 'networkidle2' }); await sleep(2500)
    const text = await p.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText)
    writeFileSync(path.join(OUT, `${name}.txt`), text)
    await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true })
    if (name === 'home') writeFileSync(path.join(OUT, 'chrome.txt'), await p.evaluate(() => `HEADER:\n${document.querySelector('header')?.innerText ?? ''}\n\nFOOTER:\n${document.querySelector('footer')?.innerText ?? ''}`))
    if (name === 'coin') {
      const tabs = await p.$$eval('[role=tab]', (els) => els.map((e) => e.textContent.trim()))
      for (let i = 0; i < tabs.length; i++) {
        await p.evaluate((i) => document.querySelectorAll('[role=tab]')[i].click(), i); await sleep(1500)
        const t = await p.evaluate(() => document.querySelector('[role=tabpanel]')?.innerText ?? '')
        writeFileSync(path.join(OUT, `coin-tab-${i}-${tabs[i].replace(/[^a-z]+/gi, '-').toLowerCase()}.txt`), t)
      }
    }
    console.log('dumped', name)
  }
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
