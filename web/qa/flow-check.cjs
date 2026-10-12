const puppeteer = require('/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Keypair, PublicKey, SystemProgram } = require(path.resolve(__dirname, '../node_modules/@solana/web3.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clickText = (p, sel, t) => p.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find(e => e.textContent.trim().includes(t)); if (!el) throw new Error('no ' + t); el.click(); }, sel, t);
const body = p => p.evaluate(() => document.body.innerText);
(async () => {
  const b = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.setViewport({ width: 1280, height: 900 });
  // Every page this walk-through opens is read, as it changes, for the name of another launchpad (owner, 2026-10-07: the site never names one).
  // "Sapling-only addresses" on the Shielded page is Zcash's address type, not the launchpad, so it is not a hit. The check is the last one pushed.
  const OTHER_PADS = /pump\.fun|EmberCurve|StonkFun|\bSapling\b(?!-only| address)|\bZCAT\b|\bBags\b|BONK\.fun|Jupiter Studio/i;
  const padHits = new Set(); const pagesRead = new Set();
  await p.exposeFunction('__qaRead', (href, hits) => { pagesRead.add(href); for (const h of hits) padHits.add(h + ' on ' + href) });
  await p.evaluateOnNewDocument((src) => {
    const re = new RegExp(src, 'gi'); let t = null;
    const read = () => { try { const attrs = [...document.querySelectorAll('[title],[aria-label],[alt],[placeholder]')].map((e) => ['title', 'aria-label', 'alt', 'placeholder'].map((a) => e.getAttribute(a) || '').join(' ')).join(' '); window.__qaRead(location.href, [...new Set(((document.body ? document.body.innerText : '') + ' ' + document.title + ' ' + attrs).match(re) || [])]) } catch {} };
    const later = () => { if (t === null) t = setTimeout(() => { t = null; read() }, 400) };
    new MutationObserver(later).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    addEventListener('hashchange', later);
  }, OTHER_PADS.source);
  const R = [];
  // opt-in
  await p.goto('http://localhost:5199/#/shielded', { waitUntil: 'networkidle0' });
  await clickText(p, 'button', 'Connect wallet'); await sleep(100);
  await clickText(p, 'button', 'Test wallet'); await sleep(300);
  await p.type('textarea', 't1XyzAbcdefghijkmnopqrstuvwxyz123456'); await sleep(200);
  R.push(['taddr hint', (await body(p)).includes('cannot receive shielded payouts')]);
  await p.evaluate(() => { const t = document.querySelector('textarea'); t.value=''; t.dispatchEvent(new Event('input', {bubbles:true})) });
  const u1 = 'u1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(4);
  await p.type('textarea', u1); await sleep(200);
  await clickText(p, 'button', 'Sign and get my rewards shielded'); await sleep(1500);
  const t1 = await body(p);
  R.push(['opted in', /shielded delivery is on/i.test(t1)], ['masked shown', t1.includes(u1.slice(0,4) + '…' + u1.slice(-4))], ['full addr absent', !t1.includes(u1)]);
  await clickText(p, 'button', 'Stop shielded delivery'); await sleep(1500);
  R.push(['opted out', (await body(p)).includes('Paste your Zcash unified address')]);
  // trade
  const mint = await p.evaluate(async () => (await (await import('/src/lib/mock/index.ts')).SNARKS_MINT));
  await p.goto('http://localhost:5199/#/coin/' + mint, { waitUntil: 'networkidle0' }); await sleep(500);
  await p.type('input[inputmode=decimal]', '0.1'); await sleep(900);
  R.push(['quote', (await body(p)).includes('You get about')]);
  await clickText(p, 'button', 'Buy $SNARKS'); await sleep(800);
  R.push(['trade sent', (await body(p)).includes('Done. Signature')]);
  // the buy box (field study items 2 and 3): a quote with no wallet, presets, sell shares, slippage, impact, the short state, plain refusals
  const tradeBox = () => p.evaluate(() => document.querySelector('.trade').innerText);
  const amountVal = () => p.evaluate(() => document.querySelector('input[inputmode=decimal]').value);
  const buyDisabled = () => p.evaluate(() => [...document.querySelectorAll('.trade button')].find((b) => /^(Buy|Sell) \$/.test(b.textContent.trim()))?.disabled);
  // a wallet stays connected across hash changes (one page); a reload is a fresh visitor with no wallet
  const ensureWallet = async () => { if (await p.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect wallet'))) { await clickText(p, 'button', 'Connect wallet'); await sleep(100); await clickText(p, 'button', 'Test wallet'); await sleep(500) } };
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  await p.type('input[inputmode=decimal]', '0.1'); await sleep(900);
  const noWallet = await tradeBox();
  R.push(['buy box: a quote with the price impact appears with no wallet connected', noWallet.includes('You get about') && noWallet.includes('Price impact') && noWallet.includes('Connect wallet to buy') && !noWallet.includes('Connect a Solana wallet to get a quote')]);
  await clickText(p, '.presets .pre', '0.5 ZEC'); await sleep(900);
  R.push(['buy box: the 0.5 ZEC preset fills the amount and re-quotes', (await amountVal()) === '0.5' && /4,125,000 SNARKS|4,1\d\d,\d\d\d SNARKS/.test(await tradeBox())]);
  await clickText(p, '.slip-r .pre', '10%'); await sleep(1000); // the quote re-asks 300 ms after a change and the mock answers 150 ms later
  R.push(['buy box: 10% slippage warns in plain words and the quote says "At least (10% slippage)"', /High slippage: this trade may fill at a price up to 10% worse/.test(await tradeBox()) && (await tradeBox()).includes('At least (10% slippage)')]);
  await p.type('.custom', '2.5'); await sleep(1000);
  R.push(['buy box: a custom slippage of 2.5% is taken and the warning goes', /Slippage\s+2\.5%/.test(await tradeBox()) && !/High slippage/.test(await tradeBox()) && (await tradeBox()).includes('At least (2.5% slippage)')]);
  await p.evaluate(() => { const i = document.querySelector('input[inputmode=decimal]'); i.value = '50'; i.dispatchEvent(new Event('input', { bubbles: true })) }); await sleep(900);
  R.push(['buy box: an amount above what the curve can fill is refused in plain words, no error code', (await tradeBox()).includes('That is more than the curve can fill right now. Try a smaller amount.') && !/bad_amount/.test(await tradeBox())]);
  await ensureWallet(); await sleep(300);
  await p.evaluate(() => { const i = document.querySelector('input[inputmode=decimal]'); i.value = '1'; i.dispatchEvent(new Event('input', { bubbles: true })) }); await sleep(900);
  R.push(['buy box: a buy above the wallet\'s ZEC names the balance and keeps Buy off', (await tradeBox()).includes('less than this buy') && (await tradeBox()).includes('0.3 ZEC') && (await buyDisabled()) === true]);
  await clickText(p, '[role=tab]', 'Sell'); await sleep(300);
  await clickText(p, '.presets .pre', '50%'); await sleep(900);
  R.push(['buy box: Sell 50% sizes the amount from what the wallet holds and quotes ZEC out', (await amountVal()) === '125000' && (await tradeBox()).includes('You hold') && /You get about\s+[\d.]+ ZEC/.test(await tradeBox())]);
  // the four tabs: the trades tape with its tags and links, the holders, the rewards, the token info (named "What is fixed" until the copy pass of 2026-10-07)
  const tabNames = await p.evaluate(() => [...document.querySelectorAll('.ctabs [role=tab]')].map((b) => b.textContent.trim().replace(/\s+/g, ' ')));
  R.push(['coin page: four tabs, Trades first, Holders with its count, Token info last', tabNames.length === 4 && tabNames[0] === 'Trades' && /^Holders\s?1,284$/.test(tabNames[1]) && tabNames[2] === 'Rewards' && /^Token info/.test(tabNames[3])]);
  const tapeInfo = await p.evaluate(() => ({ rows: document.querySelectorAll('.panel-body .tape .row').length, dev: !!document.querySelector('.panel-body .tape .tg'), links: document.querySelectorAll('.panel-body .tape a.tx').length, text: document.querySelector('.panel-body').innerText }));
  R.push(['trades tab: the tape has rows, the creator\'s trade is tagged dev, every row links to the explorer, and no refresh timer is printed (removed in the copy pass)', tapeInfo.rows === 8 && tapeInfo.dev && tapeInfo.links === 8 && !/refreshes every|Last read|each trade shows as it lands/i.test(tapeInfo.text)]);
  await clickText(p, '.ctabs [role=tab]', 'Holders'); await sleep(800);
  const holdersText = await p.evaluate(() => document.querySelector('.panel-body').innerText);
  R.push(['holders tab: shares, the pool row marked "pool, not paid", the dev tag, the top-10 share, and nothing about which wallets opted in (v2.9)', /1,284 holders/.test(holdersText) && /Top 10 hold \d+(\.\d)?% of the supply/.test(holdersText) && /pool, not paid/i.test(holdersText) && /\bdev\b/i.test(holdersText) && !/receive shielded|opted in/i.test(holdersText) && !/u1[0-9a-z]{20}/.test(holdersText)]);
  await clickText(p, '.ctabs [role=tab]', 'Rewards'); await sleep(800);
  const rewardsText = await p.evaluate(() => document.querySelector('.panel-body').innerText);
  R.push(['rewards tab: the pot, the holders\' share, the next payout countdown, the last payout with its ids, the paid-so-far split', /Pot so far\s+[\d.]+ ZEC/i.test(rewardsText) && /Of it to holders/i.test(rewardsText) && /Next payout\s+in \d+h \d\dm \d\ds/i.test(rewardsText) && /Last payout/.test(rewardsText) && /Zcash transaction|simulated/i.test(rewardsText) && /Paid to holders so far/.test(rewardsText) && /As shielded ZEC/.test(rewardsText)]);
  await clickText(p, '.ctabs [role=tab]', 'Token info'); await sleep(800);
  const fixedText = await p.evaluate(() => document.querySelector('.panel-body').innerText);
  // one line per fact, each with one Verify link to the account it was read from on Solscan (it was a raw address on the explorer before the copy pass)
  const fixedLinks = await p.evaluate(() => { const lis = [...document.querySelectorAll('.panel-body .facts li')]; return { facts: lis.length, linked: lis.filter((li) => li.querySelectorAll('a.verify[href*="solscan.io/account/"][target="_blank"]').length === 1).length } });
  R.push(['token info: nine facts, each with a Verify link to check it on Solscan, the mint authority, the creator fee, and the no-whitelist line; the fee claimer moved to How it works', /Mint authority:/.test(fixedText) && /Trading fee: 1% on the bonding curve/.test(fixedText) && !/Fee claimer/.test(fixedText) && /Creator fee: None\./.test(fixedText) && fixedLinks.facts === 9 && fixedLinks.linked === 9 && /There is no whitelist and there are no paid placements on this pad\./.test(fixedText)]);
  R.push(['token info: the creator\'s first-buy exception is stated, so the closing line does not claim "no snipe exemptions"', /The creator's own first buy, inside the launch transaction, pays the coin's fee and not the launch window's\./.test(fixedText) && !/no snipe exemptions/i.test(fixedText)]);
  R.push(['token info: a Launch window fact (5 seconds, 99% at first, cannot change) that names the creator\'s own first buy as the one exception, paying the coin\'s fee and not the launch window\'s; the trading fee said to be the fee once the window has closed, fixed at launch', /Launch window: The first 5 seconds cost more \(99% at first\), so bots cannot buy up the launch\. It cannot change\. The creator's own first buy, inside the launch transaction, pays the coin's fee and not the launch window's\./.test(fixedText) && /Trading fee: 1% on the bonding curve once the launch window has closed, fixed at launch\./.test(fixedText)]);
  R.push(['token info: the fee after graduation: the Meteora pool charges 1%, rising to about 1.2% when trading is volatile, and Meteora can pause that pool or change its fee (the round trip moved to the Risk notice)', /Fee after graduation: The Meteora pool charges 1%, rising to about 1\.2% when trading is volatile\. Meteora can pause that pool or change its fee\./.test(fixedText)]);
  R.push(['token info: the sends fact moved to How it works ("There is no transfer tax.", checked there), not repeated here', !/Wallet-to-wallet/i.test(fixedText)]);
  R.push(['coin page: the fee line under the stats is gone (copy pass), and Token info says the fee is the fee once the launch window has closed, with its space', await p.evaluate(() => !document.querySelector('.tierline') && !/This coin's fee is/.test(document.body.innerText)) && /1% on the bonding curve once the launch window has closed, fixed at launch\./.test(fixedText)]);
  R.push(['coin page: the creator\'s links show as https links only', await p.evaluate(() => { const a = [...document.querySelectorAll('.links a')]; return a.length === 2 && a.every((x) => x.href.startsWith('https://') && x.target === '_blank') })]);
  // launch
  await p.goto('http://localhost:5199/#/launch', { waitUntil: 'networkidle0' }); await sleep(300);
  const inputs = await p.$$('form input.input');
  await inputs[0].type('Test Coin'); await inputs[1].type('test1'); await p.type('textarea', 'hello');
  await clickText(p, 'button', 'Launch'); await sleep(1500);
  const done0 = await p.evaluate(() => document.querySelector('.done')?.innerText || '');
  R.push(['launched: the done panel says "$TEST1 is live." and that holders start earning ZEC from the next payout, with no "epoch"', /\$TEST1 is live\./.test(done0) && done0.includes('Holders start earning ZEC from the next payout.') && !/epoch/i.test(done0)]);
  await clickText(p, 'a', 'Open'); await sleep(800);
  R.push(['new coin page', (await body(p)).includes('Test Coin')]);
  // launch form (field study item 7; contract v2.7): links checked and normalised, the picture comes from the device, the preview is a card with the fixed facts, a lookalike needs a tick
  await p.goto('http://localhost:5199/#/launch', { waitUntil: 'networkidle0' }); await sleep(500);
  await ensureWallet();
  const setVal = (sel, i, v) => p.evaluate((sel, i, v) => { const el = document.querySelectorAll(sel)[i]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }, sel, i, v);
  const launchBtnDisabled = () => p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Launch') || /^Uploading the image/.test(b.textContent.trim()))?.disabled);
  await setVal('form input.input', 0, 'release the snarks'); await setVal('form input.input', 1, 'NEWONE'); await sleep(300);
  const lookText = await p.evaluate(() => document.querySelector('.look')?.innerText || '');
  const lookBlocked = await launchBtnDisabled();
  await p.click('.look input'); await sleep(100);
  const lookTicked = await launchBtnDisabled();
  R.push(['launch: a name already on the pad shows the lookalike warning and holds Launch until the tick', /Release The Snarks/.test(lookText) && /\$SNARKS/.test(lookText) && lookBlocked === true && lookTicked === false]);
  await setVal('form input.input', 0, 'Fresh Coin'); await sleep(300);
  R.push(['launch: a new name clears the warning', await p.evaluate(() => !document.querySelector('.look'))]);
  R.push(['launch: the form labels are Name and Ticker, and the Links section is shut until a creator opens it', await p.evaluate(() => { const l = [...document.querySelectorAll('form .field > span')].map((x) => x.textContent.trim()); return l[0] === 'Name' && l[1] === 'Ticker' && !document.querySelector('details.socials').open })]);
  await setVal('.socials input', 0, 'notaurl'); await setVal('.socials input', 1, 'bad handle!'); await setVal('.socials input', 2, 'ab'); await sleep(300);
  const socErrs = await p.evaluate(() => [...document.querySelectorAll('.socials small.error')].map((e) => e.textContent));
  const linksOpened = await p.evaluate(() => document.querySelector('details.socials').open);
  R.push(['launch: a bad website, X handle and Telegram name each get a plain reason, the section opens itself, and Launch waits', socErrs.length === 3 && /https:\/\//.test(socErrs[0]) && /@snarkspad/.test(socErrs[1]) && /t\.me/.test(socErrs[2]) && linksOpened && (await launchBtnDisabled()) === true]);
  await setVal('.socials input', 0, 'example.com/coin'); await setVal('.socials input', 1, '@snarkspad'); await setVal('.socials input', 2, 't.me/snarkspad'); await sleep(300);
  const pv = await p.evaluate(() => ({ card: document.querySelector('.preview .card').innerText.replace(/\s+/g, ' '), errs: document.querySelectorAll('.socials small.error').length, aside: document.querySelector('.preview').innerText.replace(/\s+/g, ' ') }));
  R.push(['launch: valid links pass (bare domain, handle, t.me path)', pv.errs === 0 && (await launchBtnDisabled()) === false]);
  R.push(['launch: the preview card shows the name, the ticker and the fixed facts, one fact to a row and nothing under any row, read from the tier', /Fresh Coin/.test(pv.card) && /\$NEWONE/.test(pv.card) && /PAIRED WITH Solana ZEC TRADE FEE 1%, fixed at launch TO HOLDERS 60% of every fee, in ZEC LAUNCH WINDOW 99% at launch, 1% from second 5 GRADUATION When the curve holds 6\.67 ZEC LIQUIDITY Locked for good$/i.test(pv.card)]);
  R.push(['launch: under the card, what is written on chain; the Meteora paragraph left the Launch page in the copy pass (the graduated pool line is on the Risk notice, Token info and How it works)', /Name, ticker, image, links and fee are written on chain at launch and cannot be changed after\./.test(pv.aside) && !/Meteora can pause/.test(pv.aside)]);
  R.push(['launch: the preview card has a Launch window row between the creator\'s share and Graduation: 99% at launch, 1% from second 5, and no line under it', /TO HOLDERS .* LAUNCH WINDOW 99% at launch, 1% from second 5 GRADUATION /i.test(pv.card) && !/A bot that buys|Your own first buy/.test(pv.card)]);
  const feesBlock = await p.evaluate(() => ({ line: document.querySelector('.fee-fixed').innerText.replace(/\s+/g, ' ').trim(), all: document.querySelector('.fees').innerText.replace(/\s+/g, ' ').trim(), lines: document.querySelectorAll('.fee-fixed').length }));
  R.push(['launch: under the tier picker is ONE line: the fee, paid in ZEC, fixed at launch, and nothing else (the per-$100 split left it on 2026-10-06); nothing about a round trip, the window, the pool, delivery or sends', feesBlock.lines === 1 && feesBlock.line === '1% on every trade, paid in ZEC, fixed at launch.' && !/Per \$100|immediate sell|launch window|Wallet-to-wallet|shielded delivery|Meteora runs|graduates it trades/i.test(feesBlock.all)]);
  await p.evaluate(() => { document.querySelector('details.socials summary').click() }); await sleep(250);
  R.push(['launch: a shut Links section says how many links it holds', await p.evaluate(() => /3 added/.test(document.querySelector('details.socials summary').innerText))]);
  // the picture: from the device, never a link; refused by its first bytes; the stored copy; Replace and Remove
  R.push(['launch: no field asks for a link to an image, and the drop zone says what it takes', await p.evaluate(() => !document.querySelector('input[type=url][placeholder*="image" i]') && !/link to an image/i.test(document.body.innerText) && /Drop an image here, or click to browse/.test(document.querySelector('.drop').innerText) && /PNG, JPG, GIF or WEBP, square looks best, up to 5 MB/.test(document.querySelector('.drop').innerText))]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
  const MASCOT = path.resolve(__dirname, '../public/mascot-256.jpg');
  const svgPath = path.join(tmp, 'evil.png'); fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const bigPath = path.join(tmp, 'big.png'); fs.writeFileSync(bigPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]));
  const fileInput = await p.$('input[type=file]');
  await fileInput.uploadFile(svgPath); await sleep(400);
  R.push(['launch: an SVG named .png is refused by its first bytes, in plain words, and nothing is kept', /That file is not a PNG, JPG, GIF or WEBP image\./.test(await body(p)) && await p.evaluate(() => !document.querySelector('.picked'))]);
  await fileInput.uploadFile(bigPath); await sleep(400);
  R.push(['launch: a picture over 5 MB is refused in plain words, and the earlier refusal is replaced', /That image is over 5 MB\. Pick a smaller one\./.test(await body(p)) && !/not a PNG/.test(await body(p)) && await p.evaluate(() => !document.querySelector('.picked'))]);
  await fileInput.uploadFile(MASCOT); await sleep(120);
  const early = await p.evaluate(() => ({ status: document.querySelector('.picked .status')?.innerText, cardImg: !!document.querySelector('.preview .card img'), btn: [...document.querySelectorAll('form button[type=submit]')].map((b) => ({ t: b.textContent.trim(), d: b.disabled }))[0] }));
  R.push(['launch: the picture shows in the preview at once, and Launch waits while it uploads', /Uploading/.test(early.status || '') && early.cardImg && early.btn.t === 'Uploading the image…' && early.btn.d === true]);
  await sleep(1300);
  const late = await p.evaluate(() => ({ status: document.querySelector('.picked .status')?.innerText, acts: [...document.querySelectorAll('.picked .acts button')].map((b) => b.textContent.trim()), btn: document.querySelector('form button[type=submit]')?.textContent.trim(), err: document.querySelector('.image small.error')?.textContent || '' }));
  R.push(['launch: the upload finishes with the stored size, Replace and Remove, and no leftover refusal', /^Uploaded\. \d+ × \d+, \d+ (B|KB|MB)\.$/.test((late.status || '').trim()) && JSON.stringify(late.acts) === JSON.stringify(['Replace', 'Remove']) && late.btn === 'Launch $NEWONE' && late.err === '']);
  await clickText(p, '.picked .acts button', 'Remove'); await sleep(200);
  R.push(['launch: Remove puts the drop zone back and empties the preview picture', await p.evaluate(() => !!document.querySelector('.drop') && !document.querySelector('.preview .card img'))]);
  // a file dropped on the page and a picture pasted are taken as the coin's picture, as the file chooser's is
  await p.evaluate(async () => { const blob = await (await fetch('/mascot-256.jpg')).blob(); const dt = new DataTransfer(); dt.items.add(new File([blob], 'moon.jpg', { type: 'image/jpeg' })); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })) });
  await sleep(1500);
  R.push(['launch: a picture dropped on the page is taken', await p.evaluate(() => /^Uploaded\./.test(document.querySelector('.picked .status')?.innerText || ''))]);
  await clickText(p, '.picked .acts button', 'Remove'); await sleep(200);
  await p.evaluate(async () => { const blob = await (await fetch('/mascot-256.jpg')).blob(); const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.jpg', { type: 'image/jpeg' })); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) });
  await sleep(1500);
  R.push(['launch: a picture pasted is taken', await p.evaluate(() => /^Uploaded\./.test(document.querySelector('.picked .status')?.innerText || ''))]);
  // the first buy: Max is what the wallet holds (the mock wallet holds 0.3 ZEC), a buy above it is refused in words and holds Launch
  const buyIn = 'input[aria-labelledby="first-buy-l"]';
  R.push(['first buy: the wallet\'s Solana ZEC is named, and Max is on', await p.evaluate(() => /Your wallet holds 0\.3 ZEC on Solana\./.test(document.body.innerText) && [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Max')?.disabled === false)]);
  await clickText(p, 'button', 'Max'); await sleep(150);
  R.push(['first buy: Max fills in the whole balance', (await p.$eval(buyIn, (e) => e.value)) === '0.3' && (await launchBtnDisabled()) === false]);
  await setVal(buyIn, 0, '1'); await sleep(200);
  R.push(['first buy: more than the wallet holds is refused in plain words and holds Launch', /Your wallet holds 0\.3 ZEC on Solana, less than this buy\./.test(await body(p)) && (await launchBtnDisabled()) === true]);
  await setVal(buyIn, 0, 'abc'); await sleep(200);
  R.push(['first buy: text that is not a number says so', /Type a number, like 0\.5/.test(await body(p)) && (await launchBtnDisabled()) === true]);
  await setVal(buyIn, 0, '0.1'); await sleep(200);
  // Creator wallet (contract v2.8): a plain field in view between First buy and the Launch button, with no section to open (owner review 2026-10-05). Since the copy pass (2026-10-07)
  // it shows only on a tier with a creator share: on the 1% tier there is no field at all. Its place and its words are looked at on the 4% tier, then the form goes back to 1% for the launch below.
  const walletSeen = () => p.evaluate(() => { const d = document.querySelector('.creator'); if (!d) return null; const f = document.querySelector('[aria-labelledby="first-buy-l"]'); const go = document.querySelector('form .go'); const input = d.querySelector('input.input'); const box = input.getBoundingClientRect(); return { label: d.querySelector('label > span').textContent.trim(), text: d.innerText.replace(/\s+/g, ' ').trim(), off: input.disabled, inView: box.width > 0 && box.height > 0, folded: !!d.closest('details'), after: !!(f.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING), before: !!(d.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING), advanced: /advanced/i.test(document.querySelector('form').innerText) || !!document.querySelector('details.advanced') } });
  const wallet1 = await p.evaluate(() => ({ field: !!document.querySelector('.creator'), form: document.querySelector('form').innerText }));
  const open1 = (await launchBtnDisabled()) === false;
  await clickText(p, 'label.tier', '4%'); await sleep(200);
  const wallet0 = await walletSeen();
  await clickText(p, 'label.tier', 'SNARKS tier'); await sleep(200);
  R.push(['launch (4% tier): Creator wallet (optional) is a plain field in view between First buy and the Launch button, on, saying what it is for, and there is no Advanced section', wallet0 !== null && wallet0.label === 'Creator wallet (optional)' && wallet0.inView && !wallet0.folded && wallet0.after && wallet0.before && !wallet0.advanced && wallet0.off === false && /Receives your share of the trading fee\. Leave blank to use the connected wallet\./.test(wallet0.text)]);
  R.push(['launch (1% tier): no Creator wallet field and no note about a field that is not used (copy pass), and Launch stays open', wallet1.field === false && !/Creator wallet|not used|creator's share is 0/i.test(wallet1.form) && open1]);
  // launch it with the picture, the three links and a first buy; the coin page shows them
  await clickText(p, 'button', 'Launch $NEWONE'); await sleep(1800);
  R.push(['launch: a coin with a picture, three links and a first buy is launched', (await body(p)).includes('$NEWONE is live.')]);
  await clickText(p, 'a', 'Open'); await sleep(900);
  const linked = await p.evaluate(() => ({ chips: [...document.querySelectorAll('.links a')].map((a) => ({ t: a.textContent.trim().replace(/\s+/g, ' '), href: a.href, target: a.target, rel: a.rel })), img: document.querySelector('.head img')?.getAttribute('src') || '', warn: document.querySelector('.lwarn')?.textContent || '' }));
  R.push(['coin page: the picture from the device, then Website with its host, X and Telegram as chips that open in a new tab, and the warning', linked.img.startsWith('data:image') && linked.chips.length === 3 && /^Website\s?example\.com\s?↗$/.test(linked.chips[0].t) && linked.chips[0].href === 'https://example.com/coin' && linked.chips[1].href === 'https://x.com/snarkspad' && linked.chips[2].href === 'https://t.me/snarkspad' && linked.chips.every((c) => c.target === '_blank' && /noopener/.test(c.rel) && /noreferrer/.test(c.rel)) && /Added by the creator, not checked by the pad\./.test(linked.warn)]);
  // an upload that fails: the words, Try again, and Launch held until the picture is dealt with
  await p.goto('http://localhost:5199/?upload=fail#/launch', { waitUntil: 'networkidle0' }); await sleep(500);
  // the wallet is connected from the form's own button: that must not submit the form and flag fields nobody has touched
  await clickText(p, '.connect button', 'Connect wallet to launch'); await sleep(150);
  await clickText(p, '.connect button', 'Test wallet'); await sleep(500);
  R.push(['launch: connecting from the form\'s own button does not mark the empty Name and Ticker as wrong', await p.evaluate(() => !!document.querySelector('form button[type=submit]') && !document.querySelector('form .error') && !document.querySelector('form [aria-invalid=true]'))]);
  await (await p.$('input[type=file]')).uploadFile(MASCOT); await sleep(1500);
  const failed = await p.evaluate(() => ({ err: document.querySelector('.image small.error')?.textContent, acts: [...document.querySelectorAll('.picked .acts button')].map((b) => b.textContent.trim()), btn: document.querySelector('form button[type=submit]')?.disabled, hint: document.querySelector('.hint')?.textContent }));
  R.push(['launch: a failed upload says so, offers Try again, Replace and Remove, and holds Launch', /The upload did not work\. Check your connection and try again\./.test(failed.err || '') && JSON.stringify(failed.acts) === JSON.stringify(['Try again', 'Replace', 'Remove']) && failed.btn === true && /Try again or remove it/.test(failed.hint || '')]);
  await clickText(p, '.picked .acts button', 'Remove'); await sleep(200);
  R.push(['launch: removing the failed picture frees Launch', await p.evaluate(() => document.querySelector('form button[type=submit]').disabled === false && !document.querySelector('.image small.error'))]);
  fs.rmSync(tmp, { recursive: true, force: true });
  // fee tiers: the picker says in one neutral sentence what buyers and sellers pay and who gets what per $100 (owner review 2026-10-05), asks twice for 10%; the coin page shows the tier; the creator claims
  await p.goto('http://localhost:5199/#/launch', { waitUntil: 'networkidle0' }); await sleep(500);
  await ensureWallet(); // the page above was a fresh load (a new address), so the wallet is gone
  await clickText(p, 'label.tier', '4%'); await sleep(200);
  const lt = await body(p);
  // who gets what of the fee is on the preview card ("To you", "To holders") since the per-$100 split left the line under the picker (owner, 2026-10-06)
  const card = () => p.evaluate(() => document.querySelector('.preview .card').innerText.replace(/\s+/g, ' '));
  const lt4 = await card();
  R.push(['tier picker: who gets what at 4% is on the preview card (to you 60%, to holders 2.5% of every fee), and no per-$100 split is left on the page', /TO YOU 60% of every fee, claimed from your wallet/i.test(lt4) && /TO HOLDERS 2.5% of every fee, in ZEC/i.test(lt4) && !/Per \$100|you \$2\.40|holders \$0\.10|Meteora \$0\.80/i.test(lt)]);
  const feeLine = () => p.evaluate(() => document.querySelector('.fee-fixed').innerText.replace(/\s+/g, ' ').trim());
  const feeBlock = () => p.evaluate(() => document.querySelector('.fees').innerText.replace(/\s+/g, ' ').trim());
  R.push(['tier picker: 4% says in one line the fee, that it is paid in ZEC and fixed at launch, and nothing else', (await feeLine()) === '4% on every trade, paid in ZEC, fixed at launch.']);
  R.push(['tier picker: no warning box, and none of the old scolding under the picker', await p.evaluate(() => !document.querySelector('.fees .warn')) && !/\blos(e|es|t)\b|fewer people trade|fills more slowly|high fee/i.test(await feeBlock())]);
  // the same line for every tier, and that tier's own shares on the preview card (the mock's tiers are the engine's reviewed five); the 1% tier has no creator share, so no "To you"
  const lines = {
    'SNARKS tier': ['1% on every trade, paid in ZEC, fixed at launch.', null, '10%'],
    '2%': ['2% on every trade, paid in ZEC, fixed at launch.', '40%', '30%'],
    '6%': ['6% on every trade, paid in ZEC, fixed at launch.', '66.4%', '10.2%'],
    '10%': ['10% on every trade, paid in ZEC, fixed at launch.', '72%', '6%'],
  };
  const wrong = [];
  for (const [label, [want, you, holders]] of Object.entries(lines)) {
    await clickText(p, 'label.tier', label); await sleep(150);
    const c = (await card()).toLowerCase();
    const youOk = you === null ? !c.includes('to you') : c.includes(`to you ${you} of every fee, claimed from your wallet`);
    if ((await feeLine()) !== want || !youOk || !c.includes(`to holders ${holders} of every fee, in zec`)) wrong.push(label);
  }
  if (wrong.length) console.log('tier line or preview shares differ for: ' + wrong.join(', '));
  R.push(['tier picker: every other tier says the same line, and the preview card gives its own shares (1, 2, 6 and 10%)', wrong.length === 0]);
  await clickText(p, 'label.tier', '4%'); await sleep(150);
  await clickText(p, 'label.tier', '10%'); await sleep(200);
  const l10 = await body(p);
  R.push(['tier picker: 10% says it drops to 6% after graduation, and the preview card gives the creator 72% of every fee', l10.includes('drops to 6% after graduation') && /TO YOU 72% of every fee, claimed from your wallet/i.test(await card()) && !l10.includes('you $7.20')]);
  const tierInputs = await p.$$('form input.input');
  await tierInputs[0].type('Tier Coin'); await tierInputs[1].type('tier4');
  const launchDisabled = () => p.evaluate(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('Launch'))?.disabled);
  const blocked10 = await launchDisabled();
  await p.click('.confirm input'); await sleep(100);
  const open10 = await launchDisabled();
  await clickText(p, 'label.tier', '4%'); await sleep(200);
  R.push(['tier picker: 10% blocks Launch until the confirmation is ticked (and only 10% asks)', blocked10 === true && open10 === false && l10.includes('I understand: 10% on every trade, fixed at launch, 6% after graduation.') && !l10.includes('immediate sell') && !(await body(p)).includes('I understand:')]);
  await clickText(p, 'button', 'Launch'); await sleep(1500);
  R.push(['tier coin launched, and the done panel tells the creator to claim their share from the coin page', (await body(p)).includes('$TIER4 is live.') && (await body(p)).includes('Claim your share of the fee from the coin page with this wallet.')]);
  await clickText(p, 'a', 'Open'); await sleep(800);
  const tc = await body(p);
  // the fee line under the stats and the per-$100 column of the fee split left the coin page in the copy pass: the fee is the Trading fee stat and the split's heading, each share a percentage
  const tcSplit = await p.evaluate(() => ({ stat: [...document.querySelectorAll('dl.stats > div')].find((d) => /Trading fee/i.test(d.querySelector('dt').textContent))?.querySelector('dd').textContent.trim(), fs: document.querySelector('.fs').innerText.replace(/\s+/g, ' ') }));
  R.push(['coin page shows the 4% fee (stat and fee split) and the creator\'s 60% share, with no per-$100 figures', tcSplit.stat === '4%' && /Where the 4% curve fee goes/.test(tcSplit.fs) && /Creator 60%/.test(tcSplit.fs) && /Holders 2.5%/.test(tcSplit.fs) && /Team 17.5%/.test(tcSplit.fs) && /Meteora 20%/.test(tcSplit.fs) && !/\$\d|Of every \$100/.test(tcSplit.fs) && !tc.includes("This coin's fee is")]);
  R.push(['coin page header: the 4% coin on its curve says "4% fee on curve", never a bare "4% fee"', await p.evaluate(() => [...document.querySelectorAll('.trow .chip')].map(c => c.textContent.trim()).join('|')) === '4% fee on curve']);
  R.push(['creator sees the claim panel', tc.includes('Your creator fees')]);
  await clickText(p, 'button', 'Claim creator fees'); await sleep(900);
  R.push(['creator claim sent', (await body(p)).includes('Claim sent. Signature')]);
  // the Creator wallet (contract v2.8): at 4% the creator's fee can go to another wallet. The address is checked, shown back in full and ticked; the launcher then claims nothing and the coin page says where the fee goes.
  // What the page SENDS matters most (a wrong wallet strands the fee for good), so the launch call is watched.
  const handTo = Keypair.generate().publicKey.toBase58();
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('snarks-flow-check')], SystemProgram.programId)[0].toBase58();
  const myAddr = await p.evaluate(async () => (await import('/src/lib/wallet.svelte.ts')).wallet.address);
  await p.evaluate(async () => { const { mock } = await import('/src/lib/mock/index.ts'); window.__launches = []; const orig = mock.launchTx.bind(mock); mock.launchTx = async (input) => { window.__launches.push(JSON.parse(JSON.stringify(input))); return orig(input) } });
  const lastLaunch = () => p.evaluate(() => window.__launches[window.__launches.length - 1] || null);
  await p.goto('http://localhost:5199/#/launch', { waitUntil: 'networkidle0' }); await sleep(500);
  await clickText(p, 'label.tier', '4%'); await sleep(200);
  const hin = await p.$$('form input.input'); await hin[0].type('Handover Coin'); await hin[1].type('hand1');
  const walletField = '.creator input.input';
  const walletText = () => p.evaluate(() => document.querySelector('.creator').innerText.replace(/\s+/g, ' ').trim());
  const echoOf = () => p.evaluate(() => ({ shown: document.querySelector('.creator .echo .shown')?.textContent.trim() || null, text: document.querySelector('.creator .echo')?.innerText.replace(/\s+/g, ' ') || '', ticked: document.querySelector('.creator .echo input[type=checkbox]')?.checked ?? null }));
  await setVal(walletField, 0, 'not-a-wallet'); await sleep(250);
  R.push(['creator wallet: a value that is not an address says so in plain words, right under the field, and holds Launch', /That is not a wallet address\. A Solana address is 32 to 44 letters and digits\./.test(await walletText()) && (await launchBtnDisabled()) === true]);
  await setVal(walletField, 0, offCurve); await sleep(250);
  R.push(['creator wallet: a program-derived address is refused as unable to sign, and holds Launch', /That address belongs to a program or a token account, which cannot sign\. Use a wallet address\./.test(await walletText()) && (await launchBtnDisabled()) === true]);
  await setVal(walletField, 0, myAddr); await sleep(250);
  R.push(['creator wallet: the connected wallet typed again says there is nothing to hand over, shows no tick, and Launch is open', /Same as your connected wallet: nothing to hand over\./.test(await walletText()) && (await echoOf()).shown === null && (await launchBtnDisabled()) === false]);
  await setVal(walletField, 0, '  ' + handTo + '  '); await sleep(250);
  const echo0 = await echoOf();
  R.push(['creator wallet: a real wallet is shown back in full with the warning and an unticked box, and Launch waits for the tick', echo0.shown === handTo && /Only this wallet can claim the creator fee, and the launch cannot be undone\. Check every character\./.test(echo0.text) && /I checked this address\./.test(echo0.text) && echo0.ticked === false && (await launchBtnDisabled()) === true]);
  const tickAboveLaunch = () => p.evaluate(() => { const c = document.querySelector('.creator .echo input[type=checkbox]'); const go = document.querySelector('form .go button'); if (!c || !go) return false; const a = c.getBoundingClientRect(), b = go.getBoundingClientRect(); return a.width > 0 && a.bottom <= b.top });
  R.push(['creator wallet: with the address not yet ticked, the tick is in plain view right above Launch, which stays held, and nothing sends the creator to a hidden section', (await tickAboveLaunch()) && (await launchBtnDisabled()) === true && !/advanced/i.test(await body(p))]);
  await p.click('.creator .echo input[type=checkbox]'); await sleep(150);
  R.push(['creator wallet: the tick opens Launch', (await launchBtnDisabled()) === false]);
  const echoTicked = await echoOf();
  R.push(['creator wallet: ticked, the address and the ticked box stay in view', echoTicked.shown === handTo && echoTicked.ticked === true && (await tickAboveLaunch())]);
  await clickText(p, 'label.tier', 'SNARKS tier'); await sleep(250);
  R.push(['creator wallet: on the 1% tier the field is not shown (copy pass), so the address is not shown for sending, and Launch stays open', await p.evaluate(() => !document.querySelector('.creator') && !document.querySelector('.echo') && !/Creator wallet|creator's share is 0/i.test(document.querySelector('form').innerText)) && (await launchBtnDisabled()) === false]);
  await clickText(p, 'label.tier', '4%'); await sleep(250);
  const echo1 = await echoOf();
  R.push(['creator wallet: back on 4% the same address is shown again, still ticked', echo1.shown === handTo && echo1.ticked === true && (await launchBtnDisabled()) === false]);
  await clickText(p, 'label.tier', 'SNARKS tier'); await sleep(250);
  await clickText(p, 'button', 'Launch'); await sleep(1800);
  const done1 = await body(p); const launch1 = await lastLaunch();
  R.push(['creator wallet: a 1% launch with a checked address still typed sends no Creator wallet, and the launched panel says nothing about one', /\$HAND1 is live\./.test(done1) && launch1 !== null && launch1.name === 'Handover Coin' && launch1.creatorWallet === undefined && launch1.feeTier === undefined && !/Creator fees go to/.test(done1)]);
  await clickText(p, 'a', 'Open'); await sleep(600);
  await p.goto('http://localhost:5199/#/launch', { waitUntil: 'networkidle0' }); await sleep(500);
  await clickText(p, 'label.tier', '4%'); await sleep(200);
  const hin2 = await p.$$('form input.input'); await hin2[0].type('Pink Otter'); await hin2[1].type('otter1');
  await setVal(walletField, 0, '  ' + handTo + '  '); await sleep(250);
  await p.click('.creator .echo input[type=checkbox]'); await sleep(150);
  await clickText(p, 'button', 'Launch'); await sleep(1800);
  const handDone = await body(p); const launch4 = await lastLaunch();
  R.push(['creator wallet: a 4% launch sends exactly the checked address (spaces dropped), the launcher stays the creator, and nothing else is added', /\$OTTER1 is live\./.test(handDone) && launch4 !== null && launch4.creatorWallet === handTo && launch4.creator === myAddr && launch4.feeTier === 400 && launch4.name === 'Pink Otter']);
  R.push(['creator wallet: the launched panel says where the creator fee goes and that only that wallet can claim it', new RegExp('Creator fees go to ' + handTo.slice(0, 6) + '…' + handTo.slice(-6) + '; only that wallet can claim them\\.').test(handDone)]);
  await clickText(p, 'a', 'Open'); await sleep(900);
  const handPage = await p.evaluate(() => ({ line: document.querySelector('.payto')?.innerText.replace(/\s+/g, ' ').trim() || '', title: document.querySelector('.payto .mono')?.getAttribute('title') || '', claimPanel: document.body.innerText.includes('Your creator fees') || document.body.innerText.includes('Claim creator fees') }));
  R.push(['creator wallet: the coin page says where the creator fee goes, the full address is on hover, and the launcher gets no claim panel', handPage.line === 'Creator fees go to ' + handTo.slice(0, 6) + '…' + handTo.slice(-6) && handPage.title === handTo && handPage.claimPanel === false]);
  await p.goto('http://localhost:5199/#/coin/' + mint, { waitUntil: 'networkidle0' }); await sleep(500);
  const sc = await body(p);
  const scSplit = await p.evaluate(() => document.querySelector('.fs').innerText.replace(/\s+/g, ' '));
  R.push(['SNARKS (1% tier): no creator claim panel for a non-creator, and the fee split without a creator part and without per-$100 figures (copy pass)', !sc.includes('Your creator fees') && /Holders 10%/.test(scSplit) && !/\$\d|Of every \$100/.test(scSplit) && !/Creator/.test(sc)]);
  R.push(['SNARKS header: Coin #1 and "1% fee on curve"', await p.evaluate(() => [...document.querySelectorAll('.trow .chip')].map(c => c.textContent.trim()).join('|')) === 'Coin #1|1% fee on curve']);
  await p.goto('http://localhost:5199/#/treasury', { waitUntil: 'networkidle0' }); await sleep(500);
  const tb = await body(p);
  R.push(['treasury simulated chip', /simulated/i.test(tb)], ['fallback epoch', /paid as solana zec/i.test(tb)]);
  R.push(['no pause banner while running', !/payouts are paused/i.test(tb)]);
  await p.goto('http://localhost:5199/?paused=1#/treasury', { waitUntil: 'networkidle0' }); await sleep(500);
  R.push(['pause banner when paused', /payouts are paused\. nothing is lost/i.test(await body(p))]);
  const all = await p.evaluate(() => document.documentElement.outerHTML);
  R.push(['no anonymous', !/anonymous/i.test(all)]);
  // Explore (home = the market): the strip, the tabs as presets, the sort, the search, the list view, the pages, the empty state.
  // The two coins launched above are dropped from the mock's storage first, so the market is the five seed coins.
  await p.evaluate(() => localStorage.removeItem('snarks-mock-v1'));
  await p.goto('http://localhost:5199/#/', { waitUntil: 'networkidle0' }); await sleep(500);
  const home = await body(p);
  const cardNames = () => p.evaluate(() => [...document.querySelectorAll('.grid .card .name, .list .lrow strong')].map(e => e.textContent.trim()));
  const tiles = () => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('dl.stats > div')].map((d) => [d.querySelector('dt').textContent.trim(), d.querySelector('dd').textContent.trim()])));
  const t0 = await tiles();
  R.push(['explore: headline, strip and the stats row on the home page, with no opted-in count (removed in the copy pass)', home.includes('Coins on Meteora that pay holders in ZEC') && home.includes('Closest to graduation') && t0.Coins === '5' && t0.Graduated === '1' && t0['Paid to holders so far'] === '1.4697 ZEC' && t0['Of it shielded'] === '0.0881 ZEC' && !('Opted in' in t0)]);
  R.push(['explore: the live trades tape sits beside the strip, five 44px rows, each a link to its coin, the creator\'s trade tagged dev', await p.evaluate(() => { const rows = [...document.querySelectorAll('.tape-sec .row')]; return rows.length === 5 && rows.every((r) => /#\/coin\//.test(r.getAttribute('href')) && r.getBoundingClientRect().height >= 44) && !!document.querySelector('.tape-sec .tg') && !document.querySelector('.tape-sec').hidden })]);
  R.push(['explore: a card carries holders, the 24h change with its sign, and the ZEC still to go', await p.evaluate(() => { const c = [...document.querySelectorAll('.grid .card')].find((x) => /Release The Snarks/.test(x.textContent)); const dd = [...c.querySelectorAll('.nums dd')].map((d) => d.textContent.trim()); return dd.includes('1,284') && dd.includes('+4.2%') && /2\.53 ZEC to go/.test(c.querySelector('.togo').textContent) })]);
  R.push(['explore: no hero copy left on the home page', !home.includes('Every buy and sell pays a 1% fee') && !home.includes('Hidden from the public')]);
  R.push(['explore: the strip lists the curve coins nearest graduation, in order, without the graduated one', await p.evaluate(() => { const n = [...document.querySelectorAll('.near .ncard .name')].map(e => e.textContent.trim()); return n[0] === 'Crayon Cat' && n[1] === 'Release The Snarks' && !n.includes('Halo Arc'); })]);
  const grid0 = await cardNames();
  R.push(['explore: the default Featured order pins coin #1 first, then market cap', grid0[0] === 'Release The Snarks' && grid0[1] === 'Halo Arc' && grid0.length === 5 && /coin #1/i.test(home) && await p.evaluate(() => document.querySelector('select.sel').value === 'featured')]);
  await p.select('select.sel', 'mcap'); await sleep(500);
  R.push(['explore: Market cap is a strict order (Halo Arc 410 ZEC first), the All tab stays lit', (await cardNames())[0] === 'Halo Arc' && await p.evaluate(() => document.querySelector('[role=tab][aria-selected=true]').textContent.trim() === 'All')]);
  R.push(['explore: a card says what holders get of every trade, the same 0.1% on every tier, and its fee', /pays holders 0\.1% in ZEC/i.test(await body(p)) && /10% fee/i.test(await body(p)) && !/holder rewards 6%/i.test(await body(p))]);
  // the fee badge says which fee it is: flat and "on curve" while a coin is on its curve, the graduated pool's range once it has graduated; never a bare percentage
  const feeBadges = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.grid .card')].map(c => [c.querySelector('.name').textContent.trim(), [...c.querySelectorAll('.badges .chip')].filter(x => /\bfee\b/i.test(x.textContent)).map(x => x.textContent.trim() + ' // ' + x.title)])));
  const feeOf = (n) => (feeBadges[n] || []).join('|');
  R.push(['explore: every card prints its fee with its qualifier (1, 2, 4 and 10% fee on curve; the graduated coin 1-1.2% fee)', feeOf('Release The Snarks').startsWith('1% fee on curve //') && feeOf('Shielded Pie').startsWith('2% fee on curve //') && feeOf('Crayon Cat').startsWith('4% fee on curve //') && feeOf('Zatoshi').startsWith('10% fee on curve //') && feeOf('Halo Arc').startsWith('1-1.2% fee //')]);
  R.push(['explore: the fee chip hover tells the other half (the curve coin: what it becomes after graduation; the graduated coin: what the pool charges)', feeOf('Release The Snarks').endsWith('Flat while the coin is on its curve. After graduation: 1%, rising to about 1.2% when trading is volatile') && feeOf('Halo Arc').endsWith("Meteora's pool charges 1%, rising to about 1.2% when trading is volatile")]);
  await clickText(p, '[role=tab]', 'Graduated'); await sleep(500);
  const grad = await cardNames();
  R.push(['explore: Graduated tab shows only the graduated coin', grad.length === 1 && grad[0] === 'Halo Arc' && (await body(p)).includes('Graduated')]);
  await p.click('.grid .card'); await sleep(900);
  R.push(['coin page of the graduated coin: the header chip says "1-1.2% fee" next to Graduated, and the Trading fee stat is the range', await p.evaluate(() => [...document.querySelectorAll('.trow .chip')].map(c => c.textContent.trim()).join('|')) === '1-1.2% fee|Graduated' && /Trading fee\s+1-1\.2%/i.test(await body(p))]);
  await p.goto('http://localhost:5199/#/', { waitUntil: 'networkidle0' }); await sleep(500);
  await clickText(p, '[role=tab]', 'New'); await sleep(500);
  R.push(['explore: New tab lists the newest coin first', (await cardNames())[0] === 'Zatoshi']);
  await p.select('select.sel', 'volume'); await sleep(500);
  R.push(['explore: changing the sort under New moves the light to Rising (volume), Halo Arc first', (await cardNames())[0] === 'Halo Arc' && await p.evaluate(() => document.querySelector('[role=tab][aria-selected=true]').textContent.trim() === 'Rising')]);
  await p.type('input.search', 'cray'); await sleep(700);
  R.push(['explore: search narrows the grid by name', JSON.stringify(await cardNames()) === JSON.stringify(['Crayon Cat'])]);
  await p.evaluate(() => { const i = document.querySelector('input.search'); i.value = 'zzz'; i.dispatchEvent(new Event('input', { bubbles: true })) }); await sleep(700);
  R.push(['explore: a search with no match says so and offers the way back', (await body(p)).includes('No coins match.') && (await body(p)).includes('Show all coins')]);
  await clickText(p, 'button', 'Show all coins'); await sleep(500);
  R.push(['explore: Show all coins returns to the full All tab', (await cardNames()).length === 5]);
  await clickText(p, '.view button', 'List'); await sleep(300);
  R.push(['explore: list view has one row per coin with the column headers, holders and 24h change among them', (await p.$$('.list .lrow')).length === 5 && /24h volume/i.test(await body(p)) && /bonded/i.test(await body(p)) && await p.evaluate(() => { const h = [...document.querySelectorAll('.lhead [role=columnheader]')].map((x) => x.textContent.trim()); const r = document.querySelector('.list .lrow'); return h.includes('Holders') && h.includes('24h') && getComputedStyle(document.querySelector('.lhead')).gridTemplateColumns.split(' ').length === getComputedStyle(r).gridTemplateColumns.split(' ').length && /1,284/.test(r.innerText) && /\+4\.2%/.test(r.innerText) })]);
  const feeCells = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.list .lrow')].map(r => [r.querySelector('strong').textContent.trim(), [...r.querySelectorAll('[role=cell]')][6].innerText.replace(/\s+/g, ' ').trim()])));
  R.push(['explore: the list view prints the fee column with its qualifier (1% on curve, 1-1.2% in pool)', feeCells['Release The Snarks'] === '1% on curve' && feeCells['Crayon Cat'] === '4% on curve' && feeCells['Zatoshi'] === '10% on curve' && feeCells['Halo Arc'] === '1-1.2% in pool']);
  await p.setViewport({ width: 390, height: 844 });
  await p.reload({ waitUntil: 'networkidle0' }); await sleep(600); // a reload, not a goto: the same address with the same hash would keep the list view
  R.push(['explore at 390px: no sideways scroll, and each of the 5 cards has one fee chip that stays inside it', await p.evaluate(() => { const cards = [...document.querySelectorAll('.grid .card')]; return document.documentElement.scrollWidth <= window.innerWidth && cards.length === 5 && cards.every(c => { const r = c.getBoundingClientRect(); const fee = [...c.querySelectorAll('.badges .chip')].filter(x => /\bfee\b/i.test(x.textContent)); return fee.length === 1 && fee[0].getBoundingClientRect().left >= r.left && fee[0].getBoundingClientRect().right <= r.right; }); })]);
  // phone (field study item 12): the bottom bar carries Explore, Launch, Shielded and Payouts (named Treasury until the copy pass); the header's link row is gone; the coin page's Buy is in the first screen
  R.push(['phone: a bottom bar with the four pages, Explore current, in place of the header links', await p.evaluate(() => { const bar = document.querySelector('nav[aria-label=Pages]'); const items = [...bar.querySelectorAll('a')].map((a) => a.textContent.trim()); return getComputedStyle(bar).display === 'grid' && getComputedStyle(bar).position === 'fixed' && JSON.stringify(items) === JSON.stringify(['Explore', 'Launch', 'Shielded', 'Payouts']) && bar.querySelector('[aria-current=page]').textContent.trim() === 'Explore' && getComputedStyle(document.querySelector('header nav')).display === 'none' })]);
  await p.goto('http://localhost:5199/#/coin/' + mint, { waitUntil: 'networkidle0' }); await sleep(600);
  R.push(['phone: the coin page puts the buy button inside the first 844px, with no sideways scroll', await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Connect wallet to buy/.test(x.textContent)); return b.getBoundingClientRect().bottom <= 844 && document.documentElement.scrollWidth <= window.innerWidth })]);
  R.push(['phone: the four coin tabs fit on one row with the short fourth label', await p.evaluate(() => { const bs = [...document.querySelectorAll('.ctabs [role=tab]')]; const tops = new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))); return tops.size === 1 && bs.every((b) => b.getBoundingClientRect().right <= 390) && /Info/.test(bs[3].innerText) })]);
  await p.setViewport({ width: 1280, height: 900 });
  await p.goto('http://localhost:5199/?many=1#/', { waitUntil: 'networkidle0' }); await sleep(500);
  R.push(['explore: pages appear above 12 coins (35 coins = 3 pages), Next moves on', (await body(p)).includes('Page 1 of 3') && (await cardNames()).length === 12 && (await clickText(p, 'button', 'Next'), await sleep(400), (await body(p)).includes('Page 2 of 3'))]);
  await p.goto('http://localhost:5199/?stats=off#/', { waitUntil: 'networkidle0' }); await sleep(600);
  const t24 = await tiles();
  R.push(['explore: without /stats (a v2.4 engine) the stats row is computed from /coins and /epochs, with no opted-in tile', t24.Coins === '5' && t24.Graduated === '1' && t24['24h volume on this pad'] === '4.72 ZEC' && t24['Paid to holders so far'] === '1.4697 ZEC' && t24['Of it shielded'] === '0.0881 ZEC' && !('Opted in' in t24)]);
  await p.goto('http://localhost:5199/?empty=1#/', { waitUntil: 'networkidle0' }); await sleep(500);
  const emptyB = await body(p);
  const tEmpty = await tiles();
  R.push(['explore: a fresh pad says "No coins yet. Launch the first." with the button, "None yet" paid and the next payout', emptyB.includes('No coins yet. Launch the first.') && emptyB.includes('Launch a coin') && tEmpty['Paid to holders so far'] === 'None yet' && 'Next payout' in tEmpty && !('Of it shielded' in tEmpty)]);
  // the launch window (contract v2.8; mock ?window=open: SNARKS launched the moment this page loaded, so its first 5 seconds are open here): the seconds left and the fee now count down,
  // Buy is held as "Wait N s", and it opens when the engine says the window has closed. Sampled every 100 ms from the first look until 1.5 s after the timer is gone.
  await p.goto('http://localhost:5199/?window=open#/coin/' + mint, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.trade [role=timer]', { timeout: 6000 }).catch(() => {});
  await ensureWallet();
  await p.type('input[inputmode=decimal]', '0.1');
  const win = await p.evaluate(() => new Promise((resolve) => {
    const out = []; const t0 = performance.now(); let closedAt = null;
    const look = () => {
      const box = document.querySelector('.trade') || document.body; const timer = box.querySelector('[role=timer]');
      const btn = [...box.querySelectorAll('button')].find((b) => /^(Buy \$\w+|Sell \$\w+|Wait \d+ s)$/.test(b.textContent.trim()));
      const text = box.innerText; const got = /You get about\s+([\d,]+)\s+SNARKS/.exec(text);
      out.push({ timer: timer ? timer.textContent.replace(/\s+/g, ' ').trim() : null, live: timer ? timer.getAttribute('aria-live') : null, btn: btn ? btn.textContent.trim() : null, off: btn ? btn.disabled : null, fee: text.includes('Fee now (launch window)'), got: got ? Number(got[1].replace(/,/g, '')) : null });
      if (!timer && closedAt === null) closedAt = performance.now();
      if (performance.now() - t0 > 9000 || (closedAt !== null && performance.now() - closedAt > 1500)) resolve(out); else setTimeout(look, 100);
    };
    look();
  }));
  const open = win.filter((s) => s.timer);
  const secs = open.map((s) => Number((/(\d+) s left/.exec(s.timer) || [])[1]));
  const fees = open.map((s) => Number((/fee now ([\d.]+)%/.exec(s.timer) || [])[1]));
  const only = (a, dir) => a.every((v, i) => i === 0 || (dir < 0 ? v <= a[i - 1] : v >= a[i - 1]));
  const lastLook = win[win.length - 1];
  R.push(['launch window: the trade box says the seconds left and the fee now in words, both only fall, from at most 5 s and 99%', open.length >= 3 && /^Launch window: \d s left, fee now [\d.]+%$/.test(open[0].timer) && secs.every((n) => n >= 1 && n <= 5) && only(secs, -1) && new Set(secs).size >= 2 && fees.every((f) => [99, 79.4, 59.8, 40.2, 20.6].includes(f)) && only(fees, -1)]);
  R.push(['launch window: the timer is a role=timer with no live region, so a screen reader is not read a number every second', open.length >= 1 && open.every((s) => s.live === null)]);
  const heldLooks = open.filter((s) => s.btn !== null);
  R.push(['launch window: while it is open Buy is held and reads "Wait N s", the same N as the timer', heldLooks.length >= 2 && heldLooks.every((s) => s.off === true && s.btn === 'Wait ' + (/(\d+) s left/.exec(s.timer) || [])[1] + ' s')]);
  R.push(['launch window: Buy is never open while the timer shows', win.every((s) => !(s.timer && s.btn && s.off === false))]);
  const quoted = open.filter((s) => s.got !== null); const requoted = win.filter((s) => !s.timer && s.got !== null);
  R.push(['launch window: a quote taken inside it shows the fee now; once it closes the quote is asked again, the fee row goes and the same 0.1 ZEC buys more', quoted.length >= 1 && quoted.every((s) => s.fee) && requoted.length >= 1 && requoted.every((s) => !s.fee) && requoted[requoted.length - 1].got > quoted[0].got]);
  R.push(['launch window: when the engine says it has closed the timer is gone and Buy opens', !lastLook.timer && lastLook.btn === 'Buy $SNARKS' && lastLook.off === false]);
  // Sell is held the same way, and on a phone the line and the button still fit in the first screen with no sideways scroll
  await p.setViewport({ width: 390, height: 844 });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.trade [role=timer]', { timeout: 6000 }).catch(() => {});
  await ensureWallet();
  const phoneBuy = await p.evaluate(() => { const b = [...document.querySelectorAll('.trade button')].find((x) => /^(Buy \$\w+|Wait \d+ s)$/.test(x.textContent.trim())); const t = document.querySelector('.trade [role=timer]'); return { label: b?.textContent.trim(), bottom: b?.getBoundingClientRect().bottom, timerRight: t?.getBoundingClientRect().right, wide: document.documentElement.scrollWidth > window.innerWidth } });
  await clickText(p, '[role=tab]', 'Sell'); await sleep(200);
  const sellHeld = await p.evaluate(() => { const b = [...document.querySelectorAll('.trade button')].find((x) => /^(Sell \$\w+|Wait \d+ s)$/.test(x.textContent.trim())); return { label: b?.textContent.trim(), off: b?.disabled, timer: !!document.querySelector('.trade [role=timer]') } });
  R.push(['launch window: Sell is held the same way, as "Wait N s"', sellHeld.timer && /^Wait \d s$/.test(sellHeld.label) && sellHeld.off === true]);
  R.push(['launch window at 390px: the timer line and the held button sit inside the first screen, with no sideways scroll', /^Wait \d s$/.test(phoneBuy.label) && phoneBuy.bottom <= 844 && phoneBuy.timerRight <= 390 && phoneBuy.wide === false]);
  await p.setViewport({ width: 1280, height: 900 });
  // a v2.5 engine (the one live on snarks.fun on 2026-10-04): every v2.6 block hides or falls back, nothing errors
  await p.goto('http://localhost:5199/?v25=1#/', { waitUntil: 'networkidle0' }); await sleep(600);
  R.push(['v2.5 engine: the home tape is hidden and the cards show no "ZEC to go"', await p.evaluate(() => document.querySelector('.tape-sec').hidden && !document.querySelector('.grid .card .togo') && document.querySelectorAll('.grid .card').length === 5)]);
  await p.goto('http://localhost:5199/?v25=1#/coin/' + mint, { waitUntil: 'networkidle0' }); await sleep(600);
  await p.type('input[inputmode=decimal]', '0.1'); await sleep(900);
  R.push(['v2.5 engine: the buy box asks for a wallet instead of quoting, as before', (await tradeBox()).includes('Connect a Solana wallet to get a quote.') && !(await tradeBox()).includes('You get about')]);
  R.push(['v2.5 engine: the trades tab falls back to the coin\'s own recent trades, with no refresh timer printed (removed in the copy pass)', await p.evaluate(() => document.querySelectorAll('.panel-body .tape .row').length === 8 && !/refreshes every/.test(document.querySelector('.panel-body')?.innerText || ''))]);
  await clickText(p, '.ctabs [role=tab]', 'Holders'); await sleep(700);
  R.push(['v2.5 engine: the holders tab shows the count and says the list is not available yet', /1,284 holders\. The holder list is not available on this pad's engine yet\./.test(await p.evaluate(() => document.querySelector('.panel-body').innerText))]);
  await clickText(p, '.ctabs [role=tab]', 'Token info'); await sleep(700);
  const fx25 = await p.evaluate(() => document.querySelector('.panel-body').innerText);
  R.push(['v2.5 engine: Token info falls back to the coin\'s own record: the trading fee, fixed at launch, and the creator fee, with no chain-read fact (the round trip moved to the Risk notice)', /Trading fee: 1%, fixed at launch\./.test(fx25) && /Creator fee: None\./.test(fx25) && !/Mint authority/.test(fx25)]);
  R.push(['v2.5 engine: Token info says it is read from the coin\'s record and that the chain checks are missing (the sends fact lives on How it works)', !/Wallet-to-wallet/i.test(fx25) && /Read from this coin's record\. The chain checks are not available on this pad's engine yet\./.test(fx25)]);
  await p.goto('http://localhost:5199/?v25=1#/treasury', { waitUntil: 'networkidle0' }); await sleep(600);
  R.push(['v2.5 engine: no CSV link on the treasury, the team net still printed from the epoch', await p.evaluate(() => !document.querySelector('a.csv') && /team net/.test(document.querySelector('.row .split').innerText))]);
  await p.goto('http://localhost:5199/?v25=1#/shielded', { waitUntil: 'networkidle0' }); await sleep(300);
  await ensureWallet(); await sleep(600);
  R.push(['v2.5 engine: neither My rewards nor the memo verifier shows on the Shielded page', await p.evaluate(() => !document.querySelector('.mine') && !document.querySelector('.verify'))]);
  // a v2.7 engine (the one live on snarks.fun before the launch window): no window anywhere, every fee sentence says what it said before, and the Launch preview has a dash where the window would be
  await p.goto('http://localhost:5199/?v27=1#/coin/' + mint, { waitUntil: 'networkidle0' }); await sleep(600);
  const box27 = await p.evaluate(() => ({ timer: !!document.querySelector('.trade [role=timer]'), tierline: !!document.querySelector('.tierline'), body: document.body.innerText }));
  await clickText(p, '.ctabs [role=tab]', 'Token info'); await sleep(700);
  const fx27 = await p.evaluate(() => document.querySelector('.panel-body').innerText);
  R.push(['v2.7 engine: no timer in the trade box, no fee line under the stats (copy pass), the Trading fee fact has no window clause, there is no Launch window fact, and the no-exemptions sentence stands', box27.timer === false && box27.tierline === false && !/This coin's fee is/.test(box27.body) && /Trading fee: 1% on the bonding curve, fixed at launch\./.test(fx27) && !/Launch window/i.test(fx27) && /There are no snipe exemptions, no whitelist and no paid placements on this pad/.test(fx27) && !/launch window/i.test(box27.body)]);
  await p.goto('http://localhost:5199/?v27=1#/launch', { waitUntil: 'networkidle0' }); await sleep(600);
  const card27 = await p.evaluate(() => ({ card: document.querySelector('.preview .card').innerText.replace(/\s+/g, ' '), page: document.body.innerText.replace(/\s+/g, ' ') }));
  R.push(['v2.7 engine: the Launch preview shows a dash for the window, and the one fee line is the same line, with no per-$100 split', /LAUNCH WINDOW – GRADUATION /i.test(card27.card) && /1% on every trade, paid in ZEC, fixed at launch\./.test(card27.page) && !/Per \$100/.test(card27.page) && !/launch window has closed/.test(card27.page)]);
  // the shielded page with a wallet (field study item 9): my rewards with signatures, the shielded rail as counts, the memo verifier
  await p.goto('http://localhost:5199/#/shielded', { waitUntil: 'networkidle0' }); await sleep(300);
  await ensureWallet(); await sleep(800);
  const mine = await p.evaluate(() => document.querySelector('.mine')?.innerText || '');
  R.push(['shielded: My rewards lists each Solana ZEC payout per round with its batch signature and the coins it came from, and says the shielded rail is private until the wallet signs (v2.9)', /Paid to \S+ as Solana ZEC: 0\.0053 ZEC over 3 rounds/.test(mine) && (mine.match(/COPY/g) || []).length === 3 && /\$SNARKS/.test(mine) && /\$PIE/.test(mine) && /Shielded rewards are private/.test(mine) && !/Shielded: /.test(mine)]);
  await clickText(p, '.mine button', 'Show shielded details'); await sleep(900);
  const mineSigned = await p.evaluate(() => document.querySelector('.mine')?.innerText || '');
  R.push(['shielded: one signature shows the shielded rail as a count', /Shielded: (delivery is on, and )?no batch has paid this wallet/.test(mineSigned)]);
  const memoCheck = async (text, txid = '') => { await p.evaluate((t, x) => { const [i, j] = document.querySelectorAll('.verify input'); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); j.value = x; j.dispatchEvent(new Event('input', { bubbles: true })) }, text, txid); await clickText(p, '.verify button', 'Verify memo'); await sleep(700); return p.evaluate(() => document.querySelector('.verify').innerText) };
  const memoBad = await memoCheck('hello');
  const batch = await p.evaluate(async () => { const e = (await (await import('/src/lib/mock/index.ts')).mock.epochs()).epochs.find((e) => e.shielded.count > 0); return { id: e.id, txid: e.shielded.zcashTxids[0] } });
  const memoGood = await memoCheck('SNARKS pad reward, epoch ' + batch.id);
  R.push(['shielded: the memo verifier says what it shows (which payout a note came from), refuses junk in plain words and ties a real memo to its round, date and transaction', /Paste the memo from a note in your Zcash wallet to see which payout it came from\./.test(memoGood) && /Not a memo this pad wrote/.test(memoBad) && /Verified for round #7/.test(memoGood) && /one batched shielded transaction to 6 addresses/.test(memoGood) && /Zcash transaction/.test(memoGood)]);
  R.push(['shielded: a verified memo says in one line that it does not show the note is yours or its amount', /The memo is the same on every note of a round, so it shows which payout a note came from, not that the note is yours or its amount\./.test(memoGood)]);
  const memoTx = await memoCheck('SNARKS pad reward, epoch ' + batch.id, batch.txid);
  const memoWrongTx = await memoCheck('SNARKS pad reward, epoch ' + batch.id, 'f'.repeat(64));
  R.push(['shielded: the optional transaction id is checked against the round\'s batch, both ways', /is one of that round's batch/.test(memoTx) && /is not in that round's batch/.test(memoWrongTx)]);
  await clickText(p, '.verify button', 'Sign to check this round has a row for my wallet'); await sleep(900);
  R.push(['shielded: with a wallet, one signature asks whether the round has a row for it, and the answer is in words', /This round has (a|no) row for your wallet/.test(await p.evaluate(() => document.querySelector('.verify').innerText))]);
  // treasury (field study item 10): the delivery cost and the team net per round, the CSV of every round
  await p.goto('http://localhost:5199/#/treasury', { waitUntil: 'networkidle0' }); await sleep(600);
  R.push(['treasury: each round prints the delivery cost paid from the team share and the team net; a CSV link downloads every round', await p.evaluate(() => /shielded delivery cost [\d.]+ paid from the team share, team net [\d.]+/.test(document.querySelector('.row .split').innerText) && document.querySelector('a.csv')?.getAttribute('download') === 'snarks-epochs.csv')]);
  // the app shell: a manifest with icons, the apple metas, the worker file
  const shell = await p.evaluate(async () => { const m = await (await fetch('/manifest.webmanifest')).json(); const sw = await fetch('/sw.js'); return { name: m.name, display: m.display, icons: m.icons.length, swOk: sw.ok, swNoApi: /startsWith\('\/api\/'\)/.test(await sw.text()), link: !!document.querySelector('link[rel=manifest]'), apple: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]') } });
  R.push(['app shell: manifest (standalone, 3 icons), apple metas, and a worker that skips /api/', shell.name === 'SNARKS pad' && shell.display === 'standalone' && shell.icons === 3 && shell.swOk && shell.swNoApi && shell.link && shell.apple]);
  // How it works and the footer
  await p.goto('http://localhost:5199/#/how', { waitUntil: 'networkidle0' }); await sleep(500);
  const how = await body(p);
  R.push(['how it works: fee split, three steps, hidden list, Meteora, cadence, the tribute', how.includes("Where every trade's fee goes") && how.includes('Shielded delivery in three steps') && how.includes('Hidden from the public') && how.includes('Meteora can pause it or change its fee') && how.includes('Every two days holders are paid their share as Solana ZEC. Holders who chose shielded delivery are paid once a week. Very small shares wait for a later payout; nothing is lost.') && how.includes('RELEASE THE SNARKS')]);
  // the comparison naming other launchpads, with dated sources, left the page in the copy pass (owner, 2026-10-07); its points are a "Why SNARKS pad" list with no comparison
  R.push(['how it works: no other launchpad named and no dated claim about one; the "Why SNARKS pad" list states the differences: holders get 10% of each fee in ZEC (no transfer tax, no selling the coin\'s supply), shielded delivery a week with nothing to claim, the fees go to a 2-of-3 Squads vault (the delivery cost paid first is in the Terms)', !/pump\.fun|EmberCurve|StonkFun|Sapling can|Holder Rewards board|Other pads pay holders|12 September 2026|read on 4 October 2026/i.test(how) && how.includes('Why SNARKS pad') && /10% of it goes to the coin's holders each round: as Solana ZEC, or as native ZEC/.test(how) && /Rewards in ZEC, never in the coin\. Holders are paid from the trading fee, so payouts never sell the coin's own supply\. There is no transfer tax\./.test(how) && /Shielded if you want it\. Opt in once and your share arrives as native ZEC in your own Zcash wallet, in one shielded transaction a week\. Nothing to claim\./.test(how) && /Fees go to a vault, not a person\. The pad's share of the fees is claimed into a 2-of-3 Squads vault\. No single key can move it\./.test(how)]);
  R.push(['how it works: after graduation the pool is Meteora\'s and Meteora can pause it or change its fee; its fee rises to about 1.2% (the 1% round trip moved to the Risk notice)', /After graduation the pool is Meteora's: Meteora can pause it or change its fee\./.test(how) && /1% rises to about 1\.2%/.test(how)]);
  R.push(['how it works: sends pay no fee ("There is no transfer tax."), and no per-tier round-trip table (the round trip is on the Risk notice, checked there)', /There is no transfer tax\./.test(how) && !/\$3\.96|\$7\.84|\$11\.64|\$19\.00/.test(how)]);
  const howWin = await p.evaluate(() => document.querySelector('#window-h').closest('section').innerText.replace(/\s+/g, ' ').trim());
  R.push(['how it works: a section on the launch window: the 1% tier\'s five steps, who pays, the held Buy button, the launcher\'s own first buy, that it cannot change; no promise of protection', howWin.startsWith("The launch window Every coin's first five seconds cost more.") && /on the 1% tier 99%, 79\.4%, 59\.8%, 40\.2%, 20\.6%, then 1% from second 5\./.test(howWin) && /A bot that buys in the launch block pays that fee, and holders get their usual share of it\./.test(howWin) && /The pad's pages hold Buy for those seconds and show a countdown, so a person who waits pays the coin's fee\./.test(howWin) && /The launcher's own first buy, inside the launch transaction, pays the coin's fee\./.test(howWin) && /It is written into the Meteora config and can never change\.$/.test(howWin) && !/protect|snip|safe|guarantee/i.test(howWin) && /The fee is fixed at launch and charged on every buy and sell once the launch window below has closed\./.test(how)]);
  R.push(['footer: brand line, Product and Legal columns, the risk line, nothing apologetic; the independence line left the footer for the Terms (copy pass)', how.includes('the pad never holds your coins') && how.includes('Terms of use') && how.includes('Risk notice') && how.includes('Coins launched here are speculative and can lose all their value. Nothing on this site is advice.') && !how.includes('Independent project') && !/unofficial|fan-made/i.test(how)]);
  const legal = {};
  for (const [path, title, text] of [['terms', 'Terms of use', 'never holds your coins'], ['privacy', 'Privacy', 'No analytics, no cookies'], ['risk', 'Risk notice', 'Fees are final']]) {
    await p.goto('http://localhost:5199/#/' + path, { waitUntil: 'networkidle0' }); await sleep(300);
    const t = await body(p); legal[path] = t;
    R.push([`footer link: #/${path} renders "${title}"`, t.includes(title) && t.includes(text) && t.includes('Version of 7 October 2026') && (await p.title()) === `${title}, SNARKS pad`]);
  }
  // facts that left the footer, How it works, the coin page and the Launch page in the copy pass, where they are now
  R.push(['terms: the independence line, here only (it left the footer), Meteora can pause a graduated pool or change its fee, and who pays for shielded delivery first', legal.terms.includes('Independent project. Not affiliated with Zcash, Electric Coin Co., the Zcash Foundation or Meteora.') && !legal.privacy.includes('Independent project') && !legal.risk.includes('Independent project') && legal.terms.includes('After graduation Meteora can pause a pool or change its fee.') && legal.terms.includes("The cost of delivering shielded rewards is paid from the team's share first; if it ever costs more than that share, the excess comes off the shielded holders' payouts.")]);
  R.push(['risk notice: the graduated pool line (Meteora can pause that pool or change its fee) and what a buy and an immediate sell costs at a 1% fee', legal.risk.includes('A graduated coin trades in a Meteora pool. Meteora can pause that pool or change its fee.') && legal.risk.includes('Buying and selling straight back pays the fee twice: about $1.99 of every $100 at a 1% fee.')]);
  R.push(['nav: Explore, Launch, Shielded, Payouts (named Treasury until the copy pass), How it works and the Launch a coin button', await p.evaluate(() => { const l = [...document.querySelectorAll('header nav a')].map(a => a.textContent.trim()); return JSON.stringify(l) === JSON.stringify(['Explore', 'Launch', 'Shielded', 'Payouts', 'How it works']) && !!document.querySelector('header .tools a.btn.primary'); })]);
  // devnet faucet (mock, ?devnet=1): the message reads the amounts from the answer; a faucet without test money says so in plain words, never as an error code
  const faucetPage = async (query) => {
    await p.goto('http://localhost:5199/?devnet=1' + query + '#/', { waitUntil: 'networkidle0' });
    await clickText(p, 'button', 'Connect wallet'); await sleep(100);
    await clickText(p, 'button', 'Test wallet'); await sleep(500);
    return body(p);
  };
  const stocked = await faucetPage('');
  R.push(['devnet faucet: the button shows for a connected wallet', stocked.includes('Get test SOL and ZEC') && !stocked.includes('temporarily unavailable')]);
  await clickText(p, 'button', 'Get test SOL and ZEC'); await sleep(700);
  R.push(['devnet faucet: the message reads the amounts from the answer (0.02 SOL, 5 ZEC)', (await body(p)).includes('Sent: 0.02 devnet SOL and 5 test ZEC.')]);
  const dry = await faucetPage('&faucet=dry');
  R.push(['devnet faucet without test money: plain words in place of the button, no error code', /Test money temporarily unavailable/.test(dry) && !dry.includes('Get test SOL and ZEC') && !dry.includes('faucet_unavailable')]);
  await faucetPage('&faucet=race');
  await clickText(p, 'button', 'Get test SOL and ZEC'); await sleep(700);
  const raced = await body(p);
  R.push(['devnet faucet that answers 503 right after saying it had test money: the same plain words, never the code', /Test money temporarily unavailable/.test(raced) && !raced.includes('faucet_unavailable') && !raced.includes('Sending')]);
  await sleep(600); // the last page's last read
  if (padHits.size) console.log('other launchpads named: ' + [...padHits].join(' | '));
  R.push([`no page the walk-through opened (${pagesRead.size} addresses, read as they changed) names pump.fun, EmberCurve, StonkFun, Sapling as a launchpad, ZCAT, Bags, BONK.fun or Jupiter Studio`, pagesRead.size >= 20 && padHits.size === 0]);
  console.log(R.map(r => (r[1] ? 'PASS ' : 'FAIL ') + r[0]).join('\n')); console.log(errs.length ? 'ERR ' + errs.join('\n') : 'no page errors');
  await b.close();
})().catch(e => { console.error('FLOW CRASH', e.message); process.exit(1) });
