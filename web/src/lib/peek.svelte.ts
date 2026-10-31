// The peek: a small card that follows a pointer resting on a ledger row (or a finger held on it). It is not a layer: it never
// touches history, takes no focus and closes the moment the pointer leaves. The card reads only what the row already reads.
import type { Coin } from './types'

class Peek {
  coin = $state<Coin | null>(null)
  x = $state(0)
  top = $state(0)
  bottom = $state(0)
  touch = $state(false)
  private timer: ReturnType<typeof setTimeout> | null = null

  /** A pointer resting on a row: the card opens after a short rest, so sweeping across rows does not flash cards. */
  hover(coin: Coin, x: number, rect: DOMRect): void {
    this.cancel()
    this.timer = setTimeout(() => this.show(coin, x, rect, false), 380)
  }
  show(coin: Coin, x: number, rect: DOMRect, touch: boolean): void {
    this.cancel()
    this.coin = coin; this.x = x; this.top = rect.top; this.bottom = rect.bottom; this.touch = touch
  }
  hide(): void {
    this.cancel()
    this.coin = null; this.touch = false
  }
  private cancel(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }
}
export const peek = new Peek()
