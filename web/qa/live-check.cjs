// Judge-path check against a DEPLOYED devnet pad (no local engine): open the public site in headless Chrome with an
// injected test wallet, check the devnet banner, press the banner's faucet button, buy a coin from the page, and
// confirm on chain (public devnet RPC) that the wallet paid the ZEC and received the coin. Test money only.
// At the end the wallet's leftover SOL goes back to --return-to (the faucet key's address), so a run costs about
// the token-account rent plus fees. A faucet failure is reported with the API's own status and error code (the page only
// shows plain words), and stops the run: nothing after it can pass without test money.
//   node qa/live-check.cjs https://<host>/ [--return-to <pubkey>] [--zec 0.5]
// Writes qa/LIVE-CHECK-RESULT.txt.
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const nacl = require('tweetnacl')
const bs58 = require('bs58').default || require('bs58')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js')

const APP = (process.argv[2] || '').replace(/\/?$/, '/')
if (!/^https:\/\//.test(APP)) { console.error('usage: node qa/live-check.cjs https://<host>/ [--return-to <pubkey>] [--zec 0.5]'); process.exit(2) }
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const RETURN_TO = arg('--return-to')
const ZEC_IN = Number(arg('--zec') || '0.5')
const API = APP + 'api'
const RPC = 'https://api.devnet.solana.com'
const conn = new Connection(RPC, 'confirmed')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    await sleep(every)
  }
}
async function api(p) {
  const res = await fetch(API + p)
  return { status: res.status, body: await res.json().catch(() => null), mode: res.headers.get('x-pad-mode') }
}
// The question the page's faucet button asks, for when the page offers no button: the answer carries the API's own error code.
async function askFaucet(wallet) {
  const res = await fetch(API + '/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function tokenBalances(owner) {
  const out = {}
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(programId) })
    for (const a of r.value) out[a.account.data.parsed.info.mint] = BigInt(a.account.data.parsed.info.tokenAmount.amount)
  }
  return out
}

;(async () => {
  log(`snarks-launchpad live check, ${new Date().toISOString()}, ${APP}`)
  const coins = await api('/coins')
  check('API answers over HTTPS in devnet mode', coins.status === 200 && coins.mode === 'devnet', `x-pad-mode=${coins.mode}`)
  // The coin with the most room left on its curve, of any fee tier, so an exact-in buy is never refused for liquidity (SNARKS sits at
  // 99.5% on devnet: the program refuses a buy bigger than the room that is left, and a 1%-only filter picked it).
  const coin = coins.body.coins.filter((c) => c.stage === 'curve').sort((a, b) => a.curveProgress - b.curveProgress)[0]
  if (!coin) { log('no curve coin to buy'); process.exit(2) }

  const kp = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey)
  const PK = kp.publicKey.toBase58()
  log(`test wallet ${PK} (fresh, funded only by the site's faucet button)`)
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const pageErrors = []
  const page = await browser.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // The page's own request to the faucet: its status and error code are what a failure is reported with.
  let faucetAnswer = null
  page.on('response', async (res) => {
    if (res.request().method() === 'POST' && res.url().endsWith('/api/faucet')) faucetAnswer = { status: res.status(), body: await res.json().catch(() => null) }
  })
  await page.setViewport({ width: 1280, height: 900 })
  await page.exposeFunction('__qaSign', (bytes) => Array.from(nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey)))
  await page.evaluateOnNewDocument((pk) => {
    const publicKey = { toBase58: () => pk, toString: () => pk }
    window.phantom = { solana: {
      isPhantom: true, publicKey: null,
      async connect() { this.publicKey = publicKey; return { publicKey } },
      async disconnect() { this.publicKey = null },
      async signMessage(bytes) { return { signature: Uint8Array.from(await window.__qaSign(Array.from(bytes))) } },
      async signTransaction(tx) {
        const i = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === pk)
        if (i < 0 || i >= tx.message.header.numRequiredSignatures) throw new Error('wallet is not a required signer')
        tx.signatures[i] = Uint8Array.from(await window.__qaSign(Array.from(tx.message.serialize())))
        return tx
      },
    } }
  }, PK)
  const text = () => page.evaluate(() => document.body.innerText)
  const has = (s) => async () => (await text()).includes(s)
  const clickText = (sel, t) => page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled)
    if (!el) return false
    el.click(); return true
  }, sel, t)

  await page.goto(APP + '#/', { waitUntil: 'networkidle2' })
  check('site loads and the banner says DEVNET MODE', !!(await waitFor(has('DEVNET MODE'), 10_000)))
  check('home lists $SNARKS', (await text()).includes('$SNARKS'))

  await clickText('button', 'Connect wallet'); await sleep(200); await clickText('button', 'Phantom')
  check('wallet connects', !!(await waitFor(has(PK.slice(0, 4) + '…' + PK.slice(-4)), 8000)))
  const faucetStatus = (await api('/treasury')).body?.faucet
  log(`faucet status (GET /api/treasury): ${JSON.stringify(faucetStatus)}`)
  const pressed = await clickText('button', 'Get test SOL and ZEC')
  check('faucet button shows for a connected wallet', pressed, pressed ? '' : 'no button on the page (the page says the faucet has no test money)')
  // With no button, ask the API the same question the button would, so the failure names its own error code.
  const answer = pressed ? await waitFor(async () => faucetAnswer, 60_000) : await askFaucet(PK)
  const funded = answer?.status === 200 && answer.body?.ok === true
  check('faucet sends test SOL and ZEC', funded, funded ? `${answer.body.sol} SOL and ${Number(answer.body.zecZats) / 1e8} ZEC` : answer ? `HTTP ${answer.status} ${answer.body?.error ?? '(no error code in the answer)'}` : 'no answer in 60 s')
  if (funded && pressed) check('the page shows what the faucet sent', !!(await waitFor(has(`Sent: ${answer.body.sol} devnet SOL`), 10_000)))
  if (!funded) { log('stopping: nothing after this step can pass without test money'); return finish() }
  const sol = await waitFor(async () => { const b = await conn.getBalance(kp.publicKey); return b > 0 ? b : null }, 30_000)
  const before = await tokenBalances(PK)
  const zecMint = Object.keys(before).find((m) => before[m] === 500_000_000n)
  check('chain shows the faucet SOL and 5 test ZEC', !!sol && !!zecMint, `${(sol || 0) / 1e9} SOL; stand-in ZEC mint ${zecMint || 'not found'}`)

  const seen = new Set((await conn.getSignaturesForAddress(kp.publicKey, { limit: 20 })).map((s) => s.signature))
  await page.evaluate((h) => { location.hash = h }, `#/coin/${coin.mint}`)
  await waitFor(has('You pay (ZEC)'), 10_000)
  await page.type('input[inputmode=decimal]', String(ZEC_IN))
  check('buy quote shows', !!(await waitFor(has('You get about'), 20_000)))
  await clickText('button', `Buy $${coin.symbol}`)
  check('buy sent from the page', !!(await waitFor(has('Done. Signature'), 60_000)))
  const sig = await waitFor(async () => (await conn.getSignaturesForAddress(kp.publicKey, { limit: 5 }))
    .find((s) => !seen.has(s.signature) && s.confirmationStatus !== 'processed')?.signature, 30_000)
  const status = sig ? (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0] : null
  check('buy confirmed on chain without error', !!status && status.err === null, `sig ${sig}`)
  const after = await waitFor(async () => { const a = await tokenBalances(PK); return (a[coin.mint] || 0n) > 0n ? a : null }, 30_000)
  const dZec = (after?.[zecMint] ?? 0n) - before[zecMint]
  check(`wallet received $${coin.symbol} and paid ${ZEC_IN} test ZEC`, !!after && dZec === -BigInt(Math.round(ZEC_IN * 1e8)), `token +${after?.[coin.mint] ?? 0n}, ZEC ${dZec} zats`)
  const shown = await waitFor(async () => (await api(`/coins/${coin.mint}`)).body?.recentTrades?.find((t) => t.sig === sig), 30_000)
  check('the API lists the buy in recentTrades', !!shown)
  return finish()

  // Closes the browser, sends the wallet's leftover SOL back, and writes the result: also the way out of a run that cannot go on.
  async function finish() {
    check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    await browser.close()
    if (RETURN_TO) {
      const bal = await conn.getBalance(kp.publicKey)
      const fee = 5000
      if (bal > fee) {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(RETURN_TO), lamports: bal - fee }))
        const s = await conn.sendTransaction(tx, [kp]).catch((e) => `failed: ${e.message}`)
        log(`returned ${(bal - fee) / 1e9} SOL to ${RETURN_TO}: ${s}`)
      }
    }
    const pass = results.every(Boolean)
    log(`\n${results.filter(Boolean).length}/${results.length} checks passed: ${pass ? 'PASS' : 'FAIL'}`)
    writeFileSync(path.join(__dirname, 'LIVE-CHECK-RESULT.txt'), lines.join('\n') + '\n')
    process.exit(pass ? 0 : 1)
  }
})().catch((e) => { console.error(e); process.exit(1) })
