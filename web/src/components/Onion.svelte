<script lang="ts">
  // Onionskin: up to three coins' trade lines on one sheet. Time is one shared axis; each line is scaled to its own price range
  // (the legend prints every range), so the picture says "these moved together" without pretending the prices are comparable.
  // A stretch with no trades is a faint dotted segment, never a drawn price.
  import type { FeedTrade } from '../lib/types'
  import { theme } from '../lib/theme.svelte'

  export interface Skin { label: string; trades: FeedTrade[] | null }
  const { skins, w = 560, h = 150 }: { skins: Skin[]; w?: number; h?: number } = $props()
  const STYLES = [{ dash: [] as number[], width: 2.2 }, { dash: [9, 4], width: 1.8 }, { dash: [2, 4], width: 2.2 }]
  const GAP_SHARE = 0.3
  const GAP_MIN_MS = 15 * 60_000
  let canvas = $state<HTMLCanvasElement | null>(null)
  let probes = $state<HTMLElement[]>([])

  const price = (t: FeedTrade) => (Number(t.amountToken) > 0 ? Number(t.amountZec) / Number(t.amountToken) : 0)
  const lines = $derived(skins.map((s) => ({ label: s.label, pts: (s.trades ?? []).map((t) => ({ at: Date.parse(t.at), p: price(t) })).filter((p) => p.p > 0) })))
  const drawn = $derived(lines.filter((l) => l.pts.length >= 2))
  const ranges = $derived(lines.map((l) => (l.pts.length >= 2 ? { lo: Math.min(...l.pts.map((p) => p.p)), hi: Math.max(...l.pts.map((p) => p.p)) } : null)))
  const fmt = (v: number) => (v * 1e6).toPrecision(4)
  const spread = (lo: number, hi: number) => (lo > 0 ? `${(((hi - lo) / lo) * 100).toFixed(2)}% wide` : '')

  $effect(() => {
    void theme.effective
    void lines
    const el = canvas
    if (!el || drawn.length === 0) return
    const inks = probes.map((p) => getComputedStyle(p).color)
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    el.width = w * dpr; el.height = h * dpr
    const x = el.getContext('2d')
    if (!x) return
    x.scale(dpr, dpr); x.clearRect(0, 0, w, h)
    const all = drawn.flatMap((l) => l.pts.map((p) => p.at))
    const t0 = Math.min(...all), t1 = Math.max(...all)
    const span = Math.max(1, t1 - t0)
    const gapAt = Math.max(span * GAP_SHARE, GAP_MIN_MS)
    const pad = 6
    const X = (at: number) => pad + ((at - t0) / span) * (w - pad * 2)
    // a quiet frame: the shared time axis start and end
    x.strokeStyle = inks[2]; x.globalAlpha = 0.5; x.lineWidth = 1; x.setLineDash([1, 3])
    x.beginPath(); x.moveTo(pad, h - 1); x.lineTo(w - pad, h - 1); x.stroke(); x.globalAlpha = 1
    lines.forEach((l, k) => {
      if (l.pts.length < 2) return
      const r = ranges[k]!
      const Y = (p: number) => (r.hi === r.lo ? h / 2 : pad + (1 - (p - r.lo) / (r.hi - r.lo)) * (h - pad * 2 - 4))
      x.lineCap = 'round'; x.lineJoin = 'round'
      for (let i = 1; i < l.pts.length; i++) {
        const a = l.pts[i - 1], b = l.pts[i]
        const gap = b.at - a.at > gapAt
        x.beginPath(); x.moveTo(X(a.at), Y(a.p)); x.lineTo(X(b.at), Y(b.p))
        x.strokeStyle = inks[k] ?? inks[0]
        x.lineWidth = gap ? 1 : STYLES[k % 3].width
        x.globalAlpha = gap ? 0.5 : 1
        x.setLineDash(gap ? [1, 4] : STYLES[k % 3].dash)
        x.stroke()
      }
      x.globalAlpha = 1; x.setLineDash([])
      const last = l.pts[l.pts.length - 1]
      x.beginPath(); x.arc(X(last.at), Y(last.p), 2.6, 0, Math.PI * 2); x.fillStyle = inks[k] ?? inks[0]; x.fill()
    })
  })
</script>

<div class="onion">
  <span class="probe p0" bind:this={probes[0]} aria-hidden="true"></span><span class="probe p1" bind:this={probes[1]} aria-hidden="true"></span><span class="probe p2" bind:this={probes[2]} aria-hidden="true"></span>
  {#if drawn.length > 0}
    <canvas bind:this={canvas} style:width="{w}px" style:height="{h}px" aria-label="The pinned coins' recent trades on one time axis, each scaled to its own price range"></canvas>
  {:else}
    <p class="muted">Too few trades on any pinned coin for a line.</p>
  {/if}
  <ul class="key" aria-label="Which line is which">
    {#each lines as l, k (k)}
      <li>
        <svg width="34" height="8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="currentColor" stroke-width={STYLES[k % 3].width} stroke-dasharray={STYLES[k % 3].dash.join(' ')} stroke-linecap="round" class="sw{k}" /></svg>
        <span class="mono">{l.label}</span>
        <span class="muted rng">{ranges[k] ? `${fmt(ranges[k]!.lo)} to ${fmt(ranges[k]!.hi)} ZEC / 1M, ${spread(ranges[k]!.lo, ranges[k]!.hi)}` : 'too few trades'}</span>
      </li>
    {/each}
  </ul>
  <p class="muted onote">Time is shared. Each line is scaled to its own price range, so overlap means the coins moved together, not that they cost the same. Dotted stretches are time with no trades.</p>
</div>

<style>
  .onion { display: grid; gap: var(--s-3); }
  canvas { display: block; max-width: 100%; border-bottom: 1px solid var(--line); }
  .probe { position: absolute; width: 0; height: 0; overflow: hidden; }
  .p0 { color: var(--ink); } .p1 { color: var(--ink-2); } .p2 { color: var(--ink-3); }
  .key { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-2); font-size: var(--t-12); }
  .key li { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
  .sw0 { color: var(--ink); } .sw1 { color: var(--ink-2); } .sw2 { color: var(--ink-3); }
  .rng { font-variant-numeric: tabular-nums; }
  .onote { font-size: var(--t-12); max-width: 64ch; }
</style>
