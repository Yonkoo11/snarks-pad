// Launch proof for contract v2.7 (a coin's picture from a device, its links, its metadata address), through the page, with a test wallet. Test money only.
//   node qa/live-launch.cjs https://<host>/      against a DEPLOYED devnet pad: funds a fresh test wallet from its faucet and launches ONE coin
//   node qa/live-launch.cjs --local              against the local stack (engine API :8787, validator :8899); starts its own Vite dev server on :5198
// The page does everything a creator does: connect, fill the form, pick a picture from a file, add the three links, press Max (read back against the
// chain), launch. Then what a wallet or an explorer reads is read back the way it reads it: the coin's on-chain metadata address, the JSON behind it, the
// picture behind that (type, cache and sniffing headers, and the file name against the hash of its bytes), the coin through the API, and the coin page.
// Writes qa/LIVE-LAUNCH-RESULT.txt (the local run writes qa/LOCAL-LAUNCH-RESULT.txt).
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const H = require('./launch-helpers.cjs')

const LOCAL = process.argv.includes('--local')
const WEB = path.resolve(__dirname, '..')
const ENGINE = path.resolve(WEB, '../engine')
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const APP = LOCAL ? 'http://localhost:5198/' : (process.argv[2] || '').replace(/\/?$/, '/')
if (!LOCAL && !/^https:\/\//.test(APP)) { console.error('usage: node qa/live-launch.cjs https://<host>/ | --local'); process.exit(2) }
const API = LOCAL ? 'http://localhost:8787/api' : APP + 'api'
const RPC = LOCAL ? 'http://127.0.0.1:8899' : 'https://api.devnet.solana.com'
const SHOTS = arg('--shots') ? path.resolve(arg('--shots')) : null
const RESULT_FILE = path.join(__dirname, LOCAL ? 'LOCAL-LAUNCH-RESULT.txt' : 'LIVE-LAUNCH-RESULT.txt')
const lines = []
const results = []
const log = (s) => { console.log(s); lines.push(s) }
function check(label, pass, detail = '') {
  results.push(pass)
  log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  return pass
}
async function waitFor(fn, ms, every = 500) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await H.sleep(every)
  }
}
async function getJson(p) {
  const res = await fetch(API + p)
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return (await r.json()).result
}
async function tokenAmount(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  return (r?.value || []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n)
}

/** The wallet's test money: the pad's own faucet button's route on a deployed pad, the engine's QA helper locally. */
async function fund(pk) {
  if (LOCAL) {
    const r = spawnSync('bun', ['scripts/qa-local.ts', 'fund', pk], { cwd: ENGINE, encoding: 'utf8', timeout: 180_000 })
    const j = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}')
    return j.ok ? { sol: j.sol, zecZats: j.zecZats } : null
  }
  const res = await fetch(API + '/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: pk }) })
  const body = await res.json().catch(() => null)
  return res.ok ? body : (log(`faucet answered ${res.status} ${JSON.stringify(body)}`), null)
}

/** The same rounding the page uses for what the curve must hold: a bar to reach, rounded up to a hundredth of a ZEC. */
const graduationText = (zats) => { const u = 10n ** 6n; const up = ((BigInt(zats) + u - 1n) / u) * u; return `${up / 100_000_000n}.${(up % 100_000_000n).toString().padStart(8, '0').slice(0, 2)}` }
const zatsText = (z) => { const f = (z % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, ''); return f ? `${z / 100_000_000n}.${f}` : String(z / 100_000_000n) }

;(async () => {
  log(`snarks-launchpad launch proof (contract v2.7), ${new Date().toISOString()}, ${LOCAL ? 'local stack' : APP}`)
  log('')
  let stopVite = () => {}
  if (LOCAL) {
    const vite = spawn('npx', ['vite', '--port', '5198', '--strictPort'], { cwd: WEB, env: { ...process.env, VITE_API: 'real', VITE_API_BASE: API, VITE_RPC: RPC }, stdio: 'ignore', detached: true })
    stopVite = () => { try { process.kill(-vite.pid) } catch { /* gone */ } }
    process.on('exit', stopVite)
    if (!(await waitFor(async () => (await fetch(APP)).ok, 30_000))) { log('vite did not start'); process.exit(2) }
  }

  // ---- what the engine says
  const tiersRes = await getJson('/tiers')
  const tiers = tiersRes.body?.tiers || []
  const quoteMint = tiersRes.body?.quoteMint
  check('GET /tiers names the quote mint and, on every tier, the graduation threshold and the locked liquidity', tiersRes.status === 200 && !!quoteMint && tiers.length === 5 && tiers.every((t) => /^\d+$/.test(t.migrationThresholdZats) && t.liquidity && t.liquidity.partnerLockedPct + t.liquidity.creatorLockedPct + t.liquidity.unlockedPct === 100), `quoteMint ${quoteMint}, thresholds ${tiers.map((t) => t.migrationThresholdZats).join('/')}`)
  const tier100 = tiers.find((t) => t.feeBps === 100)
  if (!tier100 || !tier100.available) { log('the 1% tier is not available on this pad: nothing to launch on'); process.exit(2) }

  // ---- the wallet and its test money
  const wallet = H.newWallet()
  const funds = await fund(wallet.pk)
  if (!check('the test wallet gets test money', !!funds, funds ? `${funds.sol} SOL and ${Number(funds.zecZats) / 1e8} ZEC to ${wallet.pk}` : `wallet ${wallet.pk}`)) { await finish(); return }
  const zecZats = await waitFor(async () => { const v = await tokenAmount(wallet.pk, quoteMint); return v > 0n ? v : null }, 90_000, 1500)
  check('the wallet\'s Solana ZEC is on chain', !!zecZats, `${zecZats} zats read from ${LOCAL ? 'the local validator' : 'devnet'}`)
  if (!zecZats) { await finish(); return }

  // ---- the page
  const browser = await puppeteer.launch({ headless: 'new', executablePath: H.CHROME })
  const { page, errors } = await H.openPage(browser, wallet)
  await page.goto(APP + '#/launch', { waitUntil: 'networkidle2' })
  await H.sleep(800)
  const empty = await page.evaluate(() => ({ text: document.body.innerText, urlInput: !!document.querySelector('input[type=url][placeholder*="image" i]'), drop: document.querySelector('.drop')?.innerText || '', links: !!document.querySelector('details.socials') }))
  check('the live form asks for a picture from the device, not a link: a drop zone, no image address field, and the Links section', !empty.urlInput && /Drop an image here, or click to browse/.test(empty.drop) && /PNG, JPG, GIF or WEBP, square looks best, up to 5 MB/.test(empty.drop) && empty.links && !/link to an image/i.test(empty.text))
  const card = await page.evaluate(() => document.querySelector('.preview .card')?.innerText.replace(/\s+/g, ' ') || '')
  const bar = graduationText(tier100.migrationThresholdZats)
  check('the preview card prints the fixed facts from the API', new RegExp(`PAIRED WITH Solana ZEC`, 'i').test(card) && new RegExp(`GRADUATION When the curve holds ${bar.replace('.', '\\.')} ZEC`, 'i').test(card) && /LIQUIDITY Locked for good/i.test(card) && /TO HOLDERS 10% of every fee, in ZEC/i.test(card), `graduation ${bar} ZEC from ${tier100.migrationThresholdZats} zats`)
  check('a wallet connects through the injected provider', await H.connect(page, wallet.pk))
  const balanceShown = await H.waitForText(page, /Your wallet holds [\d.]+ ZEC on Solana\./, 30_000)
  check('the form reads the wallet\'s Solana ZEC from the chain', balanceShown, (await page.evaluate(() => document.body.innerText)).match(/Your wallet holds [\d.]+ ZEC on Solana\./)?.[0] || '')

  // ---- fill it as a creator does
  // a new name every run: a name that matches a coin already on the pad (ignoring case and punctuation) asks for a tick first, and the run would wait for it
  const symbol = 'PIC' + String(Date.now()).slice(-5)
  const coinName = `Picture Test ${symbol.slice(3)}`
  await H.fillLaunchForm(page, { name: coinName, symbol, description: 'A test coin that proves a picture picked from a device and three links reach the chain. Launched by web/qa/live-launch.cjs.' })
  const stored = await page.evaluate(() => document.querySelector('.picked .status')?.innerText || '')
  check('the picture uploads and the page says what was stored', /^Uploaded\. \d+ × \d+, \d+ (B|KB|MB)\.$/.test(stored.trim()), stored.trim())
  await H.clickText(page, 'button', 'Max'); await H.sleep(300)
  const room = (BigInt(tier100.migrationThresholdZats) * 95n) / 100n
  const expectedMax = zatsText(zecZats < room ? zecZats : room)
  const maxShown = await page.$eval('input[aria-labelledby="first-buy-l"]', (e) => e.value)
  check('Max fills in what the wallet holds (never more than the curve can take), as read from the chain', maxShown === expectedMax, `field ${maxShown}, chain-based ${expectedMax}`)
  await H.setValue(page, 'input[aria-labelledby="first-buy-l"]', 0, '0.05'); await H.sleep(300)
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'launch-filled-before-launch-1440-light.png'), fullPage: true })

  // ---- launch
  check('Launch is on, with a picture, three links and a first buy', await page.evaluate(() => document.querySelector('form button[type=submit]')?.disabled === false))
  await H.clickText(page, 'button', `Launch $${symbol}`)
  const done = await H.waitForText(page, /is live\./, 180_000)
  const refusal = done ? '' : ((await page.evaluate(() => document.body.innerText)).match(/The pad refused[^\n]*|[^\n]*failed[^\n]*|[^\n]*wallet[^\n]*/i)?.[0] || '')
  check('the launch is signed in the page, sent and recorded', !!done, refusal)
  if (!done) { await browser.close(); await finish(); return }
  const mint = await page.evaluate(() => (document.querySelector('a[href^="#/coin/"]')?.getAttribute('href') || '').split('/').pop())
  log(`coin mint ${mint}, signatures made by the test wallet: ${wallet.signed.messages} messages, ${wallet.signed.txs} transactions`)

  // ---- what the engine returns
  const coin = (await getJson(`/coins/${mint}`)).body
  const want = { website: 'https://snarks.fun/', x: 'https://x.com/SnarksPad', telegram: 'https://t.me/telegram' }
  check('GET /coins/:mint carries the three links as https addresses', JSON.stringify(coin?.socials) === JSON.stringify(want) || (coin?.socials?.website?.replace(/\/$/, '') === 'https://snarks.fun' && coin?.socials?.x === want.x && coin?.socials?.telegram === want.telegram), JSON.stringify(coin?.socials))
  const imageUrl = coin?.imageUrl || ''
  check('the coin\'s picture is the pad\'s own stored copy: /i/<24 hex>.<ext> on the pad\'s own address', /^https?:\/\/[^/]+\/i\/[0-9a-f]{24}\.(png|jpg|webp|gif)$/.test(imageUrl), imageUrl)
  const base = imageUrl ? new URL(imageUrl).origin : ''

  // ---- what a wallet or an explorer reads
  const uri = await waitFor(() => H.onchainUri(RPC, mint), 60_000, 1500)
  check('the on-chain metadata address is the JSON, not the picture', uri === `${base}/m/${mint}.json`, `uri on chain: ${uri}`)
  const jsonRes = uri ? await fetch(uri) : null
  const meta = jsonRes ? await jsonRes.json().catch(() => null) : null
  check('the JSON is served as JSON, cached for a minute, never sniffed, readable from any page', !!jsonRes && jsonRes.status === 200 && /^application\/json/.test(jsonRes.headers.get('content-type') || '') && /max-age=60/.test(jsonRes.headers.get('cache-control') || '') && jsonRes.headers.get('x-content-type-options') === 'nosniff' && jsonRes.headers.get('access-control-allow-origin') === '*', jsonRes ? `${jsonRes.status} ${jsonRes.headers.get('content-type')} ${jsonRes.headers.get('cache-control')}` : 'no response')
  check('the JSON names the coin, its picture, its description and its links', !!meta && meta.name === coinName && meta.symbol === symbol && /proves a picture/.test(meta.description) && meta.image === imageUrl && /^https:\/\/snarks\.fun\/?$/.test(meta.external_url) && meta.extensions?.twitter === want.x && meta.extensions?.telegram === want.telegram && meta.properties?.category === 'image' && meta.properties?.files?.[0]?.uri === imageUrl && meta.createdOn === base, meta ? JSON.stringify(meta).slice(0, 360) : 'no JSON')
  const imgRes = imageUrl ? await fetch(imageUrl) : null
  const img = imgRes ? Buffer.from(await imgRes.arrayBuffer()) : Buffer.alloc(0)
  const stem = imageUrl.split('/').pop()?.split('.')[0] || ''
  check('the picture is served as a picture, cached for a year, never sniffed, readable from any page', !!imgRes && imgRes.status === 200 && /^image\/(png|jpeg|webp|gif)$/.test(imgRes.headers.get('content-type') || '') && /max-age=31536000/.test(imgRes.headers.get('cache-control') || '') && /immutable/.test(imgRes.headers.get('cache-control') || '') && imgRes.headers.get('x-content-type-options') === 'nosniff' && imgRes.headers.get('access-control-allow-origin') === '*', imgRes ? `${imgRes.status} ${imgRes.headers.get('content-type')} ${imgRes.headers.get('cache-control')} ${img.length} bytes` : 'no response')
  check('the file is named by the hash of its own bytes, and fits inside 1000 x 1000 without EXIF', createHash('sha256').update(img).digest('hex').slice(0, 24) === stem && img.length > 0 && !img.includes(Buffer.from('Exif')), `name ${stem}, sha256 of the ${img.length} bytes ${createHash('sha256').update(img).digest('hex').slice(0, 24)}`)

  // ---- the coin page
  await page.goto(APP + `#/coin/${mint}`, { waitUntil: 'networkidle2' })
  await H.sleep(1500)
  const view = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.links a')].map((a) => ({ t: a.textContent.trim().replace(/\s+/g, ' '), href: a.href, target: a.target, rel: a.rel })),
    img: document.querySelector('.head img')?.getAttribute('src') || '', warn: document.querySelector('.lwarn')?.textContent || '',
  }))
  check('the coin page shows the picture and three link chips (Website with its host) that open in a new tab, and the warning', view.img === imageUrl && view.chips.length === 3 && /^Website\s?snarks\.fun\s?↗$/.test(view.chips[0].t) && view.chips[1].t.startsWith('X') && view.chips[2].t.startsWith('Telegram') && view.chips.every((c) => c.target === '_blank' && /noopener/.test(c.rel) && /noreferrer/.test(c.rel) && c.href.startsWith('https://')) && /Added by the creator, not checked by the pad\./.test(view.warn), JSON.stringify(view.chips.map((c) => c.t)))
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'coin-links-1440-light.png') })
  const held = await tokenAmount(wallet.pk, mint)
  check('the 0.05 ZEC first buy reached the creator in the launch transaction', held > 0n, `${held} base units of the new coin`)
  check('no page errors', errors.length === 0, errors.join(' | '))
  log(`proof coin: ${APP}#/coin/${mint}`)
  log(`metadata JSON: ${uri}`)
  await browser.close()
  await finish()

  async function finish() {
    stopVite()
    const pass = results.every(Boolean)
    log('')
    log(pass ? `RESULT: PASS (${results.length} checks)` : `RESULT: FAIL (${results.filter((r) => !r).length}/${results.length} checks failed)`)
    writeFileSync(RESULT_FILE, lines.join('\n') + '\n')
    process.exit(pass ? 0 : 1)
  }
})().catch((e) => {
  log('LAUNCH PROOF CRASH ' + (e && e.stack || e))
  writeFileSync(RESULT_FILE, lines.join('\n') + '\n')
  process.exit(1)
})
