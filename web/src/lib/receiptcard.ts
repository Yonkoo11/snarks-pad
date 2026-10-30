// The tear-off: any payout of yours becomes a paper receipt you can keep or post - drawn in a
// canvas, perforation and all, from the payout's own numbers. Everything printed on it is
// verifiable: the round, the amount, the batch signature.
import type { SolanaPayout } from './types'
import { zec, short } from './format'

const PAPER = '#fbf7ee', INK = '#2b2420', INK2 = '#5e544c', LINE = 'rgba(43,36,32,.18)'

export async function tearReceipt(p: SolanaPayout, roundLabel: string, coins: string[], wallet: string): Promise<void> {
  const W = 1000, H = 460
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const x = c.getContext('2d')
  if (!x) return
  try { await document.fonts.load('700 44px Gaegu'); await document.fonts.load('500 56px "JetBrains Mono"'); await document.fonts.load('400 24px "Atkinson Hyperlegible"') } catch { /* fallback faces still draw */ }

  // the slip with a torn top edge
  x.fillStyle = '#efe6d2'
  x.fillRect(0, 0, W, H)
  x.fillStyle = PAPER
  x.beginPath()
  x.moveTo(20, 46)
  for (let px = 20; px <= W - 20; px += 24) x.lineTo(px + 12, px % 48 === 20 ? 34 : 42)
  x.lineTo(W - 20, 46); x.lineTo(W - 20, H - 24); x.lineTo(20, H - 24)
  x.closePath(); x.fill()
  x.strokeStyle = LINE; x.lineWidth = 2; x.stroke()
  // perforation dots along the tear
  x.fillStyle = LINE
  for (let px = 40; px < W - 40; px += 26) { x.beginPath(); x.arc(px, 52, 2.2, 0, Math.PI * 2); x.fill() }

  x.fillStyle = INK
  x.font = '700 44px Gaegu, sans-serif'
  x.fillText('SNARKS pad · payout receipt', 56, 118)
  x.font = '400 24px "Atkinson Hyperlegible", sans-serif'
  x.fillStyle = INK2
  x.fillText(`Round ${roundLabel} · ${new Date(p.at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`, 56, 158)

  x.fillStyle = INK
  x.font = '500 64px "JetBrains Mono", monospace'
  x.fillText(`${zec(p.zats, 6)} ZEC`, 56, 248)
  x.font = '400 24px "Atkinson Hyperlegible", sans-serif'
  x.fillStyle = INK2
  x.fillText(`paid to ${short(wallet, 6, 6)}${coins.length ? ` for ${coins.join(', ')}` : ''}`, 56, 290)
  x.font = '400 22px "Atkinson Hyperlegible", sans-serif'
  x.fillText('Batch transaction, the same for every wallet paid in it:', 56, 348)
  x.font = '500 26px "JetBrains Mono", monospace'
  x.fillStyle = INK
  x.fillText(short(p.sig, 14, 14), 56, 382)
  x.font = '400 20px "Atkinson Hyperlegible", sans-serif'
  x.fillStyle = INK2
  x.fillText('verify every round at snarks.fun/#/payouts', 56, 420)

  const a = document.createElement('a')
  a.href = c.toDataURL('image/png')
  a.download = `snarks-receipt-${roundLabel.replace('#', 'round-')}.png`
  a.click()
}
