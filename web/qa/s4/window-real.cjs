// S4 ST-LW-04: the launch window on the coin page against the REAL local engine (VITE_API=real on an API over the local validator). A coin is launched
// through the API with a key held here (funded by engine/scripts/qa-local.ts), its page is opened at once with that key injected as the wallet, and the
// page is watched: Buy held as "Wait N s" while the engine says time is left, the coin asked once a second meanwhile, the quote's window-fee row during,
// Buy open after, then a real buy from the page. Test-only.
//   node qa/s4/window-real.cjs <app url> <api base> [shots dir]
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const { Connection, Keypair, VersionedTransaction } = require(path.resolve(__dirname, '../../node_modules/@solana/web3.js'))
const { CHROME, newWallet, openPage, connect, sleep } = require('../launch-helpers.cjs')

const APP = process.argv[2] || 'http://localhost:5192'
const API = process.argv[3] || 'http://127.0.0.1:8796/api'
const SHOTS = process.argv[4] || path.resolve(__dirname, '../../../engine/data/stress/s4-shots')
const ENGINE = path.resolve(__dirname, '../../../engine')
const out = []
const say = (id, pass, detail) => { out.push({ id, pass, detail }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${JSON.stringify(detail)}`) }
const api = async (method, p, body) => { const r = await fetch(API + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }
const state = (p) => p.evaluate(() => {
  const btn = [...document.querySelectorAll('.trade button')].find((b) => /^(Wait \d+ s|Buy \$|Sell \$|Confirm)/.test(b.textContent.trim()))
  const line = document.querySelector('.trade .window')
  const feeRow = [...document.querySelectorAll('.trade .qrow')].find((r) => r.textContent.includes('Fee now (launch window)'))
  return { t: Date.now(), btn: btn ? btn.textContent.trim().replace(/\s+/g, ' ') : null, disabled: btn ? btn.disabled : null, line: line ? line.textContent.replace(/\s+/g, ' ').trim() : null, feeRow: feeRow ? feeRow.textContent.replace(/\s+/g, ' ').trim() : null }
})

;(async () => {
  const wallet = newWallet()
  const fund = spawnSync('bun', ['scripts/qa-local.ts', 'fund', wallet.pk], { cwd: ENGINE, encoding: 'utf8', env: { ...process.env, PAD_MODE: 'local' } })
  const funded = JSON.parse((fund.stdout || '').trim().split('\n').pop() || '{}')
  if (!funded.ok) throw new Error(`fund failed: ${fund.stderr}`)
  const kp = Keypair.fromSecretKey(wallet.kp.secretKey)
  const conn = new Connection('http://127.0.0.1:8899', 'confirmed')
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME })
  try {
    const { page, errors } = await openPage(browser, wallet, { width: 1440, height: 900 })
    const coinPolls = []
    let mint = null
    page.on('request', (r) => { if (mint && new URL(r.url()).pathname === `/api/coins/${mint}`) coinPolls.push(Date.now()) })
    // launch through the API with this key, exactly as the Launch page would, then open the page at once
    const made = await api('POST', '/coins/launch-tx', { creator: wallet.pk, name: 'S4 UI window', symbol: 'S4UI', description: '', imageUrl: '', feeTier: 100, initialBuyZec: '10000000' })
    if (made.status !== 200) throw new Error(`launch-tx ${made.status} ${made.body.error}`)
    mint = made.body.mint
    const tx = VersionedTransaction.deserialize(Buffer.from(made.body.tx, 'base64'))
    tx.sign([kp])
    const sig = await conn.sendRawTransaction(tx.serialize())
    await conn.confirmTransaction(sig, 'confirmed')
    const confirmed = await api('POST', '/coins/confirm', { sig, mint })
    const t0 = Date.now()
    await page.goto(`${APP}/#/coin/${mint}`, { waitUntil: 'domcontentloaded' })
    await connect(page, wallet.pk)
    await page.type('input[inputmode=decimal]', '0.1')
    const samples = []
    let shot = false
    while (Date.now() - t0 < 11000) {
      const s = await state(page)
      s.t = s.t - t0
      samples.push(s)
      if (!shot && s.line && s.feeRow) { await page.screenshot({ path: `${SHOTS}/window-real-during.png` }); shot = true }
      await sleep(250)
    }
    const during = samples.filter((s) => /^Wait \d+ s$/.test(s.btn || ''))
    const waits = [...new Set(during.map((s) => Number(/Wait (\d+) s/.exec(s.btn)[1])))]
    const closedAt = samples.find((s) => s.btn === 'Buy $S4UI')
    const after = samples.filter((s) => closedAt && s.t >= closedAt.t)
    const pollsWhileOpen = coinPolls.filter((t) => during.length && t - t0 <= during[during.length - 1].t).length
    const openSeconds = during.length ? Math.max(1, Math.round((during[during.length - 1].t - during[0].t) / 1000)) : 0
    say('ST-LW-04a against the real engine: Buy reads Wait N s and is disabled while the engine says time is left, counting down; the line shows the step fee', during.length > 0 && during.every((s) => s.disabled === true && /^Launch window: \d+ s left, fee now (99|79\.4|59\.8|40\.2|20\.6)%$/.test(s.line || '')) && waits.every((n, i) => i === 0 || n < waits[i - 1]),
      { confirmed: confirmed.status, samplesDuring: during.length, waits, firstLine: during[0] && during[0].line, lastLine: during[during.length - 1] && during[during.length - 1].line, pageErrors: errors })
    say('ST-LW-04b the page asks the engine about the coin about once a second while the window is open', pollsWhileOpen >= Math.max(1, openSeconds - 1), { pollsWhileOpen, openSeconds, totalPolls: coinPolls.length })
    // right after the close the box asks for a fresh quote (Buy is off for that half second), then Buy stays open and the window-fee row is gone within 3 s
    const settled = after.filter((s) => s.t >= closedAt.t + 3000)
    say('ST-LW-04c the quote shows the window fee row during; once the engine says the window has closed Buy opens, and within 3 s it stays open with the window-fee row gone', during.some((s) => s.feeRow) && !!closedAt && settled.length > 0 && settled.every((s) => s.btn === 'Buy $S4UI' && s.disabled === false && s.line === null && s.feeRow === null) && after.every((s) => s.line === null), { feeRowExample: (during.find((s) => s.feeRow) || {}).feeRow, closedAtMs: closedAt && closedAt.t, firstAfter: after.slice(0, 6).map((s) => [s.t, s.btn, s.disabled, s.feeRow]), settledSamples: settled.length })
    await page.screenshot({ path: `${SHOTS}/window-real-after.png` })
    // a real buy from the page after the window
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.trade button')].find((x) => x.textContent.trim() === 'Buy $S4UI' && !x.disabled); if (!b) return false; b.click(); return true })
    let sent = false
    for (let i = 0; i < 60 && !sent; i++) { sent = /Sent\. Signature|Sent\b/.test(await page.evaluate(() => document.querySelector('.trade') ? document.querySelector('.trade').innerText : '')); if (!sent) await sleep(500) }
    await sleep(1500)
    const trades = await api('GET', `/coins/${mint}/trades`)
    const mine = (trades.body.trades || []).filter((t) => t.wallet === wallet.pk)
    say('ST-LW-04d after the window a buy from the page signs, lands and is recorded on the tape as this wallet\'s trade', clicked && sent && mine.length >= 1 && wallet.signed.txs >= 1 && errors.length === 0, { clicked, sent, recordedForWallet: mine.length, signedTxs: wallet.signed.txs, pageErrors: errors })
    // a visitor with no wallet: the quote comes from GET /quote, whose fee is the chain's clock (cached 2 s): after the close the window-fee row must settle to nothing by itself
    const made2 = await api('POST', '/coins/launch-tx', { creator: wallet.pk, name: 'S4 UI window two', symbol: 'S4UIB', description: '', imageUrl: '', feeTier: 100, initialBuyZec: '10000000' })
    const tx2 = VersionedTransaction.deserialize(Buffer.from(made2.body.tx, 'base64'))
    tx2.sign([kp])
    const sig2 = await conn.sendRawTransaction(tx2.serialize())
    await conn.confirmTransaction(sig2, 'confirmed')
    await api('POST', '/coins/confirm', { sig: sig2, mint: made2.body.mint })
    const guest = await browser.newPage()
    const guestErrors = []
    guest.on('pageerror', (e) => guestErrors.push(e.message))
    await guest.setViewport({ width: 1440, height: 900 })
    const g0 = Date.now()
    await guest.goto(`${APP}/#/coin/${made2.body.mint}`, { waitUntil: 'domcontentloaded' })
    await sleep(300)
    await guest.type('input[inputmode=decimal]', '0.1')
    const gs = []
    while (Date.now() - g0 < 12000) { const s = await state(guest); s.t = s.t - g0; gs.push(s); await sleep(250) }
    // a visitor has no Buy button (the box offers Connect wallet), so the window line itself is the signal
    const gDuring = gs.filter((s) => /^Launch window: \d+ s left/.test(s.line || ''))
    const gClosed = gs.find((s) => s.line === null && gDuring.length > 0 && s.t > gDuring[gDuring.length - 1].t)
    const gSettled = gs.filter((s) => gClosed && s.t >= gClosed.t + 3000)
    say('ST-LW-04e a visitor with no wallet: the window-fee row shows during the window and is gone by itself within 3 s of the close (the quote is asked again until it carries the coin\'s fee)', gDuring.some((s) => s.feeRow) && !!gClosed && gSettled.length > 0 && gSettled.every((s) => s.feeRow === null && s.line === null) && guestErrors.length === 0, { during: gDuring.length, feeRowExample: (gDuring.find((s) => s.feeRow) || {}).feeRow, closedAtMs: gClosed && gClosed.t, afterClose: gs.filter((s) => gClosed && s.t >= gClosed.t).slice(0, 14).map((s) => [s.t, s.btn, s.feeRow]), pageErrors: guestErrors })
    await guest.close()
  } finally {
    await browser.close()
  }
  console.log(JSON.stringify({ summary: { pass: out.filter((o) => o.pass).length, fail: out.filter((o) => !o.pass).length } }))
})().catch((e) => { console.error(e); process.exit(1) })
