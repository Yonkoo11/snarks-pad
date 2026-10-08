const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer');
const out = process.argv[2]; const shots = JSON.parse(process.argv[3]);
(async () => {
  const b = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const errs = [];
  for (const s of shots) {
    const p = await b.newPage();
    p.on('pageerror', e => errs.push(s.name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(s.name + ' console: ' + m.text()); });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: s.theme || 'light' }]);
    await p.setViewport({ width: s.w, height: s.h || 900, deviceScaleFactor: s.w < 500 ? 2 : 1 });
    await p.goto('http://localhost:5199/' + (s.hash || ''), { waitUntil: 'networkidle0' });
    if (s.js) { await p.evaluate(s.js); }
    await new Promise(r => setTimeout(r, s.wait || 1200));
    await p.screenshot({ path: out + '/' + s.name + '.png', fullPage: !!s.full });
    await p.close();
  }
  console.log(errs.length ? errs.join('\n') : 'no page errors');
  await b.close();
})();
