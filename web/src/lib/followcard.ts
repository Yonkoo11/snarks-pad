// The card Snarks makes of a coin it follows: what moved since the moment it was followed, as paper you can keep or post. Every line is a number the pad
// held then and holds now (holders, what the coin has paid its holders, the newest round and its holder file's hash, which anyone can re-check); there is no
// price on it, no advice and no claim. Drawn in a canvas in the same hand as the payout receipt.
import type { Looked } from './looked'
import { zec } from './format'

export interface CardModel {
  symbol: string
  since: string // an ISO date: when the coin was followed
  rows: { label: string; value: string }[]
  round: { n: number; hash: string | null } | null
  network: string | null // "Test network" off mainnet, so a card from a test setup says so on its face
}

const fmtInt = (n: number) => n.toLocaleString('en-US')
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmtInt(n)}`

/** What goes on the card, from the follow snapshot and a current read. Rows appear only when both readings exist. Pure. */
export function cardModel(symbol: string, base: Looked, now: { holders: number | null; paidZats: string }, round: { n: number; sha256: string | null } | null, network: string | null): CardModel {
  const rows: { label: string; value: string }[] = []
  if (base.holders !== null && now.holders !== null) rows.push({ label: 'Holders', value: `${fmtInt(base.holders)} to ${fmtInt(now.holders)} (${signed(now.holders - base.holders)})` })
  try {
    const a = BigInt(base.paidZats || '0'), b = BigInt(now.paidZats || '0')
    rows.push({ label: 'Paid to its holders', value: `${zec(a, 4)} to ${zec(b, 4)} ZEC (${b - a >= 0n ? '+' : ''}${zec(b - a, 4)})` })
  } catch { /* a count that is not a number is left off, not guessed */ }
  return { symbol, since: new Date(base.at).toISOString(), rows, round: round ? { n: round.n, hash: round.sha256 } : null, network }
}

const PAPER = '#fbf7ee', INK = '#2b2420', INK2 = '#5e544c', LINE = 'rgba(43,36,32,.18)'

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src })
}

export async function renderFollowCard(m: CardModel): Promise<HTMLCanvasElement | null> {
  const W = 1200, H = 630
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const x = c.getContext('2d')
  if (!x) return null
  try { await document.fonts.load('700 56px Gaegu'); await document.fonts.load('500 40px "JetBrains Mono"'); await document.fonts.load('400 26px "Atkinson Hyperlegible"') } catch { /* fallback faces still draw */ }
  x.fillStyle = '#efe6d2'; x.fillRect(0, 0, W, H)
  x.fillStyle = PAPER
  x.beginPath(); x.moveTo(24, 56)
  for (let px = 24; px <= W - 24; px += 28) x.lineTo(px + 14, px % 56 === 24 ? 42 : 52)
  x.lineTo(W - 24, 56); x.lineTo(W - 24, H - 28); x.lineTo(24, H - 28); x.closePath(); x.fill()
  x.strokeStyle = LINE; x.lineWidth = 2; x.stroke()
  x.fillStyle = LINE
  for (let px = 48; px < W - 48; px += 30) { x.beginPath(); x.arc(px, 64, 2.4, 0, Math.PI * 2); x.fill() }

  x.fillStyle = INK; x.font = '700 58px Gaegu, sans-serif'
  x.fillText(`Snarks followed $${m.symbol}`, 72, 150)
  x.fillStyle = INK2; x.font = '400 26px "Atkinson Hyperlegible", sans-serif'
  x.fillText(`since ${new Date(m.since).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}${m.network ? `  ·  ${m.network}` : ''}`, 72, 192)

  let y = 276
  for (const r of m.rows) {
    x.fillStyle = INK2; x.font = '400 24px "Atkinson Hyperlegible", sans-serif'; x.fillText(r.label.toUpperCase(), 72, y)
    x.fillStyle = INK; x.font = '500 40px "JetBrains Mono", monospace'; x.fillText(r.value, 72, y + 46)
    y += 108
  }
  if (m.round) {
    x.fillStyle = INK2; x.font = '400 22px "Atkinson Hyperlegible", sans-serif'
    x.fillText(`Newest round: ${m.round.n}${m.round.hash ? `, holder file ${m.round.hash.slice(0, 10)}…${m.round.hash.slice(-6)}` : ''}`, 72, H - 96)
  }
  x.font = '400 22px "Atkinson Hyperlegible", sans-serif'; x.fillStyle = INK2
  x.fillText('Check any round yourself at snarks.fun/#/payouts', 72, H - 62)

  const art = await loadImage('/mascot-cut.webp')
  if (art) { const h = 380, w = Math.round((h * 260) / 373); x.drawImage(art, W - w - 80, H - h - 52, w, h) }
  return c
}

/** Draws the card and gives it to the visitor: onto the clipboard as an image when the browser allows it, else as a file. Returns what happened. */
export async function saveFollowCard(m: CardModel): Promise<'copied' | 'saved' | 'failed'> {
  const c = await renderFollowCard(m)
  if (!c) return 'failed'
  const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/png'))
  if (!blob) return 'failed'
  try {
    if ('ClipboardItem' in window && navigator.clipboard?.write) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); return 'copied' }
  } catch { /* fall through to a file */ }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `snarks-followed-${m.symbol.toLowerCase()}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  return 'saved'
}
