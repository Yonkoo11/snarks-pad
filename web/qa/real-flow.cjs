// Real-stack flow check: the web app (VITE_API=real) against the engine API on
// :8787, solana-test-validator on :8899 and the Zcash regtest chain. Test-only:
// the "wallet" here is a fake injected provider (window.phantom.solana) added
// by puppeteer; its key lives in this Node process and signs through an
// exposed function. Nothing in this file ships in the web bundle.
//
// Needs, already running: engine API (cd engine && bun run api) on a stack
// that has been seeded (bun run e2e, or local:up + seed + epoch).
// Starts its own Vite dev server in real mode on :5198.
//
//   node qa/real-flow.cjs          -> prints PASS/FAIL, writes qa/REAL-FLOW-RESULT.txt
const { spawn, spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const nacl = require('tweetnacl')
const bs58 = require('bs58').default || require('bs58')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')

const WEB = path.resolve(__dirname, '..')
const ENGINE = path.resolve(WEB, '../engine')
// `--devnet`: the same flow against the devnet engine API (Solana devnet + Zcash testnet; start it with
// `engine/scripts/devnet.sh bun run api` on PAD_API_PORT=8788). The browser and this script read the PUBLIC devnet RPC
// (a keyed RPC URL must never reach a browser); the engine uses the keyed one. Writes qa/REAL-FLOW-DEVNET.txt.
const DEVNET = process.argv.includes('--devnet')
const MODE = DEVNET ? 'devnet' : 'local'
const API = DEVNET ? 'http://localhost:8788/api' : 'http://localhost:8787/api'
const RPC = DEVNET ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899'
const RESULT_FILE = DEVNET ? 'REAL-FLOW-DEVNET.txt' : 'REAL-FLOW-RESULT.txt'
const PORT = 5198
const APP = `http://localhost:${PORT}/`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lines = []
const results = []
function log(s) { console.log(s); lines.push(s) }
function check(label, pass, detail = '') {
  results.push(pass)
  log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  return pass
}

function engine(args) {
  const cmd = DEVNET ? ['scripts/devnet.sh', 'bun', 'scripts/qa-local.ts', ...args] : ['bun', 'scripts/qa-local.ts', ...args]
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ENGINE, encoding: 'utf8', timeout: DEVNET ? 900_000 : 180_000 })
  const last = (r.stdout || '').trim().split('\n').pop() || '{}'
  const j = JSON.parse(last)
  if (!j.ok) throw new Error(`qa-local ${args[0]} failed: ${j.error}`)
  return j
}
function sql(q) {
  const r = spawnSync('sqlite3', [path.join(ENGINE, `data/${MODE}.sqlite`), q], { encoding: 'utf8' })
  return (r.stdout || '').trim()
}
// A long child process (an epoch waits for Zcash testnet blocks, 15+ minutes) must not block this process: while it is blocked the
// browser's connection goes silent and the session dies ("Session closed"). Short helpers above stay synchronous.
function runAsync(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

async function api(p, init) {
  // One retry on a network error only: spawnSync (epoch, zbalance) blocks this
  // process long enough for the API to close an idle keep-alive socket that
  // undici then tries to reuse. HTTP errors are never retried.
  const res = await fetch(API + p, init).catch(() => sleep(300).then(() => fetch(API + p, init)))
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null, mode: res.headers.get('x-pad-mode') }
}
// Contract v2.9: a wallet's shielded delivery is read only against its own signature, so the check signs the status text with the test wallet's key, the way the page does.
async function optinStatusOf(kp, pk) {
  const { body } = await api(`/optin/nonce?wallet=${pk}`)
  const message = `SNARKS pad: show my shielded delivery settings and rewards\nwallet: ${pk}\nnonce: ${body.nonce}`
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey))
  return api('/optin/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: pk, nonce: body.nonce, signature }) })
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return (await r.json()).result
}
async function waitFor(fn, ms, every = 250) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}

async function waitForVite() {
  return waitFor(async () => (await fetch(APP)).ok, 30_000)
}

;(async () => {
  log(`snarks-launchpad real-flow run, ${new Date().toISOString()}`)
  log(DEVNET ? 'stack: web (VITE_API=real, vite :5198) + engine API :8788 (PAD_MODE=devnet) + Solana devnet + Zcash testnet (swap simulated)' : 'stack: web (VITE_API=real, vite :5198) + engine API :8787 + solana-test-validator :8899 + Zcash regtest')
  log('')

  // ---- preconditions
  const coinsRes = await api('/coins').catch(() => null)
  if (!coinsRes || coinsRes.status !== 200) { log(`engine API not reachable at ${API}`); process.exit(2) }
  check(`API reports ${MODE} mode`, coinsRes.mode === MODE, `x-pad-mode=${coinsRes.mode}`)
  const snarks = coinsRes.body.coins.find((c) => c.symbol === 'SNARKS')
  if (!snarks) { log('no seeded SNARKS coin (run: cd engine && bun run e2e)'); process.exit(2) }
  // Precondition: SNARKS may have graduated in this local state, so the curve-progress rule is checked on a coin the test
  // launches itself (certainly on the curve, with some progress), and SNARKS is checked against whichever stage it is in.
  const qc = engine(['curvecoin'])
  const curveCoin = (await api('/coins')).body.coins.find((c) => c.mint === qc.mint)
  if (!curveCoin || curveCoin.stage !== 'curve' || !(curveCoin.curveProgress > 0)) { log(`precondition failed: the fresh coin is not on the curve with progress: ${JSON.stringify(curveCoin)}`); process.exit(2) }
  // Precondition (devnet): every run buys and fee-trades on one coin, and SNARKS is the public demo coin whose curve has a fixed size,
  // so repeated runs fill it and the next exact-in buy is refused ("Insufficient Liquidity"). Devnet therefore trades on the
  // fresh curve coin above (6+ ZEC of room, nobody else holding it); locally the chain is rebuilt per run and SNARKS is used.
  const tradeCoin = DEVNET ? curveCoin : snarks

  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: WEB, env: { ...process.env, VITE_API: 'real', VITE_API_BASE: API, VITE_RPC: RPC }, stdio: 'ignore', detached: true })
  const stopVite = () => { try { process.kill(-vite.pid) } catch { /* gone */ } }
  process.on('exit', stopVite)
  if (!(await waitForVite())) { log('vite did not start'); process.exit(2) }

  // ---- test identities
  const kp = nacl.sign.keyPair()
  const PK = bs58.encode(kp.publicKey)
  const zname = `flow-${Date.now()}`
  const funds = engine(['fund', PK])
  const { ua } = engine(['zwallet', zname])
  log(`test wallet ${PK} (funded by the ${DEVNET ? `devnet faucet key: ${funds.sol} SOL + ${Number(funds.zecZats) / 1e8} stand-in ZEC` : 'local helper: 5 SOL + 5 local Solana ZEC'}); fresh ${DEVNET ? 'Zcash testnet' : 'regtest'} wallet qa-${zname}, UA ${ua.slice(0, 12)}…${ua.slice(-6)}`)
  log('')
  const signed = { messages: 0, txs: 0 }

  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const pageErrors = []
  async function openPage() {
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.setViewport({ width: 1280, height: 900 })
    await page.exposeFunction('__qaSign', (bytes, kind) => {
      signed[kind === 'tx' ? 'txs' : 'messages']++
      return Array.from(nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey))
    })
    await page.evaluateOnNewDocument((pk) => {
      const publicKey = { toBase58: () => pk, toString: () => pk }
      window.phantom = {
        solana: {
          isPhantom: true,
          publicKey: null,
          async connect() { this.publicKey = publicKey; return { publicKey } },
          async disconnect() { this.publicKey = null },
          async signMessage(bytes) { return { signature: Uint8Array.from(await window.__qaSign(Array.from(bytes), 'msg')) } },
          async signTransaction(tx) {
            const i = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === pk)
            if (i < 0 || i >= tx.message.header.numRequiredSignatures) throw new Error('wallet is not a required signer')
            tx.signatures[i] = Uint8Array.from(await window.__qaSign(Array.from(tx.message.serialize()), 'tx'))
            return tx
          },
        },
      }
    }, PK)
    return page
  }
  // The browser tab sits idle for the whole epoch wait; a fresh tab after it avoids a tab Chrome has frozen or detached.
  let page = await openPage()

  const text = () => page.evaluate(() => document.body.innerText)
  const html = () => page.evaluate(() => document.documentElement.outerHTML)
  const has = (s) => async () => (await text()).includes(s)
  const hasI = (re) => async () => re.test(await text())
  const clickText = (sel, t) => page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled)
    if (!el) return false
    el.click(); return true
  }, sel, t)
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h }, hash); await sleep(600) }
  async function connect() {
    if (!(await clickText('main button, section button', 'Connect wallet'))) await clickText('button', 'Connect wallet')
    await sleep(150)
    await clickText('button', 'Phantom')
    return waitFor(async () => (await text()).includes(PK.slice(0, 4) + '…' + PK.slice(-4)), 5000)
  }

  // ---- home: seeded SNARKS with real curve progress and price
  await page.goto(APP + '#/', { waitUntil: 'networkidle0' })
  await waitFor(has(`${MODE.toUpperCase()} MODE`), 5000)
  const home = await text()
  check(`mode banner says ${MODE} mode`, home.includes(`${MODE.toUpperCase()} MODE`))
  check('home shows seeded $SNARKS', home.includes('$SNARKS'))
  const pct = (x) => `${Math.round(x * 1000) / 10}%`
  const snarksShown = snarks.stage === 'graduated' ? 'graduated to Meteora' : `${pct(snarks.curveProgress)} to graduation`
  check('home shows SNARKS at its real stage', home.includes(snarksShown), `"${snarksShown}" from API stage=${snarks.stage} curveProgress=${snarks.curveProgress}`)
  check('home shows the real curve progress of a coin still on the curve', home.includes(`$${curveCoin.symbol}`) && home.includes(pct(curveCoin.curveProgress)), `${pct(curveCoin.curveProgress)} from API curveProgress=${curveCoin.curveProgress} for $${curveCoin.symbol}`)
  check('home price is non-zero', !/PRICE\s*\n\s*0 ZEC/i.test(home) && Number(snarks.priceZec) > 0, `priceZec=${snarks.priceZec} zats/token, marketCap=${snarks.marketCapZec} zats`)

  // ---- opt-in with a real regtest unified address
  await go('#/shielded')
  check('wallet connects through the injected provider', !!(await connect()))
  await page.type('textarea', ua)
  await clickText('button', 'Sign and get my rewards shielded')
  const optedIn = await waitFor(hasI(/shielded delivery is on/i), 15_000)
  const afterOptin = await text()
  check('opt-in succeeds in the UI', !!optedIn)
  check('page never shows the full address after opt-in', !(await html()).includes(ua))
  const unsigned = await api(`/optin/${PK}`)
  check('GET /optin/:wallet is gone: an unsigned read says nothing about opting in (v2.9)', unsigned.status === 404 && !unsigned.text.includes('optedIn'), `status ${unsigned.status}`)
  const st1 = await optinStatusOf(kp, PK)
  check('POST /optin/status (signed) -> optedIn true', st1.body?.optedIn === true, st1.text)
  const [mHead, mTail] = String(st1.body?.zcashAddressMasked || '').split('…')
  check('POST /optin/status returns the masked form only', !!mHead && ua.startsWith(mHead) && ua.endsWith(mTail) && !st1.text.includes(ua), `zcashAddressMasked=${st1.body?.zcashAddressMasked}`)
  check('engine stored the exact address', sql(`SELECT zcashAddress = '${ua}' AND active = 1 FROM optins WHERE wallet = '${PK}'`) === '1', 'sqlite optins row matches (compared in sqlite, not printed)')
  check('UI shows the masked address', afterOptin.includes(st1.body?.zcashAddressMasked || '##'))

  // ---- opt-out
  await clickText('button', 'Stop shielded delivery')
  check('opt-out returns to the form', !!(await waitFor(has('Paste your Zcash unified address'), 15_000)))
  const st2 = await optinStatusOf(kp, PK)
  check('POST /optin/status (signed) -> optedIn false after opt-out', st2.body?.optedIn === false && st2.body?.zcashAddressMasked === null, st2.text)

  // ---- opt back in so the epoch below pays this wallet shielded
  await page.type('textarea', ua)
  await clickText('button', 'Sign and get my rewards shielded')
  check('opt back in (for the epoch payout)', !!(await waitFor(hasI(/shielded delivery is on/i), 15_000)))

  // ---- buy via trade-tx, signed in the page, sent to the local validator
  engine(['sample']) // what the keeper loop does at random times: this wallet holds nothing yet, so it is absent from this sample
  const before = engine(['solbalance', PK]).balances
  await go(`#/coin/${tradeCoin.mint}`)
  await waitFor(has('You pay (ZEC)'), 8000)
  await page.type('input[inputmode=decimal]', '1')
  check('trade-tx quote shows', !!(await waitFor(has('You get about'), 15_000)))
  await clickText('button', `Buy $${tradeCoin.symbol}`)
  check('buy sent from the page', !!(await waitFor(has('Done. Signature'), 30_000)))
  const sigs = await rpc('getSignaturesForAddress', [PK, { limit: 5, commitment: 'confirmed' }])
  const buySig = sigs?.[0]?.signature
  const status = buySig ? (await rpc('getSignatureStatuses', [[buySig], { searchTransactionHistory: true }])).value[0] : null
  check('buy confirmed on chain without error', !!status && status.err === null && ['confirmed', 'finalized'].includes(status.confirmationStatus), `sig ${buySig}`)
  const after = engine(['solbalance', PK]).balances
  const zecMint = engine(['quotemint']).mint // the real ZEC mint locally, the stand-in mint on devnet
  const dTok = BigInt(after[tradeCoin.mint] || '0') - BigInt(before[tradeCoin.mint] || '0')
  const dZec = BigInt(after[zecMint] || '0') - BigInt(before[zecMint] || '0')
  check(`wallet received $${tradeCoin.symbol} and paid 1 Solana ZEC`, dTok > 0n && dZec === -100_000_000n, `token +${dTok} base units, Solana ZEC ${dZec} zats`)
  const shownTrade = await waitFor(async () => {
    const d = await api(`/coins/${tradeCoin.mint}`)
    return d.body?.recentTrades?.find((t) => t.sig === buySig)
  }, 15_000)
  check('engine recorded the trade from chain (trade-confirm)', !!shownTrade && shownTrade.wallet === PK && shownTrade.side === 'buy', shownTrade ? `amountZec=${shownTrade.amountZec} amountToken=${shownTrade.amountToken}` : 'not in recentTrades')

  // ---- launch via launch-tx, with a picture picked from a file and the three links (contract v2.7)
  await go('#/launch')
  await waitFor(has('Trading fee'), 5000)
  check('launch page states the fixed fee, the 60/20/20 split and that Meteora can pause the graduated pool', (await text()).includes('60% of every fee, in ZEC') && (await text()).includes('on every trade, paid in ZEC, fixed at launch') && /holders \$0\.60/.test(await text()) && /the team \$0\.20/.test(await text()) && /Meteora \$0\.20/.test(await text()) && (await text()).includes('Meteora can pause the pool') && !/raydium/i.test(await text()))
  const sym = 'QA' + String(Date.now()).slice(-6)
  const inputs = await page.$$('form input.input')
  await inputs[0].type('QA Flow Coin')
  await inputs[1].type(sym)
  await page.type('form textarea', 'Launched by web/qa/real-flow.cjs on the local validator.')
  await (await page.$('input[type=file]')).uploadFile(path.join(WEB, 'public', 'mascot-256.jpg'))
  check('the picture picked from a file is uploaded to the engine and the page says what was stored', !!(await waitFor(hasI(/Uploaded\. \d+ × \d+, \d+ (B|KB|MB)\./), 30_000)))
  await clickText('summary', 'Links'); await sleep(200)
  const linkInputs = await page.$$('.socials input')
  await linkInputs[0].type('example.com/qa-flow'); await linkInputs[1].type('@qaflowcoin'); await linkInputs[2].type('t.me/qaflowcoin')
  await clickText('button', `Launch $${sym}`)
  const live = await waitFor(has('is live.'), 45_000)
  const launchErr = live ? '' : (await text()).match(/The pad refused[^\n]*|[^\n]*failed[^\n]*/i)?.[0] || ''
  check('launch signed, sent and confirmed from the page', !!live, launchErr)
  const newMint = live ? await page.evaluate(() => (document.querySelector('a[href^="#/coin/"]')?.getAttribute('href') || '').split('/').pop()) : ''
  const mintAcct = newMint ? await rpc('getAccountInfo', [newMint, { encoding: 'base64', commitment: 'confirmed' }]) : null
  check(`new mint exists on ${MODE} (Token-2022)`, mintAcct?.value?.owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', `mint ${newMint}`)
  const newCoin = newMint ? await api(`/coins/${newMint}`) : null
  check('GET /coins/:mint serves the new coin with a pool', newCoin?.status === 200 && !!newCoin.body.poolId, newCoin ? `poolId=${newCoin.body?.poolId}` : '')
  const socials = newCoin?.body?.socials || {}
  check('GET /coins/:mint carries the three links as https addresses and the engine\'s own copy of the picture', socials.website === 'https://example.com/qa-flow' && socials.x === 'https://x.com/qaflowcoin' && socials.telegram === 'https://t.me/qaflowcoin' && /\/i\/[0-9a-f]{24}\.jpg$/.test(newCoin?.body?.imageUrl || ''), `${JSON.stringify(socials)} ${newCoin?.body?.imageUrl}`)
  const metaRes = newCoin?.body?.imageUrl ? await fetch(`${new URL(newCoin.body.imageUrl).origin}/m/${newMint}.json`).catch(() => null) : null
  const meta = metaRes ? await metaRes.json().catch(() => null) : null
  check('the metadata JSON behind the coin names the picture and the links', !!meta && meta.image === newCoin.body.imageUrl && meta.extensions?.website === socials.website && meta.extensions?.twitter === socials.x && meta.extensions?.telegram === socials.telegram, meta ? `image ${meta.image}` : 'no JSON')
  await go('#/')
  check('new coin shows on the home page', !!(await waitFor(has('QA Flow Coin'), 8000)))

  // ---- epoch 1: the opted-in wallet bought AFTER a holder sample, so the minimum-balance rule (audit O-1) pays it nothing this epoch
  await page.goto('about:blank') // stop the app polling the treasury wallet while the epoch spends from it
  // Precondition: the per-holder shielded floor (production: 100,000 zats) is set to 1 for these runs. This wallet's share shrinks as
  // earlier runs leave more holders behind, and a share under the floor is carried, which would make the exact-share check depend on history.
  // The shielded swap minimum (production: 1,000,000 zats, the bridge's floor) is set to 1 as well: this wallet's share of one run's fees
  // can stay under it (on devnet it is the only opted-in holder of the fresh trade coin), and a carried share would make the exact-share
  // check depend on what earlier runs left behind. The swap is simulated in both modes.
  const epochEnv = { ...process.env, PAD_SHIELDED_MIN_PER_HOLDER_ZATS: '1', PAD_SHIELDED_MIN_SWAP_ZATS: '1' }
  async function runEpoch(label) {
    // Devnet: the epoch stops for the Squads claim approval and for Zcash testnet confirmations, so a driver reruns it to the end.
    const ep = DEVNET
      ? await runAsync('scripts/devnet.sh', ['bun', 'scripts/devnet-epoch.ts'], { cwd: ENGINE, timeout: 3_000_000, env: epochEnv })
      : spawnSync('bun', ['run', 'epoch'], { cwd: ENGINE, encoding: 'utf8', timeout: 400_000, env: epochEnv })
    const line = (ep.stdout || '').trim().split('\n').filter((l) => /^(\S+ )?(epoch |EPOCH OK)/.test(l) && !/run \d+$/.test(l)).slice(-2).join(' ')
    const err = ((ep.stderr || '') + (ep.stdout || '')).split('\n').filter((l) => /fail|error/i.test(l)).slice(-3).join(' | ').slice(0, 600)
    check(`${DEVNET ? 'devnet epoch driver' : 'bun run epoch'} exits 0 (${label})`, ep.status === 0, ep.status === 0 ? line : `exit ${ep.status}: ${err}`)
  }
  // Outside local mode a payout is marked sent right after broadcast, and a Zcash testnet block takes about 75 s, so a recipient's own
  // wallet shows the payout some minutes later. Wait for its balance to move (at most 12 minutes); the check below is unchanged.
  async function zbalanceAfterPayout(from) {
    const deadline = Date.now() + (DEVNET ? 720_000 : 0)
    let z = BigInt(engine(['zbalance', zname]).totalZats)
    while (z === from && Date.now() < deadline) {
      await sleep(45_000)
      z = BigInt(engine(['zbalance', zname]).totalZats)
    }
    return z
  }
  const z0 = BigInt(engine(['zbalance', zname]).totalZats)
  await runEpoch('epoch 1')
  const z1 = BigInt(engine(['zbalance', zname]).totalZats)
  const epoch1 = (await api('/epochs')).body.epochs[0]
  const paid1 = sql(`SELECT amountZats FROM payouts WHERE epochId = '${epoch1.id}' AND wallet = '${PK}' AND kind = 'shielded' AND sentAt IS NOT NULL`)
  check('a wallet that bought after the last holder sample is paid nothing this epoch (minimum-balance rule)', z1 === z0 && paid1 === '', `before ${z0} zats, after ${z1} zats, payout row ${paid1 || 'none'}`)

  // ---- epoch 2: new fees, a sample that includes the wallet; now the opted-in wallet's regtest balance must rise by exactly its planned share
  engine(['feetrade', tradeCoin.mint, '300000000'])
  engine(['sample'])
  await runEpoch('epoch 2')
  const z2 = await zbalanceAfterPayout(z1)
  const epochs = (await api('/epochs')).body.epochs
  const latest = epochs[0]
  const planned = sql(`SELECT amountZats FROM payouts WHERE epochId = '${latest.id}' AND wallet = '${PK}' AND kind = 'shielded' AND sentAt IS NOT NULL`)
  check('opted-in wallet regtest balance rose by exactly its planned share', latest.id !== epoch1.id && z2 > z1 && planned !== '' && z2 - z1 === BigInt(planned), `before ${z1} zats, after ${z2} zats, planned ${planned || 'none'} zats, read from its own devtool wallet`)
  check('latest epoch: status ok, shielded batch with a Zcash txid, swap simulated', latest.status === 'ok' && latest.shielded.count >= 1 && latest.shielded.zcashTxids.length === 1 && latest.shielded.swap.provider === 'simulated', `id=${latest.id} shielded.count=${latest.shielded.count} txid=${latest.shielded.zcashTxids[0]}`)

  // ---- treasury shows the real epoch
  await page.close()
  page = await openPage()
  await page.goto(APP + '#/treasury', { waitUntil: 'networkidle0' })
  await waitFor(has('Every epoch'), 8000)
  await sleep(800)
  const tr = await text()
  const txid = latest.shielded.zcashTxids[0] || '##'
  const solSig = latest.solanaPayouts.sigs[0]
  check('treasury shows the real regtest Zcash txid', tr.includes(txid.slice(0, 8)) && tr.includes(txid.slice(-6)), txid)
  check('treasury shows the real Solana payout signature', !solSig || (tr.includes(solSig.slice(0, 6)) && tr.includes(solSig.slice(-4))), solSig || '(no Solana leg this epoch)')
  check('treasury labels the swap leg "simulated"', /simulated/i.test(tr))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('"anonymous" never rendered', !/anonymous/i.test(tr + home + afterOptin))
  log(`signatures made by the injected wallet: ${signed.messages} messages, ${signed.txs} transactions`)

  await browser.close()
  stopVite()
  const pass = results.every(Boolean)
  log('')
  log(pass ? `RESULT: PASS (${results.length} checks)` : `RESULT: FAIL (${results.filter((r) => !r).length}/${results.length} checks failed)`)
  writeFileSync(path.join(__dirname, RESULT_FILE), lines.join('\n') + '\n')
  process.exit(pass ? 0 : 1)
})().catch((e) => {
  log('FLOW CRASH ' + (e && e.message))
  writeFileSync(path.join(__dirname, RESULT_FILE), lines.join('\n') + '\n')
  process.exit(1)
})
