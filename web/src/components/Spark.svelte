<script lang="ts">
  // The row's trade line: the last trades as one crayon stroke, price on y, time on x, a filled
  // dot on the last trade. A stretch with no trades is never interpolated as if trading happened:
  // it renders as a dashed hairline. Drawn in a canvas at device pixels; the trades prop is
  // oldest first (lib/desk.ts sorts).
  import type { FeedTrade } from '../lib/types'
  import { theme } from '../lib/theme.svelte'
  import { ago } from '../lib/format'

  const { trades, w = 76, h = 22 }: { trades: FeedTrade[]; w?: number; h?: number } = $props()

  let canvas = $state<HTMLCanvasElement | null>(null)

  // a gap longer than this slice of the whole span (and at least 15 minutes) is a no-trade stretch
  const GAP_SHARE = 0.3
  const GAP_MIN_MS = 15 * 60_000

  const priceOf = (t: FeedTrade): number => {
    const tok = Number(t.amountToken)
    return tok > 0 ? Number(t.amountZec) / tok : 0
  }

  const label = $derived.by(() => {
    if (trades.length < 2) return 'Too few trades for a line'
    const span = ago(trades[0].at).replace(' ago', '')
    return `Last ${trades.length} trades, covering ${span}`
  })

  function draw(el: HTMLCanvasElement, ink: string, faint: string) {
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    el.width = w * dpr
    el.height = h * dpr
    const x = el.getContext('2d')
    if (!x) return
    x.scale(dpr, dpr)
    x.clearRect(0, 0, w, h)
    const pts = trades.map((t) => ({ at: Date.parse(t.at), p: priceOf(t) })).filter((p) => p.p > 0)
    if (pts.length < 2) return
    const t0 = pts[0].at, t1 = pts[pts.length - 1].at
    const span = Math.max(1, t1 - t0)
    let lo = Infinity, hi = -Infinity
    for (const p of pts) { if (p.p < lo) lo = p.p; if (p.p > hi) hi = p.p }
    const pad = 2.5
    const X = (at: number) => pad + ((at - t0) / span) * (w - pad * 2 - 3)
    const Y = (p: number) => (hi === lo ? h / 2 : pad + (1 - (p - lo) / (hi - lo)) * (h - pad * 2))
    const gapAt = Math.max(span * GAP_SHARE, GAP_MIN_MS)

    x.lineCap = 'round'
    x.lineJoin = 'round'
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]
      const gap = b.at - a.at > gapAt
      x.beginPath()
      x.moveTo(X(a.at), Y(a.p))
      x.lineTo(X(b.at), Y(b.p))
      x.strokeStyle = gap ? faint : ink
      x.lineWidth = gap ? 1 : 1.5
      x.setLineDash(gap ? [2, 3] : [])
      x.stroke()
    }
    x.setLineDash([])
    const last = pts[pts.length - 1]
    x.beginPath()
    x.arc(X(last.at), Y(last.p), 2.2, 0, Math.PI * 2)
    x.fillStyle = ink
    x.fill()
  }

  $effect(() => {
    void theme.effective // redraw when the theme flips: the stroke is the page's ink
    void trades
    const el = canvas
    if (!el) return
    const cs = getComputedStyle(el)
    draw(el, cs.color, cs.getPropertyValue('--ink-3').trim() || cs.color)
  })
</script>

{#if trades.length >= 2}
  <canvas bind:this={canvas} style:width="{w}px" style:height="{h}px" aria-label={label}></canvas>
{:else}
  <span class="few label" aria-label="Too few trades for a line">&ndash;</span>
{/if}

<style>
  canvas { display: block; color: var(--ink-2); }
  .few { color: var(--ink-3); }
</style>
