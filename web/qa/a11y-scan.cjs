// Measured checks on the rendered pages, both themes, 1440 and 390: text contrast against its real background (WCAG,
// alpha composited up the ancestor chain; floor 4.5:1 under 24px, 3:1 at 24px or bold 18.66px+), controls under 44px in
// either direction (inline text links inside running text are listed apart), words set in the mono face (mono is for
// numbers and ids), reading text under 14px, and horizontal overflow. Prints one line per finding.
//   node qa/a11y-scan.cjs <base url>
const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer')
const BASE = (process.argv[2] || 'http://localhost:5199/').replace(/\/?$/, '/')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const scan = () => {
  const out = []
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\/]+/).map(Number); return { r, g, b, a: Number.isFinite(a) ? a : 1 } }
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 })
  const bgOf = (el) => {
    const layers = []
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      const c = parse(cs.backgroundColor)
      if (c && c.a > 0) layers.push(c)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') layers.push({ img: true })
      if (c && c.a >= 1) break
    }
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 }
    const body = parse(getComputedStyle(document.body).backgroundColor); if (body && body.a > 0 && !layers.length) bg = over(body, bg)
    for (const l of layers.reverse()) { if (l.img) return null; bg = over(l, bg) }
    return bg
  }
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
  // what a closed <details> holds is not on the page (the browser keeps its boxes but draws nothing, and its computed colours are not worth reading), apart from the summary
  const shut = (el) => { const d = el.closest('details'); return !!d && !d.open && !el.closest('summary') }
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0 && !shut(el) }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const el = n.parentElement
    if (!el || seen.has(el) || !visible(el) || ['SCRIPT', 'STYLE'].includes(el.tagName)) continue
    seen.add(el)
    const cs = getComputedStyle(el)
    const fg = parse(cs.color); const bg = bgOf(el)
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700
    const large = size >= 24 || (bold && size >= 18.66)
    const words = text.split(' ').length
    const sel = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '')
    if (fg && bg) {
      const r = ratio(over(fg, bg), bg)
      if (r < (large ? 3 : 4.5)) out.push(`contrast ${r.toFixed(2)}:1 ${sel} ${size}px "${text.slice(0, 50)}"`)
    } else if (fg && !bg) out.push(`contrast unmeasured (image/gradient behind) ${sel} "${text.slice(0, 40)}"`)
    if (/mono/i.test(cs.fontFamily) && /[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(text) && !/^(ZEC|SNARKS|[A-Z0-9]+)$/.test(text)) out.push(`mono prose ${sel} "${text.slice(0, 60)}"`)
    if (words >= 8 && size < 14) out.push(`reading text ${size}px ${sel} "${text.slice(0, 50)}"`)
    if (words >= 3 && size < 11) out.push(`tiny text ${size}px ${sel} "${text.slice(0, 50)}"`)
  }
  for (const el of document.querySelectorAll('a, button, input, select, textarea, summary, [role=button], [role=tab], label.tier')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline'
    if (r.height < 44 || r.width < 44) {
      const lbl = (el.getAttribute('aria-label') || el.textContent || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      out.push(`${inline ? 'inline link' : 'target'} ${Math.round(r.width)}x${Math.round(r.height)} ${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''} "${lbl}"`)
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`horizontal overflow ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`)
  return out
}

;(async () => {
  const b = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const p0 = await b.newPage(); await p0.goto(BASE, { waitUntil: 'networkidle0' })
  const mint = await p0.evaluate(async () => (await import('/src/lib/mock/index.ts')).SNARKS_MINT); await p0.close()
  const routes = [['home', '#/'], ['coin', `#/coin/${mint}`], ['launch', '#/launch'], ['shielded', '#/shielded'], ['treasury', '#/treasury'], ['how', '#/how'], ['terms', '#/terms'], ['privacy', '#/privacy'], ['risk', '#/risk'], ['404', '#/none'], ['home-devnet', '?devnet=1#/']]
  const all = {}
  for (const [name, hash] of routes) for (const theme of ['light', 'dark']) for (const w of [1440, 390]) {
    const p = await b.newPage()
    await p.evaluateOnNewDocument((t) => { try { localStorage.setItem('snarks-theme', t) } catch {} }, theme)
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
    await p.setViewport({ width: w, height: w === 390 ? 844 : 900, deviceScaleFactor: 1 })
    await p.goto(BASE + hash, { waitUntil: 'networkidle0' })
    if (name === 'home-devnet') { await p.evaluate(() => { const f = (t) => [...document.querySelectorAll('button')].find((e) => e.textContent.includes(t)); f('Connect wallet')?.click() }); await sleep(150); await p.evaluate(() => [...document.querySelectorAll('button')].find((e) => e.textContent.includes('Test wallet'))?.click()); await sleep(500) }
    await sleep(700)
    const found = await p.evaluate(scan)
    for (const f of found) { const k = `${name} ${theme} ${w}`; (all[f] ||= []).push(k) }
    await p.close()
  }
  await b.close()
  const lines = Object.entries(all).sort().map(([f, where]) => `${f}  [${where.length}: ${where.slice(0, 4).join('; ')}${where.length > 4 ? '; …' : ''}]`)
  console.log(lines.join('\n') || 'nothing found')
  console.log(`\n${lines.length} distinct findings`)
})().catch((e) => { console.error(e); process.exit(1) })
