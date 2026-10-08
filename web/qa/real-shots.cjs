// Screenshots of the app against the real local stack (engine API :8787).
// home, coin, opt-in (after success), treasury at 1440 desktop and 390 phone:
// 8 PNGs into qa/real/. Opt-in uses a fake injected wallet (test-only, key in
// this Node process) and a fresh regtest unified address from the engine's
// qa-local helper. Starts its own Vite dev server in real mode on :5198.
const { spawn, spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const nacl = require('tweetnacl')
const bs58 = require('bs58').default || require('bs58')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')

const WEB = path.resolve(__dirname, '..')
const ENGINE = path.resolve(WEB, '../engine')
const OUT = path.join(__dirname, 'real')
const APP = 'http://localhost:5198/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function engine(args) {
  const r = spawnSync('bun', ['scripts/qa-local.ts', ...args], { cwd: ENGINE, encoding: 'utf8', timeout: 180_000 })
  const j = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}')
  if (!j.ok) throw new Error(`qa-local ${args[0]} failed: ${j.error}`)
  return j
}

;(async () => {
  mkdirSync(OUT, { recursive: true })
  const coins = (await (await fetch('http://localhost:8787/api/coins')).json()).coins
  const snarks = coins.find((c) => c.symbol === 'SNARKS')
  const vite = spawn('npx', ['vite', '--port', '5198', '--strictPort'], { cwd: WEB, env: { ...process.env, VITE_API: 'real' }, stdio: 'ignore', detached: true })
  process.on('exit', () => { try { process.kill(-vite.pid) } catch { /* gone */ } })
  for (let i = 0; i < 60; i++) { try { if ((await fetch(APP)).ok) break } catch { /* not yet */ } await sleep(500) }

  const kp = nacl.sign.keyPair()
  const PK = bs58.encode(kp.publicKey)
  const { ua } = engine(['zwallet', `shots-${Date.now()}`])

  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const page = await browser.newPage()
  await page.exposeFunction('__qaSign', (bytes) => Array.from(nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey)))
  await page.evaluateOnNewDocument((pk) => {
    const publicKey = { toBase58: () => pk, toString: () => pk }
    window.phantom = { solana: {
      isPhantom: true, publicKey: null,
      async connect() { this.publicKey = publicKey; return { publicKey } },
      async signMessage(b) { return { signature: Uint8Array.from(await window.__qaSign(Array.from(b))) } },
      async signTransaction() { throw new Error('not used in screenshots') },
    } }
  }, PK)
  const click = (sel, t) => page.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t)); el && el.click() }, sel, t)

  const views = [['desktop', 1440, 900], ['phone', 390, 844]]
  for (const [name, width, height] of views) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 })
    await page.goto(APP + '#/', { waitUntil: 'networkidle0' }); await sleep(900)
    await page.screenshot({ path: path.join(OUT, `home-${name}.png`) })
    await page.goto(APP + `#/coin/${snarks.mint}`, { waitUntil: 'networkidle0' }); await sleep(900)
    await page.screenshot({ path: path.join(OUT, `coin-${name}.png`) })
    await page.goto(APP + '#/treasury', { waitUntil: 'networkidle0' }); await sleep(900)
    // Frame the newest epoch row (its Solana sig, Zcash txid, simulated swap) under the totals.
    await page.evaluate(() => { const r = document.querySelector('.rows'); if (r) window.scrollTo(0, r.getBoundingClientRect().top + window.scrollY - 140) }); await sleep(300)
    await page.screenshot({ path: path.join(OUT, `treasury-${name}.png`) })
    await page.goto(APP + '#/shielded', { waitUntil: 'networkidle0' }); await sleep(600)
    if (!(await page.evaluate(() => /shielded delivery is on/i.test(document.body.innerText)))) {
      await click('button', 'Connect wallet'); await sleep(200); await click('button', 'Phantom'); await sleep(400)
      await page.type('textarea', ua)
      await click('button', 'Sign and get my rewards shielded')
    } else {
      await click('button', 'Connect wallet'); await sleep(200); await click('button', 'Phantom')
    }
    for (let i = 0; i < 40 && !(await page.evaluate(() => /shielded delivery is on/i.test(document.body.innerText))); i++) await sleep(250)
    await sleep(300)
    await page.screenshot({ path: path.join(OUT, `optin-${name}.png`) })
  }
  await browser.close()
  console.log('wrote 8 screenshots to', OUT)
  process.exit(0)
})().catch((e) => { console.error('SHOTS FAILED', e.message); process.exit(1) })
