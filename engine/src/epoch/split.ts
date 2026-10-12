// Business-model split of a claimed fee. Of the 80% partner share the
// keeper claims, holders get 12.5% (0.10% of volume) and the team 87.5% (0.70% of volume): the owner's published policy
// since 2026-10-12 (75/25 before that). The team share first pays
// the cost of delivering opted-in holders' rewards shielded (the 1Click withdraw fee, the swap's slippage and the
// Zcash network fee), so those holders receive their full share. Pure integer arithmetic, no I/O.
//
// The delivery-cost rule (decided and tested in test/team-split.test.ts):
//  1. At planning time the team RESERVES an estimate of the cost, capped at its own share of this epoch:
//     reserve = min(team gross, withdrawFee + 5000 x (recipients + chunks) + shielded total x reserveBps / 10000),
//     chunks = ceil(recipients / maxPerTx): every Ironwood transaction carries its own change output.
//     The reserve is swapped together with the holders' shielded total, so the treasury receives both.
//  2. When the swap settles, holders are paid their full planned amounts when the settled output minus the Zcash
//     fee covers them. What is left of the reserve stays in the treasury wallet as the team's native ZEC.
//  3. When the cost exceeds the reserve, the excess is borne by the shielded holders, pro rata (the repricing that
//     already existed). The team never goes negative and no deficit is carried into a later epoch, so one bad
//     swap cannot leave a debt that a later epoch's holders silently pay.
//  4. When the swap does not happen (it failed before funds moved, or 1Click refunded it) the reserve was never
//     spent and returns to the team's Solana ZEC.
const BPS = 10_000n;

export const MAX_TEAM_SHARE_BPS = 8_750; // the published policy is the ceiling: an env typo may lower the team's share, never raise it

export interface ClaimSplit {
  holders: bigint;
  team: bigint;
}

/** team = floor(claimed x teamBps / 10000); holders get the remainder, so holders + team == claimed exactly. */
export function splitClaim(claimed: bigint, teamBps: number): ClaimSplit {
  if (claimed < 0n) throw new Error("claimed must be >= 0");
  if (!Number.isInteger(teamBps) || teamBps < 0 || teamBps > MAX_TEAM_SHARE_BPS) throw new Error(`teamBps must be an integer 0..${MAX_TEAM_SHARE_BPS}`);
  const team = (claimed * BigInt(teamBps)) / BPS;
  return { holders: claimed - team, team };
}

export interface ReserveInput {
  teamGross: bigint;
  shieldedTotal: bigint;
  shieldedCount: number;
  withdrawFeeZats: bigint;
  reserveBps: number;
  /** Recipients per Ironwood transaction (config.epoch.maxShieldedRecipientsPerTx). */
  maxPerTx?: number;
}

/** The engine's cap on recipients per Ironwood transaction; callers pass config.epoch.maxShieldedRecipientsPerTx. */
export const DEFAULT_MAX_RECIPIENTS_PER_TX = 350;

/**
 * Zcash network fee estimate for a batched shielded payout (engine/README.md "Shielded network fee model"):
 * 5,000 x (recipients + 1) per transaction, the 1 being its change output. A payout of more than `maxPerTx`
 * recipients is several transactions, each with its own change output (stress scale run, audit/STRESS-REPORT.md).
 */
export function zcashFeeEstimate(recipients: number, maxPerTx: number = DEFAULT_MAX_RECIPIENTS_PER_TX): bigint {
  if (!Number.isInteger(maxPerTx) || maxPerTx < 1) throw new Error("maxPerTx must be a positive integer");
  const chunks = Math.max(1, Math.ceil(recipients / maxPerTx));
  return 5000n * (BigInt(recipients) + BigInt(chunks));
}

export function deliveryReserve(i: ReserveInput): bigint {
  if (i.shieldedCount <= 0 || i.shieldedTotal <= 0n || i.teamGross <= 0n) return 0n;
  const slippage = (i.shieldedTotal * BigInt(i.reserveBps) + BPS - 1n) / BPS; // rounded up
  const estimate = i.withdrawFeeZats + zcashFeeEstimate(i.shieldedCount, i.maxPerTx) + slippage;
  return estimate < i.teamGross ? estimate : i.teamGross;
}

export interface SettleInput {
  teamGross: bigint;
  reserve: bigint;
  shieldedTotal: bigint; // what the holders' shielded rows were planned at
  settledOut: bigint; // what the treasury really received from the swap
  networkFee: bigint; // estimate of the Zcash fee of the payout
}

export interface Settlement {
  /** What the shielded holders receive in total: min(planned, settled output - fee). */
  paid: bigint;
  /** Planned minus paid: the part of the cost the reserve did not cover, borne by shielded holders. */
  holderShortfall: bigint;
  /** Native ZEC left in the treasury wallet after paying holders and the fee: the team's. */
  teamNative: bigint;
  /** What delivery cost the team: reserve - teamNative. Negative only if the swap returned more than it was given. */
  deliveryCost: bigint;
  /** The team's Solana ZEC from this epoch: its gross share minus what went into the swap. */
  teamSolana: bigint;
}

export function settleDelivery(i: SettleInput): Settlement {
  const available = i.settledOut > i.networkFee ? i.settledOut - i.networkFee : 0n;
  const paid = available < i.shieldedTotal ? available : i.shieldedTotal;
  const teamNative = available - paid;
  return {
    paid,
    holderShortfall: i.shieldedTotal - paid,
    teamNative,
    deliveryCost: i.reserve - teamNative,
    teamSolana: i.teamGross - i.reserve,
  };
}

/**
 * The swap did not run (failed before funds moved, or was refunded). `refundShortfall` is what a refund came back short
 * by (1Click's refund fee, audit S3-01): a delivery cost, so the team bears it first and holders only the rest.
 */
export function settleWithoutSwap(teamGross: bigint, refundShortfall = 0n): Settlement {
  const teamPart = refundShortfall < teamGross ? refundShortfall : teamGross;
  return { paid: 0n, holderShortfall: refundShortfall - teamPart, teamNative: 0n, deliveryCost: teamPart, teamSolana: teamGross - teamPart };
}

export interface FeeSplitBps {
  meteora: number;
  holders: number;
  team: number;
}

/** Where each basis point of a trade's fee goes: Meteora keeps its share, the pad claims the rest and splits it holders/team. 10000 = the whole fee. */
export function feeSplitBps(claimedShareOfFeeBps: number, teamShareOfClaimedBps: number): FeeSplitBps {
  const team = Math.floor((claimedShareOfFeeBps * teamShareOfClaimedBps) / 10_000);
  return { meteora: 10_000 - claimedShareOfFeeBps, holders: claimedShareOfFeeBps - team, team };
}
