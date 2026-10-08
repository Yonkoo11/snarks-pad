// Review screenshots: every route x 1440x900 / 390x844 (2x) / 1280x720 x light / dark, plus the key states (loading,
// empty, error, wallet connected, opted in, paused, devnet banner, faucet dry, graduated coin, 10% tier confirm, 404).
// The theme is forced through localStorage 'snarks-theme' (what the header button writes) and the OS media query.
//   node qa/review-shots.cjs <base url> <out dir> [--live]
// Mock states use the mock's own query flags; --live (a deployed devnet pad) takes only the route x width x theme set.
const { mkdirSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')

const BASE = (process.argv[2] || 'http://localhost:5199/').replace(/\/?$/, '/')
const OUT = process.argv[3] || path.resolve(__dirname, '../../design/review-2026-10-04d')
const LIVE = process.argv.includes('--live')
// --only=<regex> renders only the routes and states whose name matches (to finish or redo part of a folder)
const ONLY = new RegExp((process.argv.find((a) => a.startsWith('--only=')) || '--only=').slice(7) || '.')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FRAMES = { 1440: [1440, 900, 1, true], 390: [390, 844, 2, true], 1280: [1280, 720, 1, false] } // w, h, scale, full page

const u1 = 'u1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(4)
const clickText = (p, sel, t) => p.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled)
  if (!el) return false
  el.click(); return true
}, sel, t)
const MASCOT = path.resolve(__dirname, '../public/mascot-256.jpg') // a picture to pick from the device
const pick = async (p, file) => { await (await p.$('input[type=file]')).uploadFile(file); await sleep(1500) }
const connect = async (p) => { await clickText(p, 'button', 'Connect wallet'); await sleep(150); await clickText(p, 'button', 'Test wallet'); await sleep(400) }

// name, hash (+ mock query), frames, themes, setup(page) run after load, loading = screenshot before the data lands
const routes = [
  ['home', '#/'], ['coin', 'COIN'], ['launch', '#/launch'], ['shielded', '#/shielded'], ['treasury', '#/treasury'],
  ['how', '#/how'], ['terms', '#/terms'], ['privacy', '#/privacy'], ['risk', '#/risk'], ['404', '#/nothing-here'],
]
const allStates = [
  ['home-loading', '', '#/', [1440, 390], ['light', 'dark'], null, true],
  ['home-empty', '?empty=1', '#/', [1440, 390], ['light'], null],
  ['home-list', '', '#/', [1440, 390], ['light', 'dark'], async (p) => { await clickText(p, '.view button', 'List'); await sleep(300) }],
  ['home-graduated-tab', '', '#/', [1440], ['light'], async (p) => { await clickText(p, '[role=tab]', 'Graduated'); await sleep(500) }],
  ['home-rising-tab', '', '#/', [1440], ['dark'], async (p) => { await clickText(p, '[role=tab]', 'Rising'); await sleep(500) }],
  ['home-search-none', '', '#/', [1440, 390], ['light'], async (p) => { await p.type('input.search', 'zzz'); await sleep(700) }],
  ['home-pages', '?many=1', '#/', [1440, 390], ['light'], null],
  ['home-no-stats', '?stats=off', '#/', [1440], ['light'], null],
  ['home-error', '?fail=1', '#/', [1440, 390], ['light', 'dark'], null],
  ['home-connected', '', '#/', [1440], ['light'], connect],
  ['home-paused', '?paused=1', '#/', [1440, 390], ['light', 'dark'], null],
  ['home-devnet', '?devnet=1', '#/', [1440, 390], ['light', 'dark'], connect],
  ['home-devnet-faucet-dry', '?devnet=1&faucet=dry', '#/', [1440, 390], ['light', 'dark'], connect],
  ['coin-loading', '', 'COIN', [1440, 390], ['light', 'dark'], null, true],
  ['coin-error', '?fail=1', 'COIN', [1440, 390], ['light'], null],
  ['coin-connected-quote', '', 'COIN', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await p.type('input[inputmode=decimal]', '0.1'); await sleep(900) }],
  // the buy box (2026-10-04d): a quote with no wallet and 10% slippage, the short-of-ZEC state, a sell sized from the holding, the v2.5 fallback
  ['coin-quote-no-wallet', '', 'COIN', [1440, 390], ['light', 'dark'], async (p) => { await clickText(p, '.presets .pre', '0.5 ZEC'); await clickText(p, '.slip-r .pre', '10%'); await sleep(1000) }],
  ['coin-short-zec', '', 'COIN', [1440, 390], ['light'], async (p) => { await connect(p); await p.type('input[inputmode=decimal]', '1'); await sleep(1000) }],
  ['coin-sell', '', 'COIN', [1440], ['dark'], async (p) => { await connect(p); await clickText(p, '[role=tab]', 'Sell'); await sleep(200); await clickText(p, '.presets .pre', '50%'); await sleep(1000) }],
  ['coin-v25-engine', '?v25=1', 'COIN', [1440, 390], ['light'], async (p) => { await p.type('input[inputmode=decimal]', '0.1'); await sleep(800) }],
  // the tabs
  ['coin-holders', '', 'COIN', [1440, 390], ['light', 'dark'], async (p) => { await clickText(p, '.ctabs [role=tab]', 'Holders'); await sleep(900) }],
  ['coin-rewards', '', 'COIN', [1440, 390], ['light', 'dark'], async (p) => { await clickText(p, '.ctabs [role=tab]', 'Rewards'); await sleep(900) }],
  ['coin-fixed', '', 'COIN', [1440, 390], ['light', 'dark'], async (p) => { await clickText(p, '.ctabs [role=tab]', 'Token info'); await sleep(900) }],
  ['coin-holders-v25', '?v25=1', 'COIN', [1440], ['light'], async (p) => { await clickText(p, '.ctabs [role=tab]', 'Holders'); await sleep(900) }],
  ['coin-fixed-v25', '?v25=1', 'COIN', [1440], ['light'], async (p) => { await clickText(p, '.ctabs [role=tab]', 'Token info'); await sleep(900) }],
  ['coin-graduated', '', 'HALO', [1440, 390], ['light', 'dark'], null],
  ['coin-chart-empty', '?chart=empty', 'COIN', [1440], ['light'], null],
  ['coin-chart-error', '?chart=error', 'COIN', [1440], ['light'], null],
  ['coin-bad-mint', '', '#/coin/not-a-mint', [1440, 390], ['light'], null],
  ['launch-loading', '', '#/launch', [1440], ['light'], null, true],
  ['launch-error', '?fail=1', '#/launch', [1440, 390], ['light'], null],
  ['launch-connected', '', '#/launch', [1440, 390], ['light', 'dark'], connect],
  ['launch-tier10', '', '#/launch', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await clickText(p, 'label.tier', '10%'); await sleep(300) }],
  ['launch-tier-unavailable', '?tier10=off', '#/launch', [1440], ['light'], null],
  // the launch form (2026-10-04d, v2.7 2026-10-05): the lookalike warning with bad links, the picture from the device with the links filled in, a picture the page refuses, an upload that fails
  ['launch-lookalike', '', '#/launch', [1440, 390], ['light', 'dark'], async (p) => {
    await connect(p)
    const set = (sel, i, v) => p.evaluate((sel, i, v) => { const el = document.querySelectorAll(sel)[i]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, sel, i, v)
    await set('form input.input', 0, 'Release The Snarks'); await set('form input.input', 1, 'SNARK'); await set('.socials input', 0, 'notaurl'); await set('.socials input', 1, 'bad handle!'); await sleep(400)
  }],
  ['launch-links', '', '#/launch', [1440, 390], ['light', 'dark'], async (p) => {
    await connect(p)
    const set = (sel, i, v) => p.evaluate((sel, i, v) => { const el = document.querySelectorAll(sel)[i]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, sel, i, v)
    await set('form input.input', 0, 'Crayon Moon'); await set('form input.input', 1, 'MOON'); await set('form textarea', 0, 'A moon drawn outside the lines.')
    await pick(p, MASCOT)
    await clickText(p, 'summary', 'Links'); await sleep(200)
    await set('.socials input', 0, 'example.com/moon'); await set('.socials input', 1, '@crayonmoon'); await set('.socials input', 2, 't.me/crayonmoon'); await sleep(400)
  }],
  ['launch-picture-refused', '', '#/launch', [1440, 390], ['light'], async (p) => {
    const bad = path.join(os.tmpdir(), 'review-not-a-picture.png')
    writeFileSync(bad, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await pick(p, bad)
  }],
  ['launch-upload-fail', '?upload=fail', '#/launch', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await pick(p, MASCOT) }],
  ['shielded-connected', '', '#/shielded', [1440, 390], ['light', 'dark'], connect],
  // my rewards with a verified memo (2026-10-04d), and the v2.5 engine without either block
  ['shielded-verified', '', '#/shielded', [1440, 390], ['light', 'dark'], async (p) => {
    await connect(p)
    const id = await p.evaluate(async () => (await (await import('/src/lib/mock/index.ts')).mock.epochs()).epochs.find((e) => e.shielded.count > 0).id)
    await p.evaluate((t) => { const i = document.querySelector('.verify input'); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })) }, 'SNARKS pad reward, epoch ' + id)
    await clickText(p, '.verify button', 'Verify memo'); await sleep(900)
  }],
  ['shielded-v25-engine', '?v25=1', '#/shielded', [1440], ['light'], connect],
  ['home-v25-engine', '?v25=1', '#/', [1440, 390], ['light'], null],
  ['shielded-taddr', '', '#/shielded', [1440], ['light'], async (p) => { await connect(p); await p.type('textarea', 't1XyzAbcdefghijkmnopqrstuvwxyz123456'); await sleep(300) }],
  ['shielded-opted-in', '', '#/shielded', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await p.type('textarea', u1); await clickText(p, 'button', 'Sign and get my rewards shielded'); await sleep(1500) }],
  ['treasury-loading', '', '#/treasury', [1440], ['light'], null, true],
  ['treasury-empty', '?empty=1', '#/treasury', [1440, 390], ['light'], null],
  ['treasury-error', '?fail=1', '#/treasury', [1440, 390], ['light', 'dark'], null],
  ['treasury-all-rounds', '', '#/treasury', [1440], ['light'], async (p) => { await clickText(p, 'button', 'Show all'); await sleep(300) }],
  ['wallet-menu', '', '#/', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await clickText(p, 'button.addr', '…'); await sleep(300) }],
  // the wallet profile (v2.9): a visitor's three tabs, the owner's five, the signed-out #/me and a link that is not a wallet
  ['profile-visitor', '', 'CREATOR', [1440, 390], ['light', 'dark'], async (p) => { await sleep(900) }],
  ['profile-visitor-launched', '', 'CREATOR', [1440, 390], ['light'], async (p) => { await clickText(p, '[role=tab]', 'Launched'); await sleep(900) }],
  ['profile-visitor-trades', '', 'CREATOR', [1440, 390], ['light'], async (p) => { await clickText(p, '[role=tab]', 'Trades'); await sleep(900) }],
  ['profile-me-signed-out', '', '#/me', [1440, 390], ['light'], null],
  ['profile-bad-address', '', '#/u/not-a-wallet', [390], ['light'], null],
  ['profile-owner', '', '#/', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await p.evaluate(() => { location.hash = '#/me' }); await sleep(1500) }],
  ['profile-owner-launched', '', '#/', [1440, 390], ['light'], async (p) => { await connect(p); await p.evaluate(() => { location.hash = '#/me?tab=launched' }); await sleep(1500) }],
  ['profile-owner-rewards', '', '#/', [1440, 390], ['light'], async (p) => { await connect(p); await p.evaluate(() => { location.hash = '#/me?tab=rewards' }); await sleep(1500); await clickText(p, 'button', 'Show shielded details'); await sleep(900) }],
  ['profile-owner-shielded', '', '#/', [1440, 390], ['light', 'dark'], async (p) => { await connect(p); await p.evaluate(() => { location.hash = '#/me?tab=shielded' }); await sleep(900) }],
  ['profile-owner-shielded-read', '', '#/', [1440, 390], ['light'], async (p) => { await connect(p); await p.evaluate(() => { location.hash = '#/me?tab=shielded' }); await sleep(900); await clickText(p, 'button', 'Show my settings'); await sleep(900) }],
]
// a deployed pad has no mock flags: only the coin tabs and the creator's profile, which need none
const states = LIVE ? allStates.filter(([n]) => /^(coin-holders|coin-rewards|coin-fixed|profile-visitor)$/.test(n)) : allStates

;(async () => {
  mkdirSync(OUT, { recursive: true })
  const b = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const errs = []
  const shots = []
  // the mints the mock gives SNARKS and HALO (the graduated coin), read from the running app
  let mints = {}
  if (!LIVE) {
    const p = await b.newPage()
    await p.goto(BASE, { waitUntil: 'networkidle0' })
    mints = await p.evaluate(async () => {
      const m = await import('/src/lib/mock/index.ts')
      const coins = (await m.mock.coins()).coins
      return { COIN: coins.find((c) => c.symbol === 'SNARKS').mint, HALO: coins.find((c) => c.symbol === 'HALO').mint, CREATOR: coins.find((c) => c.symbol === 'SNARKS').creator }
    })
    await p.close()
  } else {
    const r = await fetch(BASE + 'api/coins'); const coins = (await r.json()).coins
    mints = { COIN: (coins.find((c) => c.symbol === 'SNARKS') || coins[0]).mint, HALO: (coins.find((c) => c.stage === 'graduated') || coins[0]).mint, CREATOR: (coins.find((c) => c.symbol === 'SNARKS') || coins[0]).creator }
  }
  const target = (hash) => (hash === 'COIN' ? `#/coin/${mints.COIN}` : hash === 'HALO' ? `#/coin/${mints.HALO}` : hash === 'CREATOR' ? `#/u/${mints.CREATOR}` : hash)

  // one retry: headless Chrome now and then detaches a frame mid-navigation (puppeteer "Navigating frame was detached"); a fresh page is enough
  async function shoot(name, query, hash, frame, theme, setup, loading) {
    try { await shootOnce(name, query, hash, frame, theme, setup, loading) }
    catch (e) { console.error(`retry ${name}-${theme}-${frame}: ${e.message.split('\n')[0]}`); await sleep(500); await shootOnce(name, query, hash, frame, theme, setup, loading) }
  }
  async function shootOnce(name, query, hash, frame, theme, setup, loading) {
    const [w, h, scale, full] = FRAMES[frame]
    const p = await b.newPage()
    p.on('pageerror', (e) => errs.push(`${name}: ${e.message}`))
    p.on('console', (m) => { if (m.type() === 'error') errs.push(`${name} console: ${m.text()}`) })
    await p.evaluateOnNewDocument((t) => { try { localStorage.setItem('snarks-theme', t); sessionStorage.removeItem('snarks-test-wallet'); localStorage.removeItem('snarks-mock-v1') } catch {} }, theme)
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
    await p.setViewport({ width: w, height: h, deviceScaleFactor: scale })
    const url = BASE + query + target(hash)
    if (loading) {
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      await sleep(60)
    } else {
      // a live pad keeps one SSE stream open (GET /events/trades), so "no connections at all" never comes; two or fewer does
      await p.goto(url, { waitUntil: LIVE ? 'networkidle2' : 'networkidle0' })
      if (setup) await setup(p)
      await sleep(900)
    }
    const file = `${name}-${theme}-${frame}.png`
    await p.screenshot({ path: path.join(OUT, file), fullPage: full })
    const hscroll = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    shots.push({ file, name, theme, frame, hscroll })
    if (hscroll) errs.push(`${file}: horizontal scroll`)
    await p.close()
  }

  for (const [name, hash] of routes) if (ONLY.test(name)) for (const frame of [1440, 390, 1280]) for (const theme of ['light', 'dark']) await shoot(name, '', hash, frame, theme, null, false)
  for (const [name, query, hash, frames, themes, setup, loading] of states) if (ONLY.test(name)) for (const frame of frames) for (const theme of themes) await shoot(name, query, hash, frame, theme, setup, loading)

  await b.close()
  // a partial run (--only) adds its shots to the folder's list instead of replacing it
  let prior = []
  try { prior = JSON.parse(require('node:fs').readFileSync(path.join(OUT, 'shots.json'), 'utf8')).filter((s) => !shots.some((n) => n.file === s.file)) } catch {}
  writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify([...prior, ...shots], null, 1))
  console.log(`${shots.length} screenshots in ${OUT}`)
  console.log(errs.length ? 'ERRORS\n' + errs.join('\n') : 'no page errors, no horizontal scroll')
})().catch((e) => { console.error('SHOTS CRASH', e); process.exit(1) })
