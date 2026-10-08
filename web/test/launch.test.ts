// What the Launch page says from the pad's own numbers (src/lib/launch.ts): the most a first buy can be, the one line under the tier picker, the 10% tier's tick box, and the facts of a tier its preview prints.
// What a buy and an immediate sell costs is said on the coin page and How it works (src/lib/format.ts), so its arithmetic is checked here with the other per-tier numbers.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TIER_FEES_BPS, feeLabel, per100, roundTripByTier, roundTripCostBps, roundTripPer100, zecRounded } from '../src/lib/format'
import { confirmLineOfTier, factsOfTier, feeLineOfTier, graduationText, liquidityText, maxFirstBuy, shareText, windowRowOfTier, zatsText } from '../src/lib/launch'
import type { Tier } from '../src/lib/types'

const THRESHOLD = '666666666' // the reviewed curve: 6.67 ZEC

describe('the most a first buy can be', () => {
  test('a wallet that holds less than the curve can take may spend all of it', () => {
    expect(maxFirstBuy(30_000_000n, THRESHOLD)).toBe(30_000_000n)
    expect(maxFirstBuy(0n, THRESHOLD)).toBe(0n)
  })

  test('a wallet that holds more is held to 95% of the graduation threshold, as the engine clamps a buy (engine/src/dbc/room.ts)', () => {
    expect(maxFirstBuy(10_000_000_000n, THRESHOLD)).toBe(633_333_332n)
  })

  test('no balance is no answer, and no threshold is no cap', () => {
    expect(maxFirstBuy(null, THRESHOLD)).toBeNull()
    expect(maxFirstBuy(10_000_000_000n, undefined)).toBe(10_000_000_000n)
    expect(maxFirstBuy(10_000_000_000n, 'not a number')).toBe(10_000_000_000n)
  })

  test('the amount goes into the field as ZEC text that the field reads back', () => {
    expect(zatsText(30_000_000n)).toBe('0.3')
    expect(zatsText(100_000_000n)).toBe('1')
    expect(zatsText(1n)).toBe('0.00000001')
    expect(zatsText(633_333_332n)).toBe('6.33333332')
    expect(zatsText(0n)).toBe('0')
    expect(zatsText(123_456_789_012n)).toBe('1234.56789012')
  })
})

describe('graduation and liquidity, in true words', () => {
  test('the threshold is rounded half up to two decimals, from the zats the engine sends', () => {
    expect(graduationText({ migrationThresholdZats: THRESHOLD })).toBe('6.67 ZEC')
    expect(graduationText({ migrationThresholdZats: '1000000000' })).toBe('10 ZEC')
    expect(graduationText({ migrationThresholdZats: '1000000001' })).toBe('10 ZEC')
    expect(graduationText({ migrationThresholdZats: '666499999' })).toBe('6.66 ZEC')
    expect(graduationText({ migrationThresholdZats: '666500000' })).toBe('6.67 ZEC')
  })

  test('one rounding on every page: the Launch preview and the coin page\'s Graduation fact print the same number from the same zats', () => {
    for (const z of [THRESHOLD, '1000000000', '1000000001', '666499999', '666500000', '1', '4999999', '5000000', '99999999', '123456789012']) {
      expect(graduationText({ migrationThresholdZats: z })).toBe(`${zecRounded(z, 2)} ZEC`)
    }
    const panel = readFileSync(new URL('../src/components/FixedPanel.svelte', import.meta.url), 'utf8')
    expect(panel).toContain('raised ${zecRounded(f.migration.thresholdZats, 2)} ZEC')
    expect(panel).not.toMatch(/\bzec\(f\.migration/)
    expect(readFileSync(new URL('../src/lib/launch.ts', import.meta.url), 'utf8')).toContain('`${zecRounded(z, 2)} ZEC`')
  })

  test('half up: down below the half of the last place, up at it and above, zeros trimmed, a sign kept, a thousands comma on a big amount', () => {
    expect(zecRounded('666666666', 2)).toBe('6.67')
    expect(zecRounded('666499999', 2)).toBe('6.66')
    expect(zecRounded('666500000', 2)).toBe('6.67')
    expect(zecRounded('1050000000', 2)).toBe('10.5')
    expect(zecRounded('1000000000', 2)).toBe('10')
    expect(zecRounded(0n, 2)).toBe('0')
    expect(zecRounded('1', 2)).toBe('0')
    expect(zecRounded('499999', 2)).toBe('0')
    expect(zecRounded('500000', 2)).toBe('0.01')
    expect(zecRounded('12345678', 4)).toBe('0.1235')
    expect(zecRounded('123456789012', 2)).toBe('1,234.57')
    expect(zecRounded(-666666666n, 2)).toBe('-6.67')
  })

  test('an engine that does not say, or says nonsense, gives a dash (null)', () => {
    expect(graduationText({})).toBeNull()
    expect(graduationText({ migrationThresholdZats: '0' })).toBeNull()
    expect(graduationText({ migrationThresholdZats: '-5' })).toBeNull()
    expect(liquidityText(undefined)).toBeNull()
  })

  test('"Locked for good" is said only when none of the liquidity is left unlocked', () => {
    for (const [partnerLockedPct, creatorLockedPct] of [[100, 0], [50, 50], [25, 75], [17, 83]]) {
      expect(liquidityText({ partnerLockedPct, creatorLockedPct, unlockedPct: 0 })).toBe('Locked for good')
    }
    expect(liquidityText({ partnerLockedPct: 60, creatorLockedPct: 0, unlockedPct: 40 })).toBe('60% locked for good')
    expect(liquidityText({ partnerLockedPct: 0, creatorLockedPct: 0, unlockedPct: 100 })).toBe('Not locked')
    for (const l of [{ partnerLockedPct: 60, creatorLockedPct: 0, unlockedPct: 40 }, { partnerLockedPct: 0, creatorLockedPct: 0, unlockedPct: 100 }]) {
      expect(liquidityText(l)).not.toBe('Locked for good')
    }
  })
})

// The five tiers as GET /tiers sends them (engine/src/dbc/tiers.ts): Meteora keeps 20% of the fee, the creator takes a share of the rest and the pad
// splits what it claims 75/25 between holders and the team. engine/test/tiers-view.test.ts checks these against the engine itself.
const tier = (feeBps: number, creatorShareBps: number, holderShareBps: number, postGraduationFeeBps = feeBps): Tier => ({
  feeBps, available: true, postGraduationFeeBps, roundTripCostBps: 0, meteoraShareBps: 2000, creatorShareBps, holderShareBps,
  teamShareBps: 8000 - creatorShareBps - holderShareBps, claimedShareBps: 8000 - creatorShareBps,
})

describe('the facts of a tier', () => {
  test('the 1% tier: holders get 60% of the fee, and the creator gets none', () => {
    const f = factsOfTier(tier(100, 0, 6000))
    expect(f.fee).toBe('1%')
    expect(f.holdersShare).toBe('60%')
    expect(f.creatorShare).toBeNull()
  })

  test('the 4% tier: the creator has 60% of the fee, holders 15%', () => {
    const f = factsOfTier(tier(400, 6000, 1500))
    expect(f.fee).toBe('4%')
    expect(f.creatorShare).toBe('60%')
    expect(f.holdersShare).toBe('15%')
  })

  test('the 6% tier keeps its odd decimals (10.2% to holders, 66.4% to the creator); the 10% tier\'s pool still charges 6%, rising to about 7.2%, where the pages say it', () => {
    const six = factsOfTier(tier(600, 6640, 1020))
    expect(six.holdersShare).toBe('10.2%')
    expect(six.creatorShare).toBe('66.4%')
    expect(feeLabel({ feeBps: 1000, stage: 'graduated', postGraduationFeeBps: 600 })).toBe('6%, rising to about 7.2% when trading is volatile')
  })

  test('a share is printed with one decimal at most', () => {
    expect(shareText(6000)).toBe('60%')
    expect(shareText(1020)).toBe('10.2%')
    expect(shareText(6640)).toBe('66.4%')
    expect(shareText(0)).toBe('0%')
  })
})

// The window GET /tiers sends for a tier (engine/src/dbc/tiers.ts tierWindow): 99% down to the tier's fee in 5 steps of 1 s. The preview row prints exactly these numbers.
const withWindow = (t: Tier, firstSwapAtEndFee = true): Tier => ({
  ...t,
  launchWindow: {
    cliffBps: 9900, endBps: t.feeBps, periods: 5, periodSeconds: 1, durationSeconds: 5, firstSwapAtEndFee,
    feeByPeriodBps: Array.from({ length: 6 }, (_, k) => 9900 - k * ((9900 - t.feeBps) / 5)),
  },
})

describe('the Launch window row of a tier', () => {
  test('the 1% tier: 99% at launch, 1% from second 5', () => {
    const row = windowRowOfTier(withWindow(tier(100, 0, 6000)))!
    expect(row.value).toBe('99% at launch, 1% from second 5')
    expect(row.parts).toEqual({ cliff: '99%', end: '1%', fromSecond: 5 })
  })

  test('the fee after the window is the picked tier\'s own, not typed: 4%, 6% and 10% end on their own fee', () => {
    expect(windowRowOfTier(withWindow(tier(400, 6000, 1500)))!.value).toBe('99% at launch, 4% from second 5')
    expect(windowRowOfTier(withWindow(tier(600, 6640, 1020)))!.value).toBe('99% at launch, 6% from second 5')
    expect(windowRowOfTier(withWindow(tier(1000, 7200, 600, 600)))!.value).toBe('99% at launch, 10% from second 5')
  })

  test('the row is one fact: a window row carries a value and its parts, and no line under it', () => {
    expect(Object.keys(windowRowOfTier(withWindow(tier(200, 4000, 3000), false))!).sort()).toEqual(['parts', 'value'])
  })

  test('an engine that does not send the window gives no row (a dash on the card), never a made-up one', () => {
    expect(windowRowOfTier(tier(100, 0, 6000))).toBeNull()
  })
})

// What the pages print per tier, as GET /tiers sends the tiers (engine/src/dbc/tiers.ts): the one line under the Launch page's tier picker, and what a buy and an immediate sell costs, which the coin page and How it works say now that the Launch form does not.
// engine/test/copy.test.ts checks the same numbers against the engine's own, and where each sentence sits in the pages.
describe('the numbers per tier', () => {
  // fee, roundTripCostBps, then [creator, holders, team, Meteora] in bps of the whole fee, what the pages print for the cost and for the four parts, and the whole line under the picker
  const rows: [number, number, number[], string, string[], string][] = [
    [100, 199, [0, 6000, 2000, 2000], '$1.99', ['$0.00', '$0.60', '$0.20', '$0.20'],
      '1% on every trade, paid in ZEC, fixed at launch.'],
    [200, 396, [4000, 3000, 1000, 2000], '$3.96', ['$0.80', '$0.60', '$0.20', '$0.40'],
      '2% on every trade, paid in ZEC, fixed at launch.'],
    [400, 784, [6000, 1500, 500, 2000], '$7.84', ['$2.40', '$0.60', '$0.20', '$0.80'],
      '4% on every trade, paid in ZEC, fixed at launch.'],
    [600, 1164, [6640, 1020, 340, 2000], '$11.64', ['$3.984', '$0.612', '$0.204', '$1.20'],
      '6% on every trade, paid in ZEC, fixed at launch.'],
    [1000, 1900, [7200, 600, 200, 2000], '$19.00', ['$7.20', '$0.60', '$0.20', '$2.00'],
      '10% on every trade, paid in ZEC, fixed at launch.'],
  ]
  const splitOf = (feeBps: number, shares: number[]) => ({ feeBps, creatorShareBps: shares[0]!, holderShareBps: shares[1]!, teamShareBps: shares[2]!, meteoraShareBps: shares[3]! })

  test('the one line under the tier picker, for each of the five tiers: the fee, paid in ZEC, fixed at launch, and nothing else (owner, 2026-10-06: "remove the per $100 lines too")', () => {
    for (const [feeBps, , shares, , , line] of rows) {
      const l = feeLineOfTier(splitOf(feeBps, shares))
      expect(l.fee + l.rest).toBe(line)
    }
  })

  test('the fee is the line\'s first words, on its own so the page can set it in mono, and the rest starts with the space after it', () => {
    const l = feeLineOfTier(splitOf(600, [6640, 1020, 340, 2000]))
    expect(l.fee).toBe('6%')
    expect(l.rest).toBe(' on every trade, paid in ZEC, fixed at launch.')
  })

  test('no line names a share or a dollar figure: the preview card says who gets what ("To you", "To holders")', () => {
    for (const [feeBps, , shares] of rows) expect(feeLineOfTier(splitOf(feeBps, shares)).rest).not.toMatch(/\$|\byou\b|holders|team|Meteora/)
  })

  test('nothing else is said in it: what a buy and an immediate sell costs, the launch window, the graduated pool, Meteora\'s hand in it, the delivery cost and wallet-to-wallet sends are elsewhere', () => {
    for (const [, , , , , line] of rows) {
      expect(line).not.toMatch(/immediate sell|window|graduat|pause|runs|shielded|delivery|wallet|lose|lost|fewer|slowly|rising/i)
      expect(line.split('. ')).toHaveLength(1) // the fee sentence only (2026-10-06: the split sentence left the line)
      expect(line).not.toMatch(/—|·|anonymous|yield|dividend|returns|unofficial/i)
    }
  })

  test('a buy and an immediate sell costs, per $100, what the engine says: two decimals, never rounded away', () => {
    for (const [, cost, , printed] of rows) expect(roundTripPer100(cost)).toBe(printed)
    expect(roundTripPer100(0)).toBe('$0.00')
  })

  test('the cost is worked out from the fee the engine\'s way, 1 - (1 - fee)^2 in bps, so the coin page can say it without asking the tier menu', () => {
    for (const [feeBps, cost] of rows) expect(roundTripCostBps(feeBps)).toBe(cost)
    expect(roundTripCostBps(0)).toBe(0)
  })

  test('How it works lists every tier of the menu with its cost, in the menu\'s order', () => {
    expect(TIER_FEES_BPS).toEqual(rows.map(([feeBps]) => feeBps))
    expect(roundTripByTier()).toEqual([
      { tier: '1%', cost: '$1.99' }, { tier: '2%', cost: '$3.96' }, { tier: '4%', cost: '$7.84' }, { tier: '6%', cost: '$11.64' }, { tier: '10%', cost: '$19.00' },
    ])
  })

  test('the four parts of every $100 are the tier\'s own, with the 6% tier\'s odd third decimal kept', () => {
    for (const [feeBps, , shares, , parts] of rows) expect(shares.map((share) => per100(feeBps, share))).toEqual(parts)
  })

  test('the four parts add up to the fee on every $100 (a 4% fee is $4.00), so the line never adds or drops a cent', () => {
    for (const [feeBps, , shares, , parts] of rows) {
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(10_000)
      const thousandths = parts.reduce((sum, text) => sum + Math.round(Number(text.slice(1)) * 1000), 0)
      expect(thousandths).toBe(feeBps * 10)
    }
  })
})

// The 10% tier asks a second time before Launch opens (Launch.svelte, CONFIRM_FEE_BPS). The line beside the tick box is built like the line under the picker: the fee, on every trade,
// fixed at launch. Owner review 2026-10-05: it no longer says what a buy and an immediate sell costs (the coin page and How it works do), and it adds the pool's fee after graduation.
describe('the 10% tier\'s tick box', () => {
  const ten = tier(1000, 7200, 600, 600)

  test('the line: the fee, on every trade, fixed at launch, and the pool\'s lower fee after graduation', () => {
    expect(confirmLineOfTier(ten)).toBe('I understand: 10% on every trade, fixed at launch, 6% after graduation.')
  })

  test('it says nothing about what a buy and an immediate sell costs, and has no dollar figure', () => {
    expect(confirmLineOfTier(ten)).not.toMatch(/immediate|sell|round trip|of every|\$|cannot be changed/i)
  })

  test('the fact it adds is four words at most, and only a tier whose pool charges less has one', () => {
    const added = /fixed at launch, (.+)\.$/.exec(confirmLineOfTier(ten))![1]!
    expect(added).toBe('6% after graduation')
    expect(added.split(' ').length).toBeLessThanOrEqual(4)
    expect(confirmLineOfTier(tier(400, 6000, 1500))).toBe('I understand: 4% on every trade, fixed at launch.')
  })

  test('it opens the way the line under the picker does: the same fee, in the same words', () => {
    const under = feeLineOfTier(ten)
    expect(confirmLineOfTier(ten).startsWith(`I understand: ${under.fee} on every trade`)).toBe(true)
    expect(under.rest.startsWith(' on every trade, paid in ZEC, fixed at launch.')).toBe(true)
  })
})
