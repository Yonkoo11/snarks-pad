// Who gets what from one trade on a tier's bonding curve, with the program's exact rounding. Pure integer
// arithmetic, no I/O, no secrets: the HTTP API, the tests and the web copy checks share it.
//
// The program (Meteora DBC 0.2.1, f552f20) takes a swap's fee in the quote token in this order, once per swap:
//   fee      = ceil(amount x fee_numerator / 1e9)          state/config.rs:174-187 (get_excluded_fee_amount, Rounding::Up)
//   protocol = floor(fee x 20 / 100)                       state/config.rs:148-153 (PROTOCOL_FEE_PERCENT, constants.rs:94)
//   trading  = fee - protocol
//   creator  = floor(trading x creator_pct / 100)          state/config.rs:1014-1033 (split_partner_and_creator_fee)
//   partner  = trading - creator
// `amount` is the trade's gross quote amount: the buyer's input on a buy, the curve's output before the fee on a sell
// (fees are collected in the quote token on both sides, CollectFeeMode::QuoteToken). With a referral, 20% of `protocol`
// goes to the referrer instead of Meteora (HOST_FEE_PERCENT); that never changes `creator` or `partner`.
// The pad's own 12.5/87.5 holders/team policy then applies to what the keeper claims (`partner`), in epoch/split.ts.
import { feeSplitBps, splitClaim } from "../epoch/split";
import { reviewedTier, windowScheduleOf } from "./reviewed";

const FEE_DENOMINATOR = 1_000_000_000n;
const PROTOCOL_PERCENT = 20n;
/** The pad's published policy (2026-10-12): of what the keeper claims, holders get 12.5% and the team 87.5% (config.epoch.team.shareBps default). */
export const POLICY_TEAM_SHARE_BPS = 8750;

export interface SwapFeeSplit {
  fee: bigint;
  meteora: bigint;
  creator: bigint;
  partner: bigint;
}

export interface TradeSplit extends SwapFeeSplit {
  holders: bigint;
  team: bigint;
}

/** The fee numerator the program charges at `bps`: bps / 10000 of 1e9 (the tier's fee after the launch window). */
export function feeNumeratorOf(bps: number): bigint {
  return (BigInt(bps) * FEE_DENOMINATOR) / 10_000n;
}

/** The program's split of one swap's fee. `creatorPercentage` is `creator_trading_fee_percentage` (0..100). */
export function splitSwapFee(amount: bigint, feeNumerator: bigint, creatorPercentage: number): SwapFeeSplit {
  if (amount < 0n) throw new Error("amount must be >= 0");
  if (!Number.isInteger(creatorPercentage) || creatorPercentage < 0 || creatorPercentage > 100) throw new Error("creatorPercentage must be an integer 0..100");
  const fee = (amount * feeNumerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  const meteora = (fee * PROTOCOL_PERCENT) / 100n;
  const trading = fee - meteora;
  const creator = (trading * BigInt(creatorPercentage)) / 100n;
  return { fee, meteora, creator, partner: trading - creator };
}

/**
 * One trade of `amount` raw quote units on tier `tierBps`: Meteora, the creator, and what the pad claims split holders/team. `feeNumerator` is the
 * fee the program charged that trade; left out, it is the tier's own fee, which is what every trade pays once the launch window has closed
 * (a trade inside the window pays the period's numerator: dbc/window.ts feeNumeratorAt). Only the amounts move with it, never the shares.
 */
export function tradeSplit(amount: bigint, tierBps: number, feeNumerator?: bigint): TradeSplit {
  const tier = reviewedTier(tierBps);
  if (!tier) throw new Error(`${tierBps} bps is not a reviewed fee tier`);
  const s = splitSwapFee(amount, feeNumerator ?? feeNumeratorOf(tier.bps), tier.creatorFeePercentage);
  const { holders, team } = splitClaim(s.partner, POLICY_TEAM_SHARE_BPS);
  return { ...s, holders, team };
}

export interface TierShares {
  /** Each is in bps of the WHOLE fee (10,000 = the fee), before the program's rounding. The four add up to 10,000. */
  meteoraBps: number;
  creatorBps: number;
  /** What the keeper claims from the pool (holders + team): 8,000 less the creator's part. */
  claimedBps: number;
  holdersBps: number;
  teamBps: number;
}

/** The tier's shares of the whole fee, for display (the program's per-swap rounding is in `tradeSplit`). `teamShareBps` is the policy's, of the claimed part. */
export function tierShares(tierBps: number, teamShareBps: number = POLICY_TEAM_SHARE_BPS): TierShares {
  const tier = reviewedTier(tierBps);
  if (!tier) throw new Error(`${tierBps} bps is not a reviewed fee tier`);
  const afterMeteoraBps = 8000; // 100% - Meteora's 20%, in bps of the fee
  const creatorBps = (afterMeteoraBps * tier.creatorFeePercentage) / 100;
  const claimedBps = afterMeteoraBps - creatorBps;
  const split = feeSplitBps(claimedBps, teamShareBps);
  return { meteoraBps: 10_000 - afterMeteoraBps, creatorBps, claimedBps, holdersBps: split.holders, teamBps: split.team };
}

/**
 * What a buyer who buys and sells straight back loses to the fee, in bps of the amount (the curve's own price
 * movement aside): 1 - (1 - f)^2. The Launch page shows it beside every tier as the cost of an instant round trip,
 * at the tier's fee: the launch window's first seconds cost more and the page says so beside it.
 */
export function roundTripCostBps(tierBps: number): number {
  const f = tierBps / 10_000;
  return Math.round((1 - (1 - f) ** 2) * 10_000);
}

/** A tier's launch window as GET /tiers sends it (contract v2.8): the reviewed numbers, so the Launch page can say what the window is before any coin has one. */
export interface TierWindow {
  cliffBps: number;
  endBps: number;
  periods: number;
  periodSeconds: number;
  /** periods x periodSeconds: from this second after the launch every trade pays `endBps`. */
  durationSeconds: number;
  /** What a buy pays in each period of the window, then the tier's fee at the end: `periods + 1` numbers, the first `cliffBps` and the last `endBps`. */
  feeByPeriodBps: number[];
  /** The launcher's own first buy, inside the launch transaction, pays `endBps`. */
  firstSwapAtEndFee: boolean;
}

export function tierWindow(tierBps: number): TierWindow {
  const w = windowScheduleOf(tierBps);
  return {
    cliffBps: w.cliffBps, endBps: w.endBps, periods: w.periods, periodSeconds: w.periodSeconds, durationSeconds: w.durationSeconds,
    feeByPeriodBps: w.feeByPeriodBps, firstSwapAtEndFee: w.firstSwapWithMinFee,
  };
}
