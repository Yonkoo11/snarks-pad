// The link between the tape and the chart: the trade under the pointer in the tape (a time) and the time under the chart's crosshair.
// Either side reads the other; neither writes anything the user did not point at.
class Hilite {
  /** seconds: a tape trade the pointer rests on */
  tradeAt = $state<number | null>(null)
  tradeMint = $state<string | null>(null)
  /** seconds: the time under the chart crosshair */
  chartAt = $state<number | null>(null)
  chartMint = $state<string | null>(null)
  /** the chart's candle width in seconds, so a list can say which of its rows fall in the candle under the crosshair */
  chartSec = $state(900)
}
export const hilite = new Hilite()
