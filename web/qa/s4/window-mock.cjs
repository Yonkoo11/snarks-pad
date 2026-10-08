// S4 ST-LW-03: the launch window on the coin page in mock mode (`?window=open` makes SNARKS look just launched), watched second by second at 1440 and
// 390 px: Buy reads "Wait N s" and is disabled, the line beside the trade box counts down with the fee, the quote shows the window fee, and when the
// engine says the window has closed Buy opens and the row goes. Test-only.
//   node qa/s4/window-mock.cjs [http://localhost:5191] [shots dir]
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const path = require('node:path')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP = process.argv[2] || 'http://localhost:5191'
const SHOTS = process.argv[3] || path.resolve(__dirname, '../../../engine/data/stress/s4-shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const say = (id, pass, detail) => { out.push({ id, pass, detail }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${JSON.stringify(detail)}`) }
const clickText = (p, sel, t) => p.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled); if (!el) return false; el.click(); return true }, sel, t)
const state = (p) => p.evaluate(() => {
  const btn = [...document.querySelectorAll('.trade button')].find((b) => /^(Wait \d+ s|Buy \$|Sell \$|Confirm)/.test(b.textContent.trim()))
  const line = document.querySelector('.trade .window')
  const feeRow = [...document.querySelectorAll('.trade .qrow')].find((r) => r.textContent.includes('Fee now (launch window)'))
  return { t: Date.now(), btn: btn ? btn.textContent.trim().replace(/\s+/g, ' ') : null, disabled: btn ? btn.disabled : null, line: line ? line.textContent.replace(/\s+/g, ' ').trim() : null, feeRow: feeRow ? feeRow.textContent.replace(/\s+/g, ' ').trim() : null, overflow: document.documentElement.scrollWidth > window.innerWidth }
})

;(async () => {
  const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME })
  try {
    for (const width of [1440, 390]) {
      const p = await b.newPage()
      const errs = []
      p.on('pageerror', (e) => errs.push(e.message))
      await p.setViewport({ width, height: width === 390 ? 844 : 900 })
      await p.goto(`${APP}/#/`, { waitUntil: 'networkidle0' })
      const mint = await p.evaluate(async () => (await import('/src/lib/mock/index.ts')).SNARKS_MINT)
      await p.goto(`${APP}/?window=open#/coin/${mint}`, { waitUntil: 'domcontentloaded' })
      const t0 = Date.now()
      await sleep(400)
      await clickText(p, 'button', 'Connect wallet')
      await sleep(150)
      await clickText(p, 'button', 'Test wallet')
      await sleep(300)
      await p.type('input[inputmode=decimal]', '0.1')
      const samples = []
      let shot = false
      while (Date.now() - t0 < 9500) {
        const s = await state(p)
        s.t = s.t - t0
        samples.push(s)
        if (!shot && s.line && s.feeRow) { await p.screenshot({ path: `${SHOTS}/window-mock-${width}-during.png` }); shot = true }
        await sleep(250)
      }
      await p.screenshot({ path: `${SHOTS}/window-mock-${width}-after.png` })
      const during = samples.filter((s) => /^Wait \d+ s$/.test(s.btn || ''))
      const waits = [...new Set(during.map((s) => Number(/Wait (\d+) s/.exec(s.btn)[1])))]
      const after = samples.filter((s) => s.t > 7500)
      const feeDuring = during.filter((s) => s.feeRow).length
      const pass = during.length > 0 && during.every((s) => s.disabled === true && /^Launch window: \d+ s left, fee now (99|79\.4|59\.8|40\.2|20\.6)%$/.test(s.line || ''))
        && waits.every((n, i) => i === 0 || n < waits[i - 1]) && feeDuring > 0 && after.length > 0
        && after.every((s) => s.btn === 'Buy $SNARKS' && s.disabled === false && s.line === null && s.feeRow === null) && errs.length === 0 && !samples.some((s) => s.overflow)
      say(`ST-LW-03 ${width}px: Buy reads Wait N s and is disabled while the window is open, the line counts down with the fee, the quote shows the window fee, then Buy $SNARKS is enabled and the fee row is gone`, pass,
        { samplesDuring: during.length, waits, firstLine: during[0] && during[0].line, lastLine: during[during.length - 1] && during[during.length - 1].line, feeRowsDuring: feeDuring, feeRowExample: (during.find((s) => s.feeRow) || {}).feeRow, afterSamples: after.length, afterButton: after[0] && after[0].btn, afterDisabled: after[0] && after[0].disabled, pageErrors: errs, overflow: samples.some((s) => s.overflow) })
      await p.close()
    }
  } finally {
    await b.close()
  }
  console.log(JSON.stringify({ summary: { pass: out.filter((o) => o.pass).length, fail: out.filter((o) => !o.pass).length } }))
})().catch((e) => { console.error(e); process.exit(1) })
