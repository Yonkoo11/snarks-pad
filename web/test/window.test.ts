// The launch window in seconds and words (src/lib/window.ts, contract v2.8): the countdown the coin page runs, and every sentence the Launch page, the coin page and How it works
// print about it. Every number below is worked by hand from the reviewed window (99%, 5 steps of 1 second, down to the tier's fee); engine/test/copy.test.ts checks the same
// numbers against the engine's own reviewed table, so a page cannot drift from the config.
import { describe, expect, test } from 'bun:test'
import { HOW_EXAMPLE, bpsText, durationOf, exampleSteps, fixedWindowText, secondsLeft, stepsOf, waitLabel, windowLine, windowLineParts, windowParts, windowValue } from '../src/lib/window'

const tier = (endBps: number) => ({ cliffBps: 9900, endBps, periods: 5, periodSeconds: 1 })

describe('basis points as copy', () => {
  test('whole and one-decimal percents, no trailing zero', () => {
    expect([9900, 7940, 5980, 4020, 2060, 100, 1000, 10_000].map(bpsText)).toEqual(['99%', '79.4%', '59.8%', '40.2%', '20.6%', '1%', '10%', '100%'])
  })
  test('a fee that needs two decimals is printed exactly, never rounded to look like another fee', () => {
    expect(bpsText(25)).toBe('0.25%')
    expect(bpsText(125)).toBe('1.25%')
  })
})

describe('what a trade pays in each period', () => {
  test('the 1% tier: 99, 79.4, 59.8, 40.2, 20.6, then 1', () => {
    expect(stepsOf(tier(100))).toEqual([9900, 7940, 5980, 4020, 2060, 100])
  })
  test('every reviewed tier steps by (9900 - fee) / 5 and ends on its fee', () => {
    const reduction: Record<number, number> = { 100: 1960, 200: 1940, 400: 1900, 600: 1860, 1000: 1780 }
    for (const bps of [100, 200, 400, 600, 1000]) {
      const steps = stepsOf(tier(bps))!
      expect(steps.length).toBe(6)
      expect(steps[0]).toBe(9900)
      expect(steps[5]).toBe(bps)
      steps.slice(1).forEach((v, i) => expect(steps[i]! - v).toBe(reduction[bps]!))
    }
  })
  test('a window that does not divide evenly has no steps to list', () => {
    expect(stepsOf({ cliffBps: 9900, endBps: 101, periods: 5, periodSeconds: 1 })).toBeNull()
    expect(stepsOf({ cliffBps: 9900, endBps: 100, periods: 0, periodSeconds: 1 })).toBeNull()
    expect(stepsOf({ cliffBps: 100, endBps: 9900, periods: 5, periodSeconds: 1 })).toBeNull()
    expect(stepsOf({ cliffBps: 9900, endBps: 100, periods: 2.5, periodSeconds: 1 })).toBeNull()
  })
  test('the window lasts its steps times a step: 5 seconds', () => {
    expect(durationOf(tier(100))).toBe(5)
    expect(durationOf({ cliffBps: 9900, endBps: 100, periods: 5, periodSeconds: 2 })).toBe(10)
  })
})

describe('the countdown', () => {
  const snap = (left: number, at = 1_000) => ({ secondsLeft: left, receivedAtMs: at })

  test('it starts at the engine\'s number and loses one second for every full second since the answer arrived', () => {
    expect([0, 400, 999, 1000, 1999, 2000, 2500, 3000].map((ms) => secondsLeft(snap(5), 1_000 + ms))).toEqual([5, 5, 5, 4, 4, 3, 3, 2])
  })
  test('the engine saying the window is closed is closed, whatever the page\'s own count says', () => {
    expect(secondsLeft(snap(0), 1_000)).toBe(0)
    expect(secondsLeft(snap(0), 99_999)).toBe(0)
    expect(secondsLeft(snap(-1), 1_000)).toBe(0)
  })
  test('while the engine\'s last answer says time is left the count never shows less than 1: Buy opens on the engine\'s word, not on a local zero', () => {
    expect(secondsLeft(snap(2), 1_000 + 2_000)).toBe(1)
    expect(secondsLeft(snap(2), 1_000 + 60_000)).toBe(1)
    expect(secondsLeft(snap(1), 1_000 + 1_000)).toBe(1)
  })
  test('a clock that went backwards counts as no time passed', () => {
    expect(secondsLeft(snap(3, 5_000), 1_000)).toBe(3)
  })
  test('a fractional number from an engine is rounded up: the count only ever errs toward waiting', () => {
    expect(secondsLeft(snap(2.2), 1_000)).toBe(3)
  })
})

describe('the words beside the trade box', () => {
  test('the line says the seconds left and the fee now', () => {
    expect(windowLine(3, 5980)).toBe('Launch window: 3 s left, fee now 59.8%')
    expect(windowLine(5, 9900)).toBe('Launch window: 5 s left, fee now 99%')
    expect(windowLine(1, 100)).toBe('Launch window: 1 s left, fee now 1%')
  })
  test('an unknown fee is the en dash, never a number', () => {
    expect(windowLine(3, null)).toBe('Launch window: 3 s left, fee now –')
    expect(windowLine(3, undefined)).toBe('Launch window: 3 s left, fee now –')
    expect(windowLine(3, null)).not.toContain('—')
  })
  test('the parts joined are the line', () => {
    const p = windowLineParts(4, 4020)
    expect(`Launch window: ${p.left} left, fee now ${p.fee}`).toBe(windowLine(4, 4020))
  })
  test('the button says how long to wait', () => {
    expect(waitLabel(3)).toBe('Wait 3 s')
    expect(waitLabel(1)).toBe('Wait 1 s')
  })
})

describe('the Launch preview row', () => {
  test('99% at launch, the tier\'s fee from second 5', () => {
    expect(windowValue(tier(100))).toBe('99% at launch, 1% from second 5')
    expect(windowValue(tier(400))).toBe('99% at launch, 4% from second 5')
    expect(windowParts(tier(1000))).toEqual({ cliff: '99%', end: '10%', fromSecond: 5 })
  })
  test('a window of longer steps ends where the steps end (the coin page says how long each step is)', () => {
    expect(windowValue({ cliffBps: 9900, endBps: 100, periods: 5, periodSeconds: 2 })).toBe('99% at launch, 1% from second 10')
  })
})

describe('the fixed fact on the coin page', () => {
  // 2026-10-07 copy pass (owner: one line per fact): Token info says how long the window lasts, its first fee, that it cannot change and the
  // creator's exception; every period's fee is on How it works (exampleSteps, below), the fee that stays is in the Trading fee fact beside it
  test('says how long the window lasts, its first fee, that it cannot change, and the creator\'s own first buy', () => {
    expect(fixedWindowText({ ...tier(100), firstSwapAtEndFee: true })).toBe(
      'The first 5 seconds cost more (99% at first), so bots cannot buy up the launch. It cannot change. The creator\'s own first buy, inside the launch transaction, pays the coin\'s fee and not the launch window\'s.',
    )
  })
  test('the creator\'s first buy is mentioned only when the config says it pays the coin\'s fee', () => {
    expect(fixedWindowText({ ...tier(200), firstSwapAtEndFee: false })).not.toContain('first buy')
    expect(fixedWindowText(tier(200))).not.toContain('first buy')
  })
  test('a window that does not divide evenly still says its length and first fee', () => {
    expect(fixedWindowText({ cliffBps: 9900, endBps: 101, periods: 5, periodSeconds: 1 })).toBe('The first 5 seconds cost more (99% at first), so bots cannot buy up the launch. It cannot change.')
  })
  test('steps of more than a second count in the window\'s length', () => {
    expect(fixedWindowText({ cliffBps: 9900, endBps: 100, periods: 5, periodSeconds: 2 })).toBe('The first 10 seconds cost more (99% at first), so bots cannot buy up the launch. It cannot change.')
  })
})

describe('How it works', () => {
  test('the 1% tier example: the fee in each period, then the fee that stays', () => {
    expect(exampleSteps(HOW_EXAMPLE)).toBe('99%, 79.4%, 59.8%, 40.2%, 20.6%, then 1% from second 5')
  })
  test('the example is a window that divides evenly, so its list is the real one', () => {
    expect(stepsOf(HOW_EXAMPLE)).not.toBeNull()
  })
})

describe('no em dash and no banned word in anything this file prints', () => {
  test('every string it makes is clean', () => {
    const all = [
      windowLine(3, null), windowLine(3, 100), waitLabel(2), windowValue(tier(100)), fixedWindowText(tier(600)), fixedWindowText({ ...tier(100), firstSwapAtEndFee: true }), exampleSteps(HOW_EXAMPLE),
    ].join('\n')
    expect(all).not.toMatch(/—|·|anonymous|yield|dividend|returns|unofficial/i)
  })
})
