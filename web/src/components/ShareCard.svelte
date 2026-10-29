<script lang="ts">
  import type { CoinDetail } from '../lib/types'
  import { zec } from '../lib/format'

  // The share card: the coin as a drawn, pad-styled picture (1200 x 675, the X crop), made in the
  // browser from what the page already knows. It says what only this pad can say: what the coin has
  // already paid its holders. The X intent cannot attach a picture, so the card saves to a file and
  // the copy says to attach it. A coin image the canvas cannot export (a cross-origin file without
  // CORS) falls back to the letter tile rather than failing the save.
  let { coin }: { coin: CoinDetail } = $props()

  const W = 1200, H = 675
  let canvas = $state<HTMLCanvasElement | null>(null)
  let saved = $state(false)
  let drawn = $state(false)
  let noImage = $state(false) // set when the coin's image taints the canvas: the tile always exports

  const tradePct = $derived(String(Math.round(coin.feeBps * coin.holderShareBps / 10_000) / 100))
  const paidZats = $derived(BigInt(coin.rewards.paidSolanaZec) + BigInt(coin.rewards.paidShieldedZec))

  // the pad's paper palette, light side: the card is a physical object and keeps one look in both themes
  const PAPER = '#f5efe2', PAPER2 = '#fbf7ee', INK = '#2b2420', INK2 = '#5e544c', PINK = '#c42f6c', TAPE = 'rgba(232, 221, 192, .85)'
  const TILE = ['#cbaee0', '#b5d9a4', '#a9bfe3', '#e3a9c6', '#e0c9a0']

  function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    c.beginPath()
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r)
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath()
  }
  function hatchStrip(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.save()
    roundRect(c, x, y, w, h, 3); c.clip()
    c.fillStyle = 'rgba(196, 47, 108, .12)'; c.fillRect(x, y, w, h)
    c.strokeStyle = PINK; c.lineWidth = 3
    for (let i = -h; i < w + h; i += 7) {
      c.beginPath(); c.moveTo(x + i, y + h + 2); c.lineTo(x + i + h + 4, y - 2); c.stroke()
    }
    c.restore()
  }
  function wrap(c: CanvasRenderingContext2D, text: string, max: number): string[] {
    const words = text.split(/\s+/)
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const t = line ? `${line} ${w}` : w
      if (c.measureText(t).width > max && line) { lines.push(line); line = w } else line = t
      if (lines.length === 2) break
    }
    if (line && lines.length < 2) lines.push(line)
    return lines
  }
  function tile(c: CanvasRenderingContext2D, x: number, y: number, s: number) {
    const bg = TILE[(coin.symbol.charCodeAt(0) + coin.symbol.length) % TILE.length]
    c.fillStyle = bg; c.fillRect(x, y, s, s)
    c.fillStyle = INK; c.font = `700 ${Math.round(s * .45)}px Gaegu, sans-serif`
    c.textAlign = 'center'; c.textBaseline = 'middle'
    c.fillText(coin.symbol.slice(0, 1).toUpperCase(), x + s / 2, y + s / 2 + s * .04)
    c.textAlign = 'left'; c.textBaseline = 'alphabetic'
  }
  function drawImage(c: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, s: number) {
    c.save()
    c.translate(x + s / 2, y + s / 2); c.rotate(-0.028)
    // the hard pixel shadow, then the picture, then two tape strips
    c.fillStyle = 'rgba(43, 36, 32, .18)'; c.fillRect(-s / 2 + 10, -s / 2 + 12, s, s)
    c.fillStyle = PAPER2; c.fillRect(-s / 2 - 14, -s / 2 - 14, s + 28, s + 28)
    if (img) { try { c.drawImage(img, -s / 2, -s / 2, s, s) } catch { tile(c, -s / 2, -s / 2, s) } }
    else tile(c, -s / 2, -s / 2, s)
    c.fillStyle = TAPE
    c.save(); c.translate(-s / 2 + 10, -s / 2 - 8); c.rotate(-0.35); c.fillRect(-45, -16, 110, 34); c.restore()
    c.save(); c.translate(s / 2 - 10, -s / 2 - 8); c.rotate(0.3); c.fillRect(-55, -16, 110, 34); c.restore()
    c.restore()
  }

  async function draw() {
    if (!canvas) return
    const c = canvas.getContext('2d')
    if (!c) return
    try { await document.fonts.load('700 76px Gaegu'); await document.fonts.load('400 34px "Atkinson Hyperlegible"'); await document.fonts.load('500 40px "JetBrains Mono"') } catch { /* fallback faces still draw */ }

    c.clearRect(0, 0, W, H)
    c.fillStyle = PAPER; c.fillRect(0, 0, W, H)

    // the coin's picture, a print taped to the door
    let img: HTMLImageElement | null = null
    if (coin.imageUrl && !noImage) {
      img = await new Promise<HTMLImageElement | null>((res) => {
        const i = new Image()
        i.crossOrigin = 'anonymous'
        i.onload = () => res(i); i.onerror = () => res(null)
        i.src = coin.imageUrl!
      })
    }
    drawImage(c, img, 100, 170, 330)

    // the right column: name, ticker, the one claim in pink, the proof line in ink. Every line is
    // measured and wrapped inside the column; the cursor moves so nothing can sit on anything else.
    const L = 520
    const colW = W - L - 80
    let y = 200
    c.fillStyle = INK
    c.font = '700 72px Gaegu, sans-serif'
    for (const l of wrap(c, coin.name, colW)) { c.fillText(l, L, y); y += 78 }
    c.font = '500 38px "JetBrains Mono", monospace'
    c.fillStyle = INK2
    c.fillText(`$${coin.symbol}`, L, y)
    y += 70

    c.fillStyle = PINK
    c.font = '700 36px "Atkinson Hyperlegible", sans-serif'
    for (const l of wrap(c, `Pays holders ${tradePct}% of every trade, in ZEC.`, colW)) { c.fillText(l, L, y); y += 46 }
    y += 12
    c.fillStyle = INK
    c.font = '400 30px "Atkinson Hyperlegible", sans-serif'
    const proof = paidZats > 0n
      ? `Paid its holders ${zec(paidZats)} ZEC over ${coin.rewards.epochs} ${coin.rewards.epochs === 1 ? 'round' : 'rounds'} so far.`
      : 'Holders are paid from its fees every round.'
    for (const l of wrap(c, proof, colW)) { c.fillText(l, L, y); y += 40 }

    // the footer: the pad's name, the hatch exactly under it (the shielded mark), the caption beside
    c.font = '700 54px Gaegu, sans-serif'
    c.fillStyle = INK
    const siteW = c.measureText('snarks.fun').width
    c.fillText('snarks.fun', 100, H - 72)
    hatchStrip(c, 100, H - 56, siteW, 10)
    c.font = '400 24px "Atkinson Hyperlegible", sans-serif'
    c.fillStyle = INK2
    c.fillText('shielded payouts if you opt in · proof on the Payouts page', 100 + siteW + 40, H - 76)
    drawn = true
  }
  $effect(() => { coin.mint; draw() })

  async function save() {
    if (!canvas) return
    const grab = (): string | null => { try { return canvas!.toDataURL('image/png') } catch { return null } }
    let url = grab()
    if (url === null && !noImage) {
      // a tainted canvas (coin image served without CORS): redraw with the tile, which always exports
      noImage = true
      await draw()
      url = grab()
    }
    if (url === null) return
    const a = document.createElement('a')
    a.href = url
    a.download = `${coin.symbol.toLowerCase()}-snarks-card.png`
    a.click()
    saved = true
    setTimeout(() => (saved = false), 2500)
  }
</script>

<div class="sc">
  <canvas bind:this={canvas} width={W} height={H} aria-label="A share card for {coin.name}: pays holders {tradePct}% of every trade in ZEC"></canvas>
  <button class="btn" type="button" onclick={save} disabled={!drawn}>{saved ? 'Saved' : 'Save the card'}</button>
</div>

<style>
  .sc { display: grid; gap: var(--s-2); }
  canvas {
    width: 100%; height: auto; border-radius: var(--r-sm);
    box-shadow: var(--sh-1);
  }
</style>
