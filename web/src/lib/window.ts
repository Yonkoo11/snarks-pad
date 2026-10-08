// The launch window in seconds and in words docs/API.md v2.8. Every coin's config carries the Meteora fee scheduler: a trade in the pool's first second pays
// `cliffBps` (99%) and the fee falls in equal steps to the coin's own fee, which it keeps for good. This file turns the engine's numbers into the countdown the coin page
// shows and the sentences the Launch page, the coin page and How it works print. Nothing here reads a clock, the network or the page: a number comes from the engine's
// answer, and a test runs every function as it is.
//
// The countdown is NEVER `endsAt` against the visitor's own clock (which can be wrong by minutes). It counts down from `windowSecondsLeft`, which the engine worked out
// from the chain's clock, against the page's own monotonic clock from the moment that answer arrived, and the page treats the window as closed only when the engine says so.

/** The parts of a window the words need. A coin's, a tier's and a fixed fact's windows all carry them (lib/types.ts). */
export interface WindowFacts {
  cliffBps: number
  endBps: number
  periods: number
  periodSeconds: number
}

/** The engine's answer about the time left, and when on the page's monotonic clock it arrived. */
export interface WindowSnapshot {
  secondsLeft: number
  receivedAtMs: number
}

/** A clock that only moves forward (never set back by a wrong or changed system time): `performance.now()`, with `Date.now()` where a page has none. */
export const monoNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Basis points as the copy says them: 9900 is "99%", 7940 is "79.4%", 100 is "1%". A fee is printed exactly, so a second decimal appears only when the number needs
 * it (25 bps is "0.25%"); the reviewed tiers' steps never do.
 */
export function bpsText(bps: number): string {
  return `${(Math.round(bps) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
}

/** How long the window lasts, in seconds: its steps times the length of one. */
export const durationOf = (w: WindowFacts): number => w.periods * w.periodSeconds

/**
 * What a trade pays in each period of the window, in bps: `periods + 1` numbers, the first the cliff and the last the fee after the window. Linear steps, the same
 * arithmetic the program runs (cliff - k x reduction); null unless the drop divides by the number of steps, which is what makes the window end exactly on the coin's fee.
 */
export function stepsOf(w: WindowFacts): number[] | null {
  const drop = w.cliffBps - w.endBps
  if (!Number.isInteger(w.periods) || w.periods < 1 || !Number.isFinite(drop) || drop <= 0 || drop % w.periods !== 0) return null
  const step = drop / w.periods
  return Array.from({ length: w.periods + 1 }, (_, k) => w.cliffBps - k * step)
}

/**
 * Whole seconds the countdown shows. The engine's `secondsLeft` is an upper bound of what remains (it comes from the chain's clock, which only lags the clock a
 * transaction lands under), and the page subtracts only the full seconds that have passed since the answer arrived. While the engine's last answer says time is left the
 * countdown never shows less than 1: the page opens Buy when the engine says the window is closed, not when a local count runs out. A clock that went backwards counts as none passed.
 */
export function secondsLeft(s: WindowSnapshot, nowMs: number): number {
  if (!(s.secondsLeft > 0)) return 0
  const elapsed = Math.max(0, Math.floor((nowMs - s.receivedAtMs) / 1000))
  return Math.max(1, Math.ceil(s.secondsLeft) - elapsed)
}

/** The two numbers of the line beside the trade box, apart so each can be set in mono. An unknown fee is the en dash, never a number made up. */
export function windowLineParts(n: number, feeNowBps: number | null | undefined): { left: string; fee: string } {
  return { left: `${n} s`, fee: feeNowBps == null ? '–' : bpsText(feeNowBps) }
}

/** The words beside the trade box while a window is open: "Launch window: 3 s left, fee now 59.8%". */
export function windowLine(n: number, feeNowBps: number | null | undefined): string {
  const p = windowLineParts(n, feeNowBps)
  return `Launch window: ${p.left} left, fee now ${p.fee}`
}

/** The label of the trade button while a window is open. */
export const waitLabel = (n: number): string => `Wait ${n} s`

/** A window's numbers, in parts so each can be set in mono: the Launch preview prints cliff, end and fromSecond. */
export interface WindowParts {
  cliff: string
  end: string
  fromSecond: number
}

export function windowParts(w: WindowFacts): WindowParts {
  return { cliff: bpsText(w.cliffBps), end: bpsText(w.endBps), fromSecond: durationOf(w) }
}

/** The Launch preview's value as one sentence (what a screen reader reads, and what the tests compare): "99% at launch, 1% from second 5". */
export function windowValue(w: WindowFacts): string {
  const p = windowParts(w)
  return `${p.cliff} at launch, ${p.end} from second ${p.fromSecond}`
}

/**
 * The fact on the coin page's Token info tab, from the engine's `launchWindow` fixed fact. Short (research/COPY-AUDIT.md, 2026-10-07): the window, its
 * top fee and why; the creator's own first buy, the one exception, is said whenever the config has it. The per-second steps are on How it works.
 */
export function fixedWindowText(w: WindowFacts & { firstSwapAtEndFee?: boolean }): string {
  const own = w.firstSwapAtEndFee ? " The creator's own first buy, inside the launch transaction, pays the coin's fee and not the launch window's." : ''
  return `The first ${durationOf(w)} seconds cost more (${bpsText(w.cliffBps)} at first), so bots cannot buy up the launch. It cannot change.${own}`
}

/**
 * The 1% tier's window as How it works prints it. How it works is static prose like its neighbours, so this is the one place its numbers live;
 * engine/test/copy.test.ts asserts it equals the engine's reviewed window for that tier, so the page cannot drift from the config.
 */
export const HOW_EXAMPLE: WindowFacts = { cliffBps: 9900, endBps: 100, periods: 5, periodSeconds: 1 }

/** "99%, 79.4%, 59.8%, 40.2%, 20.6%, then 1% from second 5": the example's fee in each period, then the fee that stays. */
export function exampleSteps(w: WindowFacts): string {
  const steps = stepsOf(w)
  if (!steps) return `${bpsText(w.cliffBps)}, then ${bpsText(w.endBps)} from second ${durationOf(w)}`
  return `${steps.slice(0, -1).map(bpsText).join(', ')}, then ${bpsText(w.endBps)} from second ${durationOf(w)}`
}
