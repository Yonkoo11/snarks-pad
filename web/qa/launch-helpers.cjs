// Shared by qa/live-launch.cjs and qa/live-shots.cjs (test-only: nothing in here ships in the web bundle). A test wallet whose key lives in this Node
// process and signs through an exposed function, the page opened with it injected as window.phantom, the Launch form filled the way a creator fills it,
// and a reader of what the chain says a coin's metadata address is.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const nacl = require('tweetnacl')
const bs58 = require('bs58').default || require('bs58')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PICTURE = path.resolve(__dirname, '../public/mascot-256.jpg') // a picture to pick from the device
// The links of the proof coin: the pad's own site and X account (web/src/lib/site.ts), and Telegram's own channel, so nothing the coin points at is a guess at someone else's.
const LINKS = { website: 'https://snarks.fun', x: '@SnarksPad', telegram: 't.me/telegram' }

function newWallet() {
  const kp = nacl.sign.keyPair()
  return { kp, pk: bs58.encode(kp.publicKey), signed: { messages: 0, txs: 0 } }
}

/** Opens a page whose window.phantom is this wallet (it signs messages and transactions in this process). */
async function openPage(browser, wallet, { width = 1440, height = 900, theme = 'light', scale = 1 } = {}) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.exposeFunction('__qaSign', (bytes, kind) => {
    wallet.signed[kind === 'tx' ? 'txs' : 'messages']++
    return Array.from(nacl.sign.detached(Uint8Array.from(bytes), wallet.kp.secretKey))
  })
  await page.evaluateOnNewDocument((pk, t) => {
    try { localStorage.setItem('snarks-theme', t) } catch { /* storage blocked */ }
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
  }, wallet.pk, theme)
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
  await page.setViewport({ width, height, deviceScaleFactor: scale })
  return { page, errors }
}

const clickText = (page, sel, t) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled)
  if (!el) return false
  el.click(); return true
}, sel, t)

const setValue = (page, sel, i, v) => page.evaluate((sel, i, v) => {
  const el = document.querySelectorAll(sel)[i]
  el.value = v
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, sel, i, v)

/** Connects the injected wallet from the page's own button and waits for its short address to show. */
async function connect(page, pk) {
  if (!(await clickText(page, 'main button, section button', 'Connect wallet'))) await clickText(page, 'button', 'Connect wallet')
  await sleep(200)
  await clickText(page, 'button', 'Phantom')
  const short = pk.slice(0, 4) + '…' + pk.slice(-4)
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => document.body.innerText)).includes(short)) return true
    await sleep(250)
  }
  return false
}

/** Fills the Launch form: name, ticker, description, then the picture from a file, then the three links (the Links section is opened first, as a creator would). */
async function fillLaunchForm(page, { name, symbol, description, picture = PICTURE, links = LINKS, waitUpload = true }) {
  await setValue(page, 'form input.input', 0, name)
  await setValue(page, 'form input.input', 1, symbol)
  await setValue(page, 'form textarea', 0, description)
  await (await page.$('input[type=file]')).uploadFile(picture)
  if (waitUpload) await waitForText(page, /Uploaded\. \d+ × \d+/, 60_000)
  if (links) {
    await clickText(page, 'summary', 'Links')
    await sleep(200)
    await setValue(page, '.socials input', 0, links.website)
    await setValue(page, '.socials input', 1, links.x)
    await setValue(page, '.socials input', 2, links.telegram)
  }
  await sleep(300)
}

async function waitForText(page, re, ms) {
  const end = Date.now() + ms
  for (;;) {
    const t = await page.evaluate(() => document.body.innerText)
    if (re.test(t)) return true
    if (Date.now() > end) return false
    await sleep(250)
  }
}

/** A file that is not a picture but is named like one, for the page's refusal. */
function writeNotAPicture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-qa-')), 'not-a-picture.png')
  fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  return file
}

/**
 * What the chain says a Token-2022 coin's metadata address is: the `uri` of its TokenMetadata extension, read straight from the mint account over
 * JSON-RPC (what a wallet or explorer reads first). Layout: the 82-byte mint, zero padding up to 165, the account type byte, then TLV entries
 * (u16 type, u16 length, value); TokenMetadata is type 19: update authority (32), mint (32), then name, symbol and uri as u32-length strings.
 */
async function onchainUri(rpcUrl, mint) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'base64', commitment: 'confirmed' }] }) })
  const value = (await res.json()).result?.value
  if (!value) return null
  const data = Buffer.from(value.data[0], 'base64')
  for (let at = 166; at + 4 <= data.length;) {
    const type = data.readUInt16LE(at), len = data.readUInt16LE(at + 2)
    if (type === 19) return readStrings(data.subarray(at + 4, at + 4 + len)).uri
    at += 4 + len
  }
  return null
}

function readStrings(buf) {
  let at = 64 // update authority and mint
  const out = {}
  for (const key of ['name', 'symbol', 'uri']) {
    const n = buf.readUInt32LE(at)
    out[key] = buf.subarray(at + 4, at + 4 + n).toString('utf8')
    at += 4 + n
  }
  return out
}

module.exports = { sleep, CHROME, PICTURE, LINKS, newWallet, openPage, clickText, setValue, connect, fillLaunchForm, waitForText, writeNotAPicture, onchainUri }
