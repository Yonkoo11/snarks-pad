// S4 P1 and P2 pages in mock mode: Treasury, Shielded, How it works (sampled, >= 3 cases each) and Terms, Privacy, Risk (one load each). Test-only.
//   node qa/s4/pages.cjs [http://localhost:5191] [shots dir]
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const path = require('node:path')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP = process.argv[2] || 'http://localhost:5191'
const SHOTS = process.argv[3] || path.resolve(__dirname, '../../../engine/data/stress/s4-shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const say = (id, pass, detail) => { out.push({ id, pass, detail }); console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${JSON.stringify(detail)}`) }
const clickText = (p, sel, t) => p.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled); if (!el) return false; el.click(); return true }, sel, t)
const body = (p) => p.evaluate(() => document.body.innerText)
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
const setText = (p, sel, v) => p.evaluate((sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, sel, v)
const PAGES = new Set(['launch', 'shielded', 'treasury', 'how', 'terms', 'privacy', 'risk'])
const resolves = (href) => { const parts = href.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean); return parts.length === 0 || (parts[0] === 'coin' && !!parts[1]) || (PAGES.has(parts[0]) && parts.length === 1) }

;(async () => {
  const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME })
  const open = async (url, width = 1440) => {
    const p = await b.newPage()
    const errs = []
    p.on('pageerror', (e) => errs.push(e.message))
    await p.setViewport({ width, height: width === 390 ? 844 : 900 })
    await p.goto(url, { waitUntil: 'networkidle0' })
    await sleep(300)
    return { p, errs }
  }
  try {
    // ---- Treasury ----
    {
      const { p, errs } = await open(`${APP}/#/treasury`)
      const text = await body(p)
      const csv = await p.evaluate(async () => { const a = document.querySelector('a.csv'); if (!a) return null; const r = await fetch(a.href); const t = await r.text(); return { href: a.getAttribute('href').slice(0, 40), download: a.getAttribute('download'), status: r.status, head: t.slice(0, 60) } })
      const h2s = await p.evaluate(() => [...document.querySelectorAll('h1,h2')].map((h) => h.textContent.trim()))
      say('ST-P1-TR-01 Treasury renders what it holds and owes, the latest shielded payout, the fee split and the rounds', /What the pad holds/.test(text) && h2s.includes('Latest shielded payout') && h2s.includes('Every payout round') && h2s.includes("Where every trade's fee goes") && /owed to holders/i.test(text) && /treasury holds/i.test(text) && errs.length === 0, { headings: h2s, pageErrors: errs })
      say('ST-P1-TR-02 the CSV link downloads a file whose first line is the header', !!csv && csv.status === 200 && /^epochId,at,status/.test(csv.head) && csv.download === 'snarks-epochs.csv', { csv })
      await p.screenshot({ path: `${SHOTS}/treasury-1440.png` })
      await p.close()
      const v25 = await open(`${APP}/?v25=1#/treasury`)
      const hasCsv = await v25.p.evaluate(() => !!document.querySelector('a.csv'))
      say('ST-P1-TR-03 an engine without the CSV route (v2.5) shows no link and no error', !hasCsv && /Every payout round/.test(await body(v25.p)) && v25.errs.length === 0, { hasCsv, pageErrors: v25.errs })
      await v25.p.close()
      const phone = await open(`${APP}/#/treasury`, 390)
      say('ST-P1-TR-04 at 390 px nothing overflows sideways', !(await overflow(phone.p)) && phone.errs.length === 0, { pageErrors: phone.errs })
      await phone.p.screenshot({ path: `${SHOTS}/treasury-390.png` })
      await phone.p.close()
    }
    // ---- Shielded ----
    {
      const { p, errs } = await open(`${APP}/#/shielded`)
      await clickText(p, 'button', 'Connect wallet'); await sleep(150); await clickText(p, 'button', 'Test wallet'); await sleep(400)
      await p.type('textarea', 't1XyzAbcdefghijkmnopqrstuvwxyz123456'); await sleep(300)
      say('ST-P1-SH-01 a transparent address is refused with the hint', /cannot receive shielded payouts/.test(await body(p)), {})
      await setText(p, 'textarea', '<img src=x onerror="document.title=\'pwned\'">'); await sleep(300)
      const t2 = await body(p)
      const title = await p.title()
      const signDisabled = await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Sign and get my rewards shielded')); return b ? b.disabled : null })
      say('ST-P1-SH-02 markup in the address runs nothing, the sign button stays off and the hint says what is wanted', title !== 'pwned' && signDisabled === true && !/pwned/.test(t2) && errs.length === 0, { title, signDisabled, pageErrors: errs })
      const u1 = 'u1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(4)
      await setText(p, 'textarea', u1); await sleep(300)
      await clickText(p, 'button', 'Sign and get my rewards shielded'); await sleep(1500)
      const t3 = await body(p)
      say('ST-P1-SH-03 a unified address opts in: the page shows it masked and never in full', /now go to/.test(t3) && t3.includes(u1.slice(0, 6) + '…' + u1.slice(-4)) && !t3.includes(u1), {})
      await clickText(p, 'button', 'Stop shielded delivery'); await sleep(1200)
      say('ST-P1-SH-04 opting out brings the form back', /Paste your Zcash unified address/.test(await body(p)) && errs.length === 0, { pageErrors: errs })
      await p.close()
    }
    // ---- How it works ----
    {
      const { p, errs } = await open(`${APP}/#/how`)
      const text = await body(p)
      say('ST-P1-HOW-01 the page renders with the launch window example', /How the pad works\./.test(text) && /99%, 79\.4%, 59\.8%, 40\.2%, 20\.6%, then 1% from second 5/.test(text) && errs.length === 0, { pageErrors: errs })
      say('ST-P1-HOW-02 the example says 99% in the first second and the five steps, as the engine\'s reviewed window does (engine/test/copy.test.ts pins the same numbers)', /pays 99%/.test(text) && /five equal steps/.test(text), {})
      const hrefs = await p.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')))
      const bad = hrefs.filter((h) => !resolves(h))
      say('ST-P1-HOW-03 every internal link resolves to a page of the app', hrefs.length > 0 && bad.length === 0, { links: hrefs.length, bad })
      await p.close()
      const phone = await open(`${APP}/#/how`, 390)
      say('ST-P1-HOW-04 at 390 px nothing overflows sideways', !(await overflow(phone.p)) && phone.errs.length === 0, { pageErrors: phone.errs })
      await phone.p.close()
    }
    // ---- Terms, Privacy, Risk (smoke) ----
    for (const [kind, title] of [['terms', 'Terms of use'], ['privacy', 'Privacy'], ['risk', 'Risk notice']]) {
      const { p, errs } = await open(`${APP}/#/${kind}`)
      const h1 = await p.evaluate(() => document.querySelector('h1') && document.querySelector('h1').textContent.trim())
      say(`ST-P2 ${kind}: loads with its heading and no page error`, h1 === title && errs.length === 0, { h1, pageErrors: errs })
      await p.close()
    }
  } finally {
    await b.close()
  }
  console.log(JSON.stringify({ summary: { pass: out.filter((o) => o.pass).length, fail: out.filter((o) => !o.pass).length } }))
})().catch((e) => { console.error(e); process.exit(1) })
