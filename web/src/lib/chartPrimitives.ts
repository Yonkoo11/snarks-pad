// Two things the chart library does not draw by itself, as series primitives: a dashed vertical line with a short label (a payout
// round that paid this coin) and a hairline that follows the tape (the trade under the pointer in the tape rail).
import type { ISeriesPrimitive, SeriesAttachedParameter, Time, IChartApi, UTCTimestamp } from 'lightweight-charts'

export interface VLine { time: number; label: string }
export interface VColors { line: string; text: string }

export class VerticalLines implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private request: (() => void) | null = null
  lines: VLine[] = []
  colors: VColors = { line: '#888', text: '#666' }
  attached(p: SeriesAttachedParameter<Time>): void { this.chart = p.chart as IChartApi; this.request = p.requestUpdate }
  detached(): void { this.chart = null; this.request = null }
  set(lines: VLine[], colors: VColors): void { this.lines = lines; this.colors = colors; this.request?.() }
  updateAllViews(): void {}
  paneViews() {
    const self = this
    return [{
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw(target: { useBitmapCoordinateSpace: (cb: (s: { context: CanvasRenderingContext2D; bitmapSize: { height: number }; horizontalPixelRatio: number; verticalPixelRatio: number }) => void) => void }) {
          const chart = self.chart
          if (!chart) return
          const ts = chart.timeScale()
          target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hp, verticalPixelRatio: vp }) => {
            ctx.save()
            ctx.strokeStyle = self.colors.line
            ctx.fillStyle = self.colors.text
            ctx.lineWidth = Math.max(1, Math.round(hp))
            ctx.setLineDash([4 * hp, 4 * hp])
            ctx.font = `${11 * vp}px ui-monospace, monospace`
            for (const l of self.lines) {
              const x = ts.timeToCoordinate(l.time as UTCTimestamp)
              if (x === null) continue
              const px = Math.round(x * hp)
              ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, bitmapSize.height); ctx.stroke()
              ctx.setLineDash([])
              ctx.fillText(l.label, px + 4 * hp, 14 * vp)
              ctx.setLineDash([4 * hp, 4 * hp])
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
}
