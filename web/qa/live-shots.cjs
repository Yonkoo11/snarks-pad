// Screenshots of the new Launch form and of a coin page with its links, on a DEPLOYED pad (or the local dev build), light and dark, 1440 and 390 wide.
// Each state is its own page load, as a visitor would meet it:
//   launch-empty          the form before anything is typed, no wallet connected
//   launch-filled         wallet connected, name, ticker and description typed, a picture picked from a file and uploaded (to the pad: the same picture
//                         is the same file), the Links section open with the three links
//   launch-upload-error   the same picture picked while the upload cannot reach the pad (the request is cut): the words, Try again, Replace, Remove
//   launch-image-refused  (1440 and 390, light) a file that is not a picture, named like one, refused on its first bytes before anything is sent
//   launch-form-1pct      the form filled (no links) on the 1% tier, 1440 dark and 390 light: the fee sentence and First buy; no Creator wallet field, which shows
//                         only on a tier with a creator share (copy pass, 2026-10-07)
//   launch-form-2pct      the 2% tier, 1440 dark and 390 light, a Creator wallet typed: the one fee line, the field under First buy, the address shown back in full,
//                         the warning and the tick
//   launch-form-4pct      the same at the 4% tier (an earlier review's frame)
//   coin-links            the coin page of --mint, with its picture, the link chips and the warning
//   coin-fixed            the coin page of --mint with its "Token info" tab open (1440 dark, 390 light; the tab was "What is fixed" until the copy pass of 2026-10-07)
//   node qa/live-shots.cjs https://<host>/ <out dir> --mint <coin mint>
//   node qa/live-shots.cjs https://<host>/ <out dir> --only launch-form          (only the states whose name starts with this)
// The test wallet is a fresh key made in this process and never funded. Nothing is launched.
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const H = require('./launch-helpers.cjs')

const APP = (process.argv[2] || '').replace(/\/?$/, '/')
const OUT = path.resolve(process.argv[3] || '')
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const MINT = arg('--mint')
const ONLY = arg('--only')
if (!/^https?:\/\//.test(APP) || !process.argv[3]) { console.error('usage: node qa/live-shots.cjs https://<host>/ <out dir> [--mint <coin mint>]'); process.exit(2) }
const FRAMES = [[1440, 900], [390, 844]]
const THEMES = ['light', 'dark']

async function shoot(browser, wallet, name, { width, height, theme }, setup, hash = '#/launch') {
  const { page, errors } = await H.openPage(browser, wallet, { width, height, theme })
  await page.goto(APP + hash, { waitUntil: 'networkidle2' })
  await H.sleep(800)
  if (setup) await setup(page)
  await H.sleep(500)
  const file = path.join(OUT, `${name}-${width}-${theme}.png`)
  // the whole page, taken in a window as tall as the page: a fullPage capture leaves the phone's fixed bottom bar where the first screen ended
  await page.setViewport({ width, height: Math.max(height, await page.evaluate(() => document.documentElement.scrollHeight)), deviceScaleFactor: 1 })
  await H.sleep(300)
  await page.screenshot({ path: file })
  console.log(file, errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : '')
  await page.close()
  return errors
}

const fill = (page) => H.fillLaunchForm(page, { name: 'Crayon Moon', symbol: 'MOON', description: 'A moon drawn outside the lines, for everyone who ever coloured past the edge.' })

const OTHER = H.newWallet() // the Creator wallet typed into its field: an address that is not the connected wallet, never funded

/** The form filled (no links) and the tier picked; on a tier with a creator share a different wallet typed into the Creator wallet field, which is in view under First buy. */
const formAt = (tier) => async (page, wallet) => {
  await H.connect(page, wallet.pk)
  await H.fillLaunchForm(page, { name: 'Crayon Moon', symbol: 'MOON', description: 'A moon drawn outside the lines, for everyone who ever coloured past the edge.', links: null })
  if (tier !== 100) await page.evaluate((v) => document.querySelector(`input[name="fee-tier"][value="${v}"]`).click(), tier)
  await H.sleep(300)
  if (tier !== 100) await H.setValue(page, '.creator input.input', 0, OTHER.pk)
}

const states = [
  ['launch-empty', null, [1440, 390], THEMES],
  ['launch-filled', async (page, wallet) => { await H.connect(page, wallet.pk); await fill(page) }, [1440, 390], THEMES],
  ['launch-upload-error', async (page, wallet) => {
    await page.setRequestInterception(true)
    page.on('request', (req) => { if (req.method() === 'POST' && /\/api\/uploads$/.test(req.url())) req.abort('failed'); else req.continue() })
    await H.connect(page, wallet.pk)
    await H.fillLaunchForm(page, { name: 'Crayon Moon', symbol: 'MOON', description: 'A moon drawn outside the lines.', links: null, waitUpload: false })
    await H.waitForText(page, /The upload did not work/, 20_000)
  }, [1440, 390], THEMES],
  ['launch-image-refused', async (page, wallet) => { await H.connect(page, wallet.pk); await (await page.$('input[type=file]')).uploadFile(H.writeNotAPicture()); await H.waitForText(page, /That file is not a PNG, JPG, GIF or WEBP image\./, 10_000) }, [1440, 390], ['light']],
  ['launch-form-1pct', formAt(100), [1440], ['dark']],
  ['launch-form-1pct', formAt(100), [390], ['light']],
  ['launch-form-2pct', formAt(200), [1440], ['dark']],
  ['launch-form-2pct', formAt(200), [390], ['light']],
  ['launch-form-4pct', formAt(400), [1440], ['dark']],
  ['launch-form-4pct', formAt(400), [390], ['light']],
]

;(async () => {
  mkdirSync(OUT, { recursive: true })
  const wallet = H.newWallet()
  const browser = await puppeteer.launch({ headless: 'new', executablePath: H.CHROME })
  let bad = 0
  for (const [name, setup, widths, themes] of states.filter(([n]) => !ONLY || n.startsWith(ONLY))) {
    for (const [width, height] of FRAMES.filter(([w]) => widths.includes(w))) {
      for (const theme of themes) bad += (await shoot(browser, wallet, name, { width, height, theme }, setup && ((page) => setup(page, wallet)))).length
    }
  }
  const wanted = (name) => !ONLY || name.startsWith(ONLY)
  if (MINT && wanted('coin-links')) {
    for (const [width, height] of FRAMES) for (const theme of THEMES) bad += (await shoot(browser, wallet, 'coin-links', { width, height, theme }, null, `#/coin/${MINT}`)).length
  }
  if (MINT && wanted('coin-fixed')) {
    const openFixed = async (page) => { await H.clickText(page, '.ctabs [role=tab]', 'Token info'); await H.waitForText(page, /no paid placements on this pad\./, 20_000) }
    for (const [width, height, theme] of [[1440, 900, 'dark'], [390, 844, 'light']]) bad += (await shoot(browser, wallet, 'coin-fixed', { width, height, theme }, openFixed, `#/coin/${MINT}`)).length
  }
  await browser.close()
  console.log(bad ? `${bad} page errors` : 'no page errors')
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
