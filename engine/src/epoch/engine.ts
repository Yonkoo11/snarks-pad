// Epoch orchestrator: migrate-if-full -> claim each coin's ZEC fee -> snapshot
// -> pro-rata split -> ONE swap for the shielded share -> ONE batched shielded
// payout + direct Solana ZEC payouts.
//
// Resumable end to end. Every step that can move real funds is broken into a
// "durably record intent" half and a "make it happen" half, in that order, so
// a crash anywhere resumes from exactly what was last recorded instead of
// re-doing (double claim/pay) or losing (unattributed proceeds) work:
//   - fee claims: each claim is signed, persisted, then broadcast (claim_progress,
//     src/dbc/claim.ts); per-coin proceeds + already-computed shares are
//     persisted the moment that coin's claim lands (findings 5, 6; see claimRemainingCoins).
//   - the epoch's plan (who gets paid what, and -- for shielded -- to which
//     exact Zcash address) is written in one DB transaction before anything
//     is sent (findings 4, 6; see finalizeHarvest/planPayouts).
//   - the swap leg is a persisted state machine, never re-submitted once
//     funds have moved (finding 2; see progressSwap).
//   - both payout legs sign/record a transaction's signature BEFORE
//     broadcasting it, and resume by checking that signature's chain status
//     rather than blindly resending (finding 1; see sendSolanaLeg/sendShieldedLeg).
// Only one epoch run proceeds at a time: a DB-backed exclusive lock guards the
// whole thing, with stale-lock takeover if a prior run crashed (finding 5).
import { AsyncLocalStorage } from "node:async_hooks";
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import * as db from "../db";
import type { EpochRow } from "../db";
import { ClaimPending, claimCoinFees } from "../dbc/claim";
import { claimerFor, feeClaimerAddressOf } from "../dbc/claimers";
import { reconcileMigration } from "../dbc/migrate";
import { ensureDbcConfig } from "../dbc/setup";
import { recordedExcludedOwners, type Holder } from "../holders";
import { minimumBalanceHolders, readCurrentHolders } from "./snapshots";
import { chainIsolationDeps, isolationProblems, stuckReason, type IsolationDeps } from "./stuck";
import { PayoutsPaused, assertNotPaused, haltReason } from "../pause";
import { proRataSplit, applyDustFloor, applyShieldedPolicy, type Share } from "./math";
import { buildSnapshot, serializeSnapshot, snapshotSha256 } from "./snapshotFile";
import { ensureSnapshotMemo } from "./snapshotMemo";
import { deliveryReserve, settleDelivery, settleWithoutSwap, splitClaim, zcashFeeEstimate, type Settlement } from "./split";
import { applyAccountPolicy, sendSolanaZecPayouts, type SkippedRecipient } from "./solanaPayout";
import { sendZcashPayouts } from "./zcashPayout";
import { redactZcashAddresses, rewardMemo } from "../zcash/devtool";
import { isSignatureLanded, resolvePendingTx } from "../solana";
import { isChainUnavailable } from "../rpcGuard";
import { SwapFundsMayHaveMoved, SwapNotAttempted, type SwapAdapter } from "../swap/types";
import { redactSecrets } from "../util/redact";

export interface EpochOutcome {
  epoch: EpochRow | null; // null: nothing was claimed, so no epoch was recorded
  // Set when a claim is signed but not confirmed, or waiting for an owner's
  // approval: the epoch stays a draft and the next run resumes it. Nothing is
  // finalized, paid or discarded while a claim's ZEC may be on its way.
  awaitingClaims?: string[];
  // Set when payouts are paused (PAYOUTS_PAUSED=1 or the pause file) or a stop was requested: nothing was
  // claimed or sent from the point it was noticed, and the next run resumes (src/pause.ts).
  paused?: string;
  // Set when an earlier epoch is parked (needs_attention) and its money cannot be proven separate from a new
  // epoch's: no new epoch was started (audit O-2, src/epoch/stuck.ts).
  halted?: string[];
}

export interface ClaimDeps {
  /** Migrates if the curve is full, then claims; returns the ZEC that landed. Throws, or throws ClaimPending, to leave the coin for a later run. */
  claimCoin: (epochId: string, coin: db.CoinRow) => Promise<bigint>;
  /** The eligible holders right now (the claim-time sample). */
  currentHolders: (mint: string) => Promise<Holder[]>;
  /** Makes sure the pad's DBC config is recorded and matches the chain before any claim; default ensureDbcConfig. A test without a chain passes a no-op. */
  ensureConfig?: () => Promise<unknown>;
}

const chainClaimDeps: ClaimDeps = {
  async claimCoin(epochId, listed) {
    const claimer = await claimerFor(feeClaimerAddressOf(listed)); // records a Squads multisig's members for the exclusion below
    const coin = await reconcileMigration(listed, claimer.publicKey);
    return claimCoinFees(epochId, coin, claimer);
  },
  currentHolders: readCurrentHolders,
};

/**
 * Migrates (if the curve is full) and claims every launched coin not already
 * recorded for this draft epoch, persisting each coin's result the instant its
 * claim lands (findings 5, 6). A coin that throws is simply left unrecorded: it
 * is retried on the next call (a resume of this same draft, or a later epoch)
 * rather than aborting the whole epoch after other coins already claimed.
 * What a coin "claimed" is the ZEC that landed in the keeper's account, read
 * from its own claim transactions (src/dbc/claim.ts), so attribution is exact
 * per coin. Each coin's shares are weighted by the least balance a holder showed across the
 * window's random samples plus one taken now (audit O-1, src/epoch/snapshots.ts); a coin whose window
 * has too few samples is not claimed this epoch.
 */
export async function claimRemainingCoins(epochId: string, deps: ClaimDeps = chainClaimDeps): Promise<void> {
  await (deps.ensureConfig ?? ensureDbcConfig)();
  const alreadyDone = new Set(db.listEpochCoinHarvests(epochId).map((h) => h.mint));
  const coins = db.listCoins().filter((c) => c.status === "launched" && !alreadyDone.has(c.mint));
  const epoch = db.getEpoch(epochId)!;
  const windowStart = claimWindowStart(epoch.at);
  for (const listed of coins) {
    assertLockHeld(); // fencing (audit S2-02): never start a claim after another run took the lock over
    await claimOneCoin(epochId, listed, db.listHolderSamples(listed.mint, windowStart, epoch.at), deps);
  }
}

// The holder-sample window of a claim starts at the previous epoch, or at the last draft that claimed and was then
// discarded because no coin had an eligible holder (every claim held as orphaned proceeds), whichever is later.
// Without the second, a discarded draft never moved the window: a sample taken before the holders bought stayed in
// it, their minimum stayed 0, and every later run orphaned the proceeds again, so the coin's holders were never paid
// (found by the server soak 2026-10-03; on mainnet: a keeper started before the first buys of the first coin).
const CLAIM_WINDOW_FLOOR_META = "claim_window_floor_at";
// The draft in which a coin's claim was skipped for having no eligible holder (audit S6, product decision 1). Such a draft
// moves the window like one that claimed: the sample that showed nobody is the reason there was no eligible holder, and
// leaving it in every later window would keep the coin unclaimed for as long as the sample lives.
const CLAIM_SKIPPED_IN_DRAFT_META = "claim_skipped_in_draft";

export function claimWindowStart(epochAt: string): string {
  const previous = db.previousEpochAt(epochAt) ?? new Date(0).toISOString();
  const floor = db.getMeta(CLAIM_WINDOW_FLOOR_META);
  return floor !== null && floor > previous && floor < epochAt ? floor : previous;
}

/** Drops a draft that ended with nothing to pay; if any coin's claim was recorded or skipped for no eligible holder in it, the next window starts at its time. */
export function discardEmptyDraft(epochId: string): void {
  const epoch = db.getEpoch(epochId);
  if (epoch && (db.listEpochCoinHarvests(epochId).length > 0 || db.getMeta(CLAIM_SKIPPED_IN_DRAFT_META) === epochId)) db.setMeta(CLAIM_WINDOW_FLOOR_META, epoch.at);
  db.deleteMeta(CLAIM_SKIPPED_IN_DRAFT_META);
  db.deleteDraftEpoch(epochId);
}

async function claimOneCoin(epochId: string, listed: db.CoinRow, samples: db.HolderSample[], deps: ClaimDeps): Promise<void> {
  // Audit O-1: the reward weights are the least balance across the samples of this epoch's window plus one now.
  // Decided BEFORE the claim: a claim without enough samples would leave ZEC in the keeper that no share explains.
  // Decided ONCE (audit S6-A1): a coin whose claim already started this epoch is resumed whatever the window says now
  // (samples older than 30 days are pruned, and an owner approval can take days), or its claim would wait forever.
  if (samples.length < config.epoch.snapshots.minWindowSamples && !db.hasClaimProgress(epochId, listed.mint)) {
    console.error(`coin ${listed.mint} not claimed this epoch: ${samples.length} holder samples in its window, ${config.epoch.snapshots.minWindowSamples} required (the keeper takes them; see engine/README.md "Holder samples")`);
    return;
  }
  // Audit S6, product decision 1: no claim without an eligible holder. The fees stay claimable in the pool, where they
  // belong to whoever holds the coin through a later window; a claim made with nobody to pay would sit in the keeper
  // account as orphaned proceeds instead. A claim already started this epoch is finished whatever the holders are now.
  if (!db.hasClaimProgress(epochId, listed.mint)) {
    let holdersNow: Holder[];
    try {
      holdersNow = await deps.currentHolders(listed.mint);
    } catch (err) {
      // The same rule as a failed claim (nemesis NM-1): the chain being down stops the run for every coin; anything else
      // (this coin's mint or pool unreadable) skips this coin this run and the next coin is still claimed.
      if (isChainUnavailable(err)) throw err;
      console.error(`coin ${listed.mint} not claimed this epoch: its holders could not be read, will retry on the next resume/epoch:`, (err as Error)?.message ?? err);
      return;
    }
    const eligibleNow = minimumBalanceHolders([...samples.map((s) => s.holders), holdersNow], recordedExcludedOwners());
    if (eligibleNow.length === 0) {
      console.error(`coin ${listed.mint} not claimed this epoch: no holder held it through its window; its fees stay in the pool for the round that has one`);
      db.setMeta(CLAIM_SKIPPED_IN_DRAFT_META, epochId);
      return;
    }
  }
  let claimed: bigint;
  try {
    claimed = await deps.claimCoin(epochId, listed);
  } catch (err) {
    if (isChainUnavailable(err)) throw err; // the chain is down for every coin: the scheduler backs off and retries, the draft stays (audit S6, lens 3-4)
    if (err instanceof ClaimPending) console.error(err.message);
    else console.error(`claim failed for ${listed.mint}, will retry on the next resume/epoch:`, (err as Error)?.message ?? err);
    return;
  }
  if (claimed === 0n) {
    db.recordEpochCoinHarvest(epochId, listed.mint, 0n, []); // done for this epoch, nothing to attribute
    return;
  }
  const holders = minimumBalanceHolders([...samples.map((s) => s.holders), await deps.currentHolders(listed.mint)], recordedExcludedOwners());
  // Fold in any proceeds orphaned by a past epoch where this coin had zero
  // eligible holders (finding 10): real zats that were claimed but had no one
  // to pay, now that eligible holders exist again.
  const toDistribute = claimed + db.getOrphanedCoinProceeds(listed.mint);
  // Owner policy 2026-10-02: the team keeps its share of the claim, holders split the rest (src/epoch/split.ts).
  const { holders: holdersZats, team } = splitClaim(toDistribute, config.epoch.team.shareBps);
  const weights = new Map(holders.map((h) => [h.wallet, h.balance]));
  const shares = proRataSplit(holdersZats, holders.map((h) => ({ wallet: h.wallet, balance: h.balance }))).map((s) => ({ ...s, weight: weights.get(s.wallet) }));
  // Nobody eligible: hold the whole amount (not just this epoch's slice, and with no team cut taken yet) for the next
  // attempt instead of recording it as paid-and-unattributed. Nothing to pay this epoch, so this coin contributes 0.
  if (shares.length === 0) db.recordEpochCoinHarvest(epochId, listed.mint, 0n, [], toDistribute);
  else db.recordEpochCoinHarvest(epochId, listed.mint, toDistribute, shares, 0n, team);
}

/** The team's part of a released orphaned bucket (audit S6, product decision 1): the same quarter as of a claim. */
export const ORPHAN_RELEASE_TEAM_BPS = 2_500;

/**
 * Fees held for a coin that had no eligible holder for `config.epoch.orphanReleaseDays` join this round (audit S6, product
 * decision 1): a quarter to the team, the rest pro rata to the holders this round pays, recorded as a harvest under the
 * orphaned mint so the public record shows where the money went. Runs after the claims (the coin's own holders, if any
 * appeared, already folded the bucket into its claim) and before the harvest is finalized. A round that pays nobody
 * releases nothing: the bucket waits for one that does.
 */
export function releaseStaleOrphans(epochId: string, nowMs: number = Date.now()): void {
  const paid = [...db.combineEpochCoinShares(epochId)].filter(([, amount]) => amount > 0n);
  if (paid.length === 0) return;
  const cutoffMs = nowMs - config.epoch.orphanReleaseDays * 86_400_000;
  for (const bucket of db.listOrphanedCoinProceeds()) {
    if (bucket.sinceAt === null || Date.parse(bucket.sinceAt) > cutoffMs) continue;
    const amount = BigInt(bucket.amountZats);
    const { holders: holdersZats, team } = splitClaim(amount, ORPHAN_RELEASE_TEAM_BPS);
    const shares = proRataSplit(holdersZats, paid.map(([wallet, balance]) => ({ wallet, balance })));
    db.recordEpochCoinHarvest(epochId, bucket.mint, amount, shares, 0n, team);
    console.error(`coin ${bucket.mint}: ${amount} zats held since ${bucket.sinceAt} with no eligible holder join this round: ${shares.length} holders share ${holdersZats}, the team ${team}`);
  }
}

/** Wallets that created a coin in this epoch: paid like any holder, flagged in the ledger. */
const CREATOR_FLAG = "creator";

/** What the shielded leg was planned to pay: the base for the team's delivery reserve. */
export interface ShieldedPlan {
  total: bigint;
  count: number;
}

export function planPayouts(
  epochId: string,
  combined: Map<string, bigint>,
  optedInWallets: Set<string>,
  zcashByWallet: Map<string, string>,
  creators: Set<string>,
  includeShielded = true,
): ShieldedPlan {
  const flagOf = (wallet: string) => (creators.has(wallet) ? CREATOR_FLAG : null);
  // Audit S2-07: carry is money the keeper already holds for a wallet, owed
  // whether or not that wallet earned a share this epoch, and whichever rail it
  // is on now (every carry is Solana ZEC in the keeper account: carried shares
  // were never swapped). So every wallet with carry is planned, and both of
  // its carries go to its current rail.
  const wallets = new Set([...combined.keys(), ...db.listCarryWallets()]);
  const shares: Share[] = [...wallets].map((wallet) => ({ wallet, amount: combined.get(wallet) ?? 0n }));
  const solanaShares = shares.filter((s) => !optedInWallets.has(s.wallet));
  const shieldedShares = shares.filter((s) => optedInWallets.has(s.wallet));
  const carryOf = (w: string) => db.getCarry(w, "solana") + db.getCarry(w, "shielded");
  const setRailCarry = (w: string, kind: "solana" | "shielded", amount: bigint) => {
    db.setCarry(w, kind, amount);
    db.setCarry(w, kind === "solana" ? "shielded" : "solana", 0n);
  };

  const solanaCarryIn = new Map(solanaShares.map((s) => [s.wallet, carryOf(s.wallet)]));
  const shieldedCarryIn = new Map(shieldedShares.map((s) => [s.wallet, carryOf(s.wallet)]));
  const solanaSplit = applyDustFloor(solanaShares, solanaCarryIn, config.epoch.dustFloorZats);
  if (!includeShielded) {
    // A Solana-only epoch (plan 4b: the shielded batch runs weekly): opted-in shares wait as carry, which is
    // Solana ZEC in the keeper's account (nothing is swapped), and are planned by the next shielded epoch.
    for (const s of shieldedShares) setRailCarry(s.wallet, "shielded", (shieldedCarryIn.get(s.wallet) ?? 0n) + s.amount);
    for (const s of solanaSplit.toSend) {
      db.planPayout({ epochId, wallet: s.wallet, kind: "solana", amountZats: s.amount.toString(), flag: flagOf(s.wallet) });
      setRailCarry(s.wallet, "solana", 0n);
    }
    for (const s of solanaSplit.toCarry) setRailCarry(s.wallet, "solana", s.amount);
    return { total: 0n, count: 0 };
  }
  const shieldedSplit = applyShieldedPolicy(shieldedShares, shieldedCarryIn, {
    perHolderMinZats: config.epoch.shieldedMinPerHolderZats,
    swapMinZats: config.epoch.shieldedMinSwapZats,
    swapMaxZats: shieldedSwapCap(shieldedShares.length),
  });

  for (const s of solanaSplit.toSend) {
    db.planPayout({ epochId, wallet: s.wallet, kind: "solana", amountZats: s.amount.toString(), flag: flagOf(s.wallet) });
    setRailCarry(s.wallet, "solana", 0n);
  }
  for (const s of solanaSplit.toCarry) setRailCarry(s.wallet, "solana", s.amount);
  for (const s of shieldedSplit.toSend) {
    // Snapshotted here, at planning time (finding 4): the destination address
    // travels with the payout row from now on. If this wallet opts out before
    // the shielded leg actually sends, the payout already in flight still
    // goes where it was planned -- opt-out only ever changes the NEXT
    // epoch's planning.
    db.planPayout({ epochId, wallet: s.wallet, kind: "shielded", amountZats: s.amount.toString(), zcashAddress: zcashByWallet.get(s.wallet) ?? null, flag: flagOf(s.wallet) });
    setRailCarry(s.wallet, "shielded", 0n);
  }
  for (const s of shieldedSplit.toCarry) setRailCarry(s.wallet, "shielded", s.amount);
  return { total: shieldedSplit.toSend.reduce((acc, s) => acc + s.amount, 0n), count: shieldedSplit.toSend.length };
}

/**
 * The most the holders' part of one swap may be, so that it plus the team's delivery reserve (deliveryReserve: the withdraw
 * fee, the Zcash fee for `count` recipients and reserveBps of the holders' part) stays inside the adapter's per-swap cap
 * (PAD_SWAP_MAX_ZATS). Shares above it are scaled down and the rest carries (audit S6, product decision 2), instead of the
 * adapter refusing the whole leg.
 */
export function shieldedSwapCap(count: number): bigint {
  const BPS = 10_000n;
  const fixed = config.epoch.team.withdrawFeeZats + zcashFeeEstimate(Math.max(count, 1), config.epoch.maxShieldedRecipientsPerTx);
  const room = config.near1click.maxSwapZats - fixed;
  if (room <= 0n) return 0n;
  // holders + ceil(holders * reserveBps / BPS) <= room  <=  holders <= room * BPS / (BPS + reserveBps), minus 1 for the ceiling
  const cap = (room * BPS) / (BPS + BigInt(config.epoch.team.reserveBps)) - 1n;
  return cap > 0n ? cap : 0n;
}

/**
 * Combines every coin's persisted shares into the epoch's payout plan, in one
 * DB transaction alongside the epoch leaving "harvesting" (finding 6): either
 * all of it lands (epoch totals, every payout row, every carry update) or
 * none of it does. Returns null if nothing was claimed this epoch (not recorded,
 * matching the existing "an epoch that claimed nothing" rule).
 */
function finalizeHarvest(epochId: string): EpochRow | null {
  const harvests = db.listEpochCoinHarvests(epochId);
  const totalZats = harvests.reduce((acc, h) => acc + BigInt(h.soldForZatsQuote), 0n);
  if (totalZats === 0n) return null;

  const mints = harvests.filter((h) => BigInt(h.soldForZatsQuote) > 0n).map((h) => h.mint);
  const combined = db.combineEpochCoinShares(epochId);
  // One snapshot of the opt-in registry, reused for both the membership test
  // and the address lookup, so they can never disagree with each other.
  const activeOptins = db.listActiveOptins();
  const optedInWallets = new Set(activeOptins.map((o) => o.wallet));
  const zcashByWallet = new Map(activeOptins.map((o) => [o.wallet, o.zcashAddress]));

  const creators = new Set(mints.map((m) => db.getCoin(m)?.creator).filter((c): c is string => !!c));

  const epoch = db.getEpoch(epochId)!;
  const teamGross = harvests.reduce((acc, h) => acc + BigInt(h.teamZats), 0n);
  return db.getDb().transaction(() => {
    db.upsertEpoch({ ...epoch, status: "ok", coinMints: JSON.stringify(mints), harvestedZats: totalZats.toString() });
    const shielded = planPayouts(epochId, combined, optedInWallets, zcashByWallet, creators, (epoch.includeShielded ?? 1) === 1);
    // The team puts its reserve into the swap so opted-in holders receive their full share (src/epoch/split.ts).
    const reserve = deliveryReserve({
      teamGross, shieldedTotal: shielded.total, shieldedCount: shielded.count,
      withdrawFeeZats: config.epoch.team.withdrawFeeZats, reserveBps: config.epoch.team.reserveBps,
      maxPerTx: config.epoch.maxShieldedRecipientsPerTx,
    });
    db.setEpochTeamSplit(epochId, teamGross, reserve);
    writeSnapshot(epochId, harvests, optedInWallets);
    return db.getEpoch(epochId)!;
  })();
}

/** The epoch's published snapshot (src/epoch/snapshotFile.ts), written with the plan and before any payout moves. */
function writeSnapshot(epochId: string, harvests: db.EpochCoinHarvestRow[], optedIn: Set<string>): void {
  const epoch = db.getEpoch(epochId)!;
  const sharesByMint = new Map<string, db.EpochCoinShareRow[]>();
  for (const r of db.listEpochCoinShares(epochId)) sharesByMint.set(r.mint, [...(sharesByMint.get(r.mint) ?? []), r]);
  const snapshot = buildSnapshot({
    epochId, at: epoch.at, network: config.mode, teamShareBps: config.epoch.team.shareBps,
    meteoraShareOfFeeBps: 10_000 - config.solana.dbc.holderShareBps,
    coins: harvests.filter((h) => BigInt(h.soldForZatsQuote) > 0n).map((h) => ({
      mint: h.mint, claimedZats: BigInt(h.soldForZatsQuote), teamZats: BigInt(h.teamZats),
      rows: (sharesByMint.get(h.mint) ?? []).map((r) => ({ wallet: r.wallet, weight: r.weightRaw === null ? null : BigInt(r.weightRaw), shareZats: BigInt(r.amountZats) })),
    })),
    shieldedWallets: optedIn,
    saltSecret: db.snapshotSaltSecret(),
  });
  const json = serializeSnapshot(snapshot);
  const shieldedHere = [...new Set([...sharesByMint.values()].flat().map((r) => r.wallet).filter((w) => optedIn.has(w)))];
  db.insertEpochSnapshot(epochId, json, snapshotSha256(json), shieldedHere);
}

/**
 * Resolves Solana batches (a "solana" payout, or a "shielded" one that fell back
 * to Solana) that were signed but not confirmed sent (finding 1, audit S2-01).
 * A batch is cleared for a fresh signature only once it provably can never
 * land; while its blockhash lives the SAME stored bytes are resent, so a
 * transaction still in flight is never joined by a second one for the same rows.
 */
async function resumePendingSolanaBatches(epochId: string, kind: db.PayoutKind, sentMarker: (sig: string) => string): Promise<void> {
  const groups = new Map<string, db.PayoutRow[]>();
  for (const p of db.getPendingPayouts(epochId, kind)) groups.set(p.sig!, [...(groups.get(p.sig!) ?? []), p]);

  for (const [sig, rows] of groups) {
    assertLockHeld(); // resolvePendingTx may resend the stored bytes: a pause stops that too
    const signed = rows[0]!;
    let outcome: "landed" | "dead" | "in_flight";
    if (signed.rawTx && signed.lastValidBlockHeight != null) {
      outcome = await resolvePendingTx(sig, new Uint8Array(Buffer.from(signed.rawTx, "base64")), signed.lastValidBlockHeight);
    } else {
      // No stored bytes (a row written before audit S2-01): there is no way to
      // prove it can never land, so it is left for a human, never resent.
      outcome = (await isSignatureLanded(sig)) ? "landed" : "in_flight";
      if (outcome === "in_flight") console.error(`payout batch ${sig} (${kind}) has no stored transaction; not resending it, needs a human`);
    }
    if (outcome === "landed") for (const r of rows) db.markPayoutSent(epochId, r.wallet, kind, sentMarker(sig));
    else if (outcome === "dead") for (const r of rows) db.clearPendingPayoutSig(epochId, r.wallet, kind);
  }
}

/** Records the rent the keeper paid for recipient accounts it created (audit S2-04). */
function recordFundedAccounts(wallets: string[], newAccounts: Map<string, string>): void {
  for (const w of wallets) {
    const ata = newAccounts.get(w);
    if (ata) db.recordKeeperFundedAta(ata, w);
  }
}

async function sendSolanaLeg(epochId: string): Promise<void> {
  await resumePendingSolanaBatches(epochId, "solana", (sig) => sig);
  const unsent = db.getFreshUnsentPayouts(epochId, "solana");
  if (unsent.length === 0) return;

  const { payable, deferred, newAccounts } = await applyAccountPolicy(unsent.map((p) => ({ wallet: p.wallet, amount: BigInt(p.amountZats) })));
  const { skipped: unsendable } = await sendSolanaZecPayouts(payable, {
    onPending: (wallets, sig, signed) => {
      assertLockHeld(); // fencing (audit S2-02): BEFORE this batch is recorded or broadcast
      for (const w of wallets) db.markPayoutPending(epochId, w, "solana", sig, signed);
    },
    onSent: (wallets, sig) => {
      for (const w of wallets) db.markPayoutSent(epochId, w, "solana", sig);
      recordFundedAccounts(wallets, newAccounts);
    },
  });
  // Never let one bad recipient halt the epoch (finding 3): carry it forward
  // instead, with the reason logged. A recipient with no ZEC account and a
  // share under the rent (plan 4 payout policy) is carried the same way.
  const skipped: SkippedRecipient[] = [...deferred, ...unsendable];
  for (const s of skipped) {
    console.error(`solana payout to ${s.wallet} skipped (${s.reason}); ${s.amount} zats carried to next epoch`);
    db.carryAndClosePayout(epochId, s.wallet, "solana", s.amount, `carried:${s.reason}`);
  }
}

/**
 * Puts the snapshot's sha256 on chain before the epoch pays. A memo that cannot be sent (RPC trouble) never stops the
 * payouts: it raises an alert and is retried on every run until it lands. A pause or a lost lock still stops it.
 */
async function writeSnapshotMemo(epochId: string): Promise<void> {
  try {
    await ensureSnapshotMemo(epochId, assertLockHeld);
    db.resolveAlerts("snapshot_memo", epochId);
  } catch (err) {
    if (err instanceof EpochLockLost || err instanceof PayoutsPaused) throw err;
    const detail = errorText(err);
    if (db.recordAlert("snapshot_memo", epochId, detail)) console.error(`ALERT epoch ${epochId}: snapshot memo not written yet, retrying on the next run: ${detail}`);
  }
}

/** One team payout row per epoch, planned once the epoch's delivery cost is known, for everything the team is owed and has not been sent. */
function planTeamPayout(epochId: string, wallet: string): void {
  if (db.getEpoch(epochId)!.teamSolanaZats == null) return; // the swap is still out: the reserve is not the team's to send yet
  if (db.getPayouts(epochId).some((p) => p.kind === "team")) return;
  const amount = db.teamSweepableZats();
  if (amount > 0n) db.planPayout({ epochId, wallet, kind: "team", amountZats: amount.toString(), flag: "team" });
}

/**
 * Sends the team's Solana ZEC to TEAM_WALLET, signed and recorded before it is broadcast like every other Solana
 * payout. Without TEAM_WALLET nothing is sent: the share stays in the keeper and GET /treasury says so.
 */
async function sendTeamLeg(epochId: string): Promise<void> {
  const wallet = config.epoch.team.wallet;
  if (!wallet) return;
  await resumePendingSolanaBatches(epochId, "team", (sig) => sig);
  planTeamPayout(epochId, wallet);
  const unsent = db.getFreshUnsentPayouts(epochId, "team");
  if (unsent.length === 0) return;
  const { skipped } = await sendSolanaZecPayouts(unsent.map((p) => ({ wallet: p.wallet, amount: BigInt(p.amountZats) })), {
    onPending: (wallets, sig, signed) => {
      assertLockHeld(); // fencing (audit S2-02): BEFORE this transfer is recorded or broadcast
      for (const w of wallets) db.markPayoutPending(epochId, w, "team", sig, signed);
    },
    onSent: (wallets, sig) => {
      for (const w of wallets) db.markPayoutSent(epochId, w, "team", sig);
    },
  });
  // A team wallet the payout code cannot address is closed as carried: the amount stays in the keeper and in the ledger.
  for (const s of skipped) {
    console.error(`team payout to ${s.wallet} skipped (${s.reason}); ${s.amount} zats stay in the keeper`);
    db.markPayoutSent(epochId, s.wallet, "team", `carried:${s.reason}`);
  }
}

/**
 * Progresses the epoch's swap-leg state machine one step. Never re-submits
 * once funds have moved (finding 2). `unsent` is the exact set of shielded
 * payout rows this swap covers: the FIRST time settlement is observed (the
 * only moment swapState moves to "settled"), those rows are repriced in the
 * same DB write from the harvested-input estimate to the swap's real output
 * minus the network fee, pro-rata (finding 7) -- so a later resume, which
 * would see a smaller/different `unsent` (some rows already sent), can never
 * re-run the repricing math against a stale, too-large `unsent` set.
 */
export type SwapOutcome = "settled" | "failed_before_funds_moved" | "returned_to_keeper" | "pending";

export async function progressSwap(epochId: string, unsent: db.PayoutRow[], swap: SwapAdapter): Promise<SwapOutcome> {
  let epoch = db.getEpoch(epochId)!;
  if (epoch.swapState === "settled") return "settled";
  if (epoch.swapState === "failed_before_funds_moved") return "failed_before_funds_moved";
  if (epoch.swapState === "returned_to_keeper") return "returned_to_keeper";

  if (epoch.swapState === "none") {
    assertLockHeld(); // fencing (audit S2-02): never start a swap after another run took the lock over
    const submitted = await submitOnce(epochId, unsent, swap);
    if (submitted.outcome === "not_attempted") return "pending"; // nothing signed, nothing decided: the swap stays unstarted and the next run tries again (audit S6-C1)
    if (submitted.outcome === "refused") {
      // Nothing moved. The shielded shares carry to the next shielded round (audit S6, product decision 2); the team's
      // reserve was never spent. Recorded in the same transaction as the state, so a crash cannot leave a row to pay twice.
      db.getDb().transaction(() => {
        db.upsertEpoch({ ...epoch, swapState: "failed_before_funds_moved" });
        resolveWithoutSwap(epoch);
        carryShieldedRows(epochId, db.getUnsentPayouts(epochId, "shielded"), "swap_refused");
        noteShieldedRoundCarried(epochId, "swap_refused", submitted.reason); // in the same transaction: the alert and the count never miss a carried round (nemesis NM-3)
      })();
      return "failed_before_funds_moved";
    }
    // Durable the instant submit() returns (or says funds may have moved), so
    // from here the epoch never falls back to Solana ZEC on a submit() outcome.
    db.upsertEpoch({ ...epoch, swapState: "submitted", swapRef: submitted.ref, swapProvider: swap.provider });
    epoch = db.getEpoch(epochId)!;
  }

  // swapState === "submitted": funds may have left the keeper. Only ever
  // resolve by polling status -- never fall back except on "returned".
  assertLockHeld(); // status() may rebroadcast the stored deposit: a paused keeper does not
  const settlement = await swap.status(epoch.swapRef!);
  if (settlement.note) console.error(`swap ${epoch.swapRef} waiting: ${settlement.note}`);
  if (settlement.status === "returned") {
    // Audit S3-01: a refund can come back short (1Click's refund fee). The team bears that first; holders the rest.
    const shieldedTotal = unsent.reduce((acc, p) => acc + BigInt(p.amountZats), 0n);
    const deposited = shieldedTotal + BigInt(epoch.deliveryReserveZats ?? "0");
    const back = settlement.amountReturnedZats;
    const short = back !== undefined && back < deposited ? deposited - back : 0n;
    const s = settleWithoutSwap(BigInt(epoch.teamGrossZats ?? "0"), short);
    const repriced = s.holderShortfall > 0n ? proRataSplit(shieldedTotal - s.holderShortfall, unsent.map((p) => ({ wallet: p.wallet, balance: BigInt(p.amountZats) }))) : [];
    // The keeper holds the ZEC again. The shares (repriced if the refund came back short) carry to the next shielded round
    // (audit S6, product decision 2): a provider that returned the money is not a reason to pay it on the public rail.
    db.getDb().transaction(() => {
      db.upsertEpoch({ ...epoch, swapState: "returned_to_keeper" });
      for (const r of repriced) db.setUnsentPayoutAmount(epochId, r.wallet, "shielded", r.amount);
      recordDelivery(epochId, s);
      carryShieldedRows(epochId, db.getUnsentPayouts(epochId, "shielded"), "swap_returned");
      noteShieldedRoundCarried(epochId, "swap_returned", `${swap.provider} returned the deposit${short > 0n ? ` short by ${short} zats` : ""}`);
    })();
    return "returned_to_keeper";
  }
  if (settlement.status !== "settled") return "pending";
  noteShieldedRoundSettled();

  const settledOutZats = settlement.amountOutZats!;
  // The Zcash fee estimate: see engine/README.md "Shielded network fee model". The team reserve in the swap covers
  // the delivery cost; holders bear only what the reserve does not (src/epoch/split.ts, rule 3).
  const settled = settleDelivery({
    teamGross: BigInt(epoch.teamGrossZats ?? "0"),
    reserve: BigInt(epoch.deliveryReserveZats ?? "0"),
    shieldedTotal: unsent.reduce((acc, p) => acc + BigInt(p.amountZats), 0n),
    settledOut: settledOutZats,
    networkFee: zcashFeeEstimate(unsent.length, config.epoch.maxShieldedRecipientsPerTx),
  });
  const repriced = proRataSplit(settled.paid, unsent.map((p) => ({ wallet: p.wallet, balance: BigInt(p.amountZats) })));
  db.getDb().transaction(() => {
    db.upsertEpoch({ ...epoch, swapState: "settled", swapAmountOutZats: settledOutZats.toString() });
    for (const r of repriced) db.setUnsentPayoutAmount(epochId, r.wallet, "shielded", r.amount);
    recordDelivery(epochId, settled);
  })();
  return "settled";
}

function recordDelivery(epochId: string, s: Settlement): void {
  db.resolveEpochDelivery(epochId, { deliveryCost: s.deliveryCost, teamNative: s.teamNative, teamSolana: s.teamSolana, holderShortfall: s.holderShortfall });
}

/** The swap did not run or was refunded: the reserve was never spent, the whole team share stays Solana ZEC. */
function resolveWithoutSwap(epoch: EpochRow): void {
  recordDelivery(epoch.id, settleWithoutSwap(BigInt(epoch.teamGrossZats ?? "0")));
}

type SubmitOutcome = { outcome: "submitted"; ref: string } | { outcome: "refused"; reason: string } | { outcome: "not_attempted" };

/**
 * Calls swap.submit once. "submitted" with the ref when a deposit exists or may exist (resolved, or SwapFundsMayHaveMoved),
 * "not_attempted" when the adapter could not try at all this run (SwapNotAttempted: a temporary failure, nothing signed,
 * retried next run), and "refused" ONLY when submit() rejected with a plain Error, which the adapter contract defines as
 * "nothing signed, the adapter decided" (the amount, the price, the provider's answer or the keeper's balance).
 */
async function submitOnce(epochId: string, unsent: db.PayoutRow[], swap: SwapAdapter): Promise<SubmitOutcome> {
  try {
    // The team's delivery reserve travels in the same swap as the holders' shielded total (src/epoch/split.ts).
    const reserve = BigInt(db.getEpoch(epochId)?.deliveryReserveZats ?? "0");
    const total = unsent.reduce((acc, p) => acc + BigInt(p.amountZats), 0n) + reserve;
    return { outcome: "submitted", ref: (await swap.submit(total, epochId)).ref };
  } catch (err) {
    if (err instanceof SwapFundsMayHaveMoved) {
      console.error(`swap submit for ${epochId} is unresolved, polling instead of falling back: ${err.message}`);
      return { outcome: "submitted", ref: err.ref };
    }
    if (err instanceof SwapNotAttempted) {
      console.error(`swap submit for ${epochId} could not be attempted this run (nothing signed, no fallback); the next run tries again: ${err.message}`);
      return { outcome: "not_attempted" };
    }
    const reason = (err as Error)?.message ?? String(err);
    console.error(`swap submit for ${epochId} refused before any deposit was signed; the shielded shares carry to the next shielded round: ${reason}`);
    return { outcome: "refused", reason };
  }
}

/**
 * Audit S6, product decision 2: a shielded share is never paid on the public rail because of a price, a cap or a provider.
 * The rows of a swap refused before any deposit, or refunded after one, carry to the next shielded round; the carry is
 * Solana ZEC the keeper already holds, shown to the holder as pending on the opt-in page. The holder's own exit is
 * switching shielded delivery off, after which the next round plans the carry on the public rail.
 */
function carryShieldedRows(epochId: string, rows: { wallet: string; amountZats: string }[], why: "swap_refused" | "swap_returned"): void {
  for (const r of rows) db.carryAndClosePayout(epochId, r.wallet, "shielded", BigInt(r.amountZats), `carried:${why}`);
}

const SHIELDED_CARRIED_ROUNDS_META = "shielded_carried_rounds";
/** After this many shielded rounds in a row that carried every share, the operator is told (product decision 2): the holders are waiting on something that is not clearing. */
export const SHIELDED_CARRIED_ROUNDS_ALERT_AT = 3;

function noteShieldedRoundCarried(epochId: string, why: "swap_refused" | "swap_returned", reason: string): void {
  const rounds = Number(db.getMeta(SHIELDED_CARRIED_ROUNDS_META) ?? "0") + 1;
  db.setMeta(SHIELDED_CARRIED_ROUNDS_META, String(rounds));
  const detail = redactZcashAddresses(redactSecrets(`${why}: ${reason}`)).slice(0, 400); // a refused quote names the treasury's address: shortened before the alert leaves the keeper
  if (db.recordAlert("swap_refused", epochId, detail)) console.error(`ALERT epoch ${epochId}: every shielded share carried to the next shielded round (${detail})`);
  if (rounds >= SHIELDED_CARRIED_ROUNDS_ALERT_AT) {
    const message = `${rounds} shielded rounds in a row carried every shielded share; opted-in holders have waited since the last settled swap (last: ${detail})`;
    if (db.recordAlert("shielded_carried_rounds", "", message)) console.error(`ALERT ${message}`);
  }
}

function noteShieldedRoundSettled(): void {
  db.setMeta(SHIELDED_CARRIED_ROUNDS_META, "0");
  db.resolveAlerts("shielded_carried_rounds", "");
  db.resolveAlertsOfKind("swap_refused"); // the carried shares of the refused rounds are in this settled swap: those alerts are over (nemesis NM-3)
}

/**
 * Resumes any shielded payout that was recorded pending but never confirmed
 * sent (finding 1). A "shielded"-kind payout is sent through exactly one
 * mechanism per epoch, decided once and never revisited (progressSwap's state
 * machine only ever moves swapState forward): once "settled" it is always a
 * Zcash devtool txid; once "failed_before_funds_moved" or "returned_to_keeper" it is always a Solana
 * fallback signature. epoch.swapState (not the payout row itself) is what
 * tells resume which chain-status check applies.
 */
async function resumePendingShieldedPayouts(epochId: string, ctx: RunContext): Promise<void> {
  const pending = db.getPendingPayouts(epochId, "shielded");
  if (pending.length === 0) return;
  const walletsBySig = new Map<string, string[]>();
  for (const p of pending) walletsBySig.set(p.sig!, [...(walletsBySig.get(p.sig!) ?? []), p.wallet]);

  const epoch = db.getEpoch(epochId)!;
  if (epoch.swapState === "failed_before_funds_moved" || epoch.swapState === "returned_to_keeper") {
    await resumePendingSolanaBatches(epochId, "shielded", (sig) => `fallback_solana:${sig}`);
    return;
  }
  if (epoch.swapState === "settled") {
    if (pending.some((p) => p.sig!.startsWith(ZCASH_INTENT))) {
      if (!(await resolveShieldedIntents(epochId, pending.filter((p) => p.sig!.startsWith(ZCASH_INTENT))))) return;
      return resumePendingShieldedPayouts(epochId, ctx); // the intents are now a txid (pending) or fresh again
    }
    // Every mode (audit S6-B1: outside regtest a row left pending with a txid, by the intent recovery above or a keeper
    // killed between the broadcast and its "sent" mark, was never resolved; the epoch stayed unfinished, was parked, and
    // its amount counted as owed from the treasury until no new epoch could start). The status comes from the chain on
    // regtest and from the treasury wallet's own record of what it built and saw mined elsewhere (ctx.shieldedTxStatus).
    for (const [txid, wallets] of walletsBySig) {
      const status = await ctx.shieldedTxStatus(txid);
      if (status === "mined") {
        for (const w of wallets) db.markPayoutSent(epochId, w, "shielded", txid);
      } else if (status === "unknown" || status === "expired") {
        // The node (regtest) or the treasury wallet (after a sync) has never seen this txid: the crash came before the
        // broadcast reached anywhere, or the chain was reset. Or (audit S6-B1 residual) the wallet has synced past the
        // transaction's expiry height without seeing it mined: by ZIP 203 no block can include it now. Safe to clear and resend.
        if (status === "expired") console.error(`shielded payout tx ${txid} expired unmined; its ${wallets.length} rows are sent again`);
        for (const w of wallets) db.clearPendingPayoutSig(epochId, w, "shielded");
      }
      // "mempool": leave it pending, no action -- it confirms on its own on
      // the next mined block; resending would double-pay.
    }
  }
}

export type ShieldedTxStatus = "mined" | "mempool" | "unknown" | "expired";

/** Local mode: the regtest node's view; a transaction found waiting is mined here, as sendZcashPayouts does (regtest has no miner of its own). */
async function regtestShieldedTxStatus(txid: string): Promise<ShieldedTxStatus> {
  const { zcashTxStatus, mineBlocks } = await import("../zcash/regtest");
  let status = await zcashTxStatus(txid);
  if (status === "mempool") {
    await mineBlocks(10);
    status = await zcashTxStatus(txid);
  }
  return status;
}

/** Outside local mode: what the treasury wallet, synced first, records about a transaction it built (zcash-devtool list-tx "Mined:"). */
async function treasuryShieldedTxStatus(txid: string): Promise<ShieldedTxStatus> {
  const { sentTxStatus, syncWallet } = await import("../zcash/devtool");
  const { dir } = await treasuryWallet();
  syncWallet(dir);
  return sentTxStatus(dir, txid);
}

/** Marks Zcash payout rows whose chunk was handed to devtool, before it runs (audit O-4). Never a txid. */
const ZCASH_INTENT = "zcash-intent:";

/**
 * Rows a dead run handed to devtool (audit O-4): devtool broadcasts inside `pay` and outlives a killed keeper. While a
 * devtool `pay` on the treasury still runs, nothing is decided (returns false). Otherwise the treasury wallet's own
 * transaction list says what it built: a row it paid gets that txid (pending, resolved like any sent chunk), a row it
 * never paid becomes fresh again and is sent once.
 */
async function resolveShieldedIntents(epochId: string, rows: db.PayoutRow[]): Promise<boolean> {
  const treasury = await treasuryWallet();
  const { findSentPayment, payRunningFor, syncWallet } = await import("../zcash/devtool");
  if (payRunningFor(treasury.dir)) {
    console.error(`epoch ${epochId}: a zcash-devtool pay from an earlier run is still running on the treasury; deciding its rows on the next run`);
    return false;
  }
  syncWallet(treasury.dir);
  for (const p of rows) {
    const txid = p.zcashAddress ? findSentPayment(treasury.dir, p.zcashAddress, BigInt(p.amountZats), rewardMemo(epochId)) : null;
    if (txid) db.markPayoutPending(epochId, p.wallet, "shielded", txid);
    else db.clearPendingPayoutSig(epochId, p.wallet, "shielded");
  }
  return true;
}

/** Runs the shielded leg. Falls back every opted-in holder to Solana ZEC only if the swap failed before any funds moved. */
async function sendShieldedLeg(epochId: string, swap: SwapAdapter, ctx: RunContext): Promise<"ok" | "pending"> {
  await resumePendingShieldedPayouts(epochId, ctx);
  const unsent = db.getUnsentPayouts(epochId, "shielded"); // includes any still-pending (chain-status ambiguous) rows
  if (unsent.length === 0) return "ok";

  const swapOutcome = await progressSwap(epochId, unsent, swap);

  if (swapOutcome === "pending") return "pending"; // resume later; never resend, never fall back mid-flight

  // A swap refused before any deposit, or refunded after one, carried every row inside progressSwap's own state change
  // (audit S6, product decision 2): nothing is paid on the public rail, nothing is left unsent, the leg is done.
  if (swapOutcome === "failed_before_funds_moved" || swapOutcome === "returned_to_keeper") {
    // An epoch that reached this state before the carry rule (nemesis NM-2) may still hold rows the old public fallback was to
    // pay: a fresh one carries by the same rule; a pending one (a fallback transaction in flight) is decided by the resume above.
    const fresh = db.getFreshUnsentPayouts(epochId, "shielded");
    if (fresh.length > 0) {
      db.getDb().transaction(() => carryShieldedRows(epochId, fresh, swapOutcome === "returned_to_keeper" ? "swap_returned" : "swap_refused"))();
      console.error(`epoch ${epochId}: ${fresh.length} shielded rows left by the old public fallback carried to the next shielded round`);
    }
    return db.getPendingPayouts(epochId, "shielded").length > 0 ? "pending" : "ok";
  }

  // settled: progressSwap already repriced every row this settlement covers
  // (finding 7) -- send exactly what those rows now say, never recompute the
  // split again here (a later resume would see a smaller, already-partially-
  // sent `fresh` set and must not re-split the same settled total against it).
  const fresh = db.getFreshUnsentPayouts(epochId, "shielded");
  // A holder whose repriced share rounded to 0 (a very small original stake,
  // repriced against a settlement smaller than the harvested-input estimate)
  // has nothing left to send: resolve their row so it doesn't loop forever,
  // without asking devtool to build a 0-amount payment.
  for (const p of fresh.filter((p) => BigInt(p.amountZats) <= 0n)) {
    console.error(`shielded payout to ${p.wallet} rounded to 0 after repricing; nothing sent this epoch`);
    db.markPayoutSent(epochId, p.wallet, "shielded", "zero_after_fee");
  }
  const payable = fresh.filter((p) => BigInt(p.amountZats) > 0n);
  const optins = new Map(db.listActiveOptins().map((o) => [o.wallet, o.zcashAddress]));
  const treasury = await treasuryWallet();
  const targets = payable.map((p) => ({
    wallet: p.wallet,
    // The snapshot taken at planning time (finding 4) is authoritative, never
    // a live re-read of the opt-in registry: an opt-out between planning and
    // sending must not change where an already-planned payout goes. Falls
    // back to the live registry only for pre-finding-4 rows that predate the
    // zcashAddress column (defensive; should not happen on a fresh DB).
    zcashAddress: p.zcashAddress ?? optins.get(p.wallet)!,
    amount: BigInt(p.amountZats),
    memo: rewardMemo(epochId), // every shielded reward note says what it is
  }));
  const { perWallet, feeZats } = await sendZcashPayouts(targets, treasury.dir, treasury.identity, {
    beforeChunk: () => assertLockHeld(), // fencing (audit S2-02): devtool broadcasts inside pay, so check BEFORE it
    onIntent: (wallets) => {
      for (const w of wallets) db.markPayoutPending(epochId, w, "shielded", `${ZCASH_INTENT}${new Date().toISOString()}`);
    },
    onPending: (wallets, txid) => {
      for (const w of wallets) db.markPayoutPending(epochId, w, "shielded", txid);
    },
    onSent: (wallets, txid) => {
      for (const w of wallets) db.markPayoutSent(epochId, w, "shielded", txid);
    },
  });
  if (perWallet.size > 0) {
    const e = db.getEpoch(epochId)!;
    db.upsertEpoch({ ...e, feeZats: (BigInt(e.feeZats) + feeZats).toString() });
  }
  // A row still pending (its transaction is known but not yet mined, audit S6-B1) means the leg is not finished: the
  // epoch is recorded partial and the next run looks at that transaction again. Nothing is resent.
  return db.getPendingPayouts(epochId, "shielded").length > 0 ? "pending" : "ok";
}

/**
 * The Zcash wallet the shielded leg pays from (audit S2-05): the regtest
 * treasury locally; outside local mode the SAME wallet the swap delivers into
 * (TREASURY_WALLET_DIR, which scripts/epoch.ts checks owns the treasury
 * address) with its age identity file. Never the regtest path on a real network.
 */
export async function treasuryWallet(): Promise<{ dir: string; identity: string }> {
  if (config.isLocal) {
    const { TREASURY_DIR, TREASURY_IDENTITY } = await import("../zcash/regtest");
    return { dir: TREASURY_DIR, identity: TREASURY_IDENTITY };
  }
  const dir = config.near1click.treasuryWalletDir;
  const identity = config.near1click.treasuryIdentityFile;
  if (!dir || !identity) throw new Error("the shielded leg needs TREASURY_WALLET_DIR and TREASURY_IDENTITY_FILE outside local mode; nothing was sent");
  return { dir, identity };
}

const EPOCH_LOCK_NAME = "epoch";

/** Thrown at a fencing point once another run has taken the epoch lock over: this run must not move funds. */
export class EpochLockLost extends Error {}

// The current run's fencing check (audit S2-02). Per async context, so two runs
// in one process (tests) each check their own holder.
const lockFence = new AsyncLocalStorage<() => void>();

/** Refreshes this run's lock, throws EpochLockLost if another run holds it now, and PayoutsPaused if payouts are paused or a stop was requested. */
export function assertLockHeld(): void {
  lockFence.getStore()?.();
  assertNotPaused(); // the kill switch and a graceful stop are checked at every point that is about to move money
}

/** The claim phase of an epoch; injectable so tests can drive the gate without a chain. */
export type ClaimStep = (epochId: string) => Promise<void>;

/** Per-run settings; every field has a default, tests and the keeper override them. */
export interface RunOptions {
  /** Whether a NEW epoch also runs the shielded leg (plan 4b: weekly). Default true; a resumed epoch keeps what it was created with. */
  includeShielded?: boolean;
  /** How the isolation of parked epochs is proven (audit O-2); defaults to reading the chain and the treasury wallet. */
  isolation?: IsolationDeps;
  nowMs?: () => number;
  /** The network fee of one of the epoch's Zcash payout txs. Defaults to the treasury wallet's own record outside local mode; local mode already counts fees as it sends. */
  zcashFeeZats?: (txid: string) => Promise<bigint>;
  /** Whether a shielded payout transaction left pending by an earlier run is mined, waiting, or unknown (audit S6-B1). Defaults to the regtest node locally, the treasury wallet's record elsewhere. */
  shieldedTxStatus?: (txid: string) => Promise<ShieldedTxStatus>;
}

interface RunContext {
  includeShielded: boolean;
  isolation: IsolationDeps;
  nowMs: () => number;
  zcashFeeZats?: (txid: string) => Promise<bigint>;
  shieldedTxStatus: (txid: string) => Promise<ShieldedTxStatus>;
}

/** Local mode: the fee of a payout tx, read from the regtest node. */
async function regtestTxFeeZats(txid: string): Promise<bigint> {
  const { shieldedTxFeeZats } = await import("../zcash/regtest");
  return shieldedTxFeeZats(txid);
}

/** Outside local mode: the fee the treasury wallet recorded for a payout tx it sent (zcash-devtool list-tx). */
async function treasuryTxFeeZats(txid: string): Promise<bigint> {
  const { txFeeZats } = await import("../zcash/devtool");
  return txFeeZats((await treasuryWallet()).dir, txid);
}

const errorText = (err: unknown): string => redactSecrets(String((err as Error)?.message ?? err)).slice(0, 300);

/**
 * Counts one run that ended with `epochId` unfinished and parks it once it is stuck (audit O-2): too many runs
 * or too old. Parked, it keeps its unsent rows (still owed and counted) and is still progressed on every run,
 * but no longer blocks later epochs. An alert is recorded once.
 */
function recordUnfinishedRun(epochId: string, ctx: RunContext, lastError?: string): boolean {
  db.bumpEpochAttempts(epochId);
  const reason = stuckReason(db.getEpoch(epochId)!, ctx.nowMs());
  if (!reason) return false;
  const detail = lastError ? `${reason}; last error: ${lastError}` : reason;
  db.parkEpoch(epochId, detail);
  if (db.recordAlert("epoch_parked", epochId, detail)) {
    console.error(`ALERT epoch ${epochId} parked (needs_attention): ${detail}. Its payouts stay owed; later epochs run only while the money is provably separate.`);
  }
  return true;
}

/** Parked epochs are progressed on every run (a refund, a confirmation or a human fix can finish them). They never block. */
async function progressParkedEpochs(swap: SwapAdapter, ctx: RunContext): Promise<void> {
  for (const parked of db.listParkedEpochs()) {
    if (!db.epochHasUnsentPayouts(parked.id)) {
      db.unparkEpoch(parked.id, "ok");
      db.resolveAlerts("epoch_parked", parked.id);
      continue;
    }
    await runLegs(parked, swap, ctx, true);
  }
}

/** Both payout legs of an epoch, then its status, and the stuck bookkeeping. */
async function runLegs(epoch: EpochRow, swap: SwapAdapter, ctx: RunContext, wasParked: boolean): Promise<EpochOutcome> {
  let shieldedStatus: "ok" | "fallback_solana" | "pending";
  try {
    await writeSnapshotMemo(epoch.id);
    await sendSolanaLeg(epoch.id);
    shieldedStatus = await sendShieldedLeg(epoch.id, swap, ctx);
    if (shieldedStatus !== "pending") await sendTeamLeg(epoch.id); // the delivery cost is known only once the swap is resolved
  } catch (err) {
    if (err instanceof EpochLockLost || err instanceof PayoutsPaused) throw err;
    if (wasParked) {
      console.error(`parked epoch ${epoch.id} could not progress: ${errorText(err)}`);
      return { epoch: db.getEpoch(epoch.id)! };
    }
    if (recordUnfinishedRun(epoch.id, ctx, errorText(err))) return { epoch: db.getEpoch(epoch.id)! };
    throw err;
  }
  await recordLegsResult(epoch.id, shieldedStatus, ctx, wasParked);
  return { epoch: db.getEpoch(epoch.id)! };
}

/** The epoch's status and Zcash txids after its legs ran; parks it, or un-parks a parked one that finished. */
async function recordLegsResult(epochId: string, shieldedStatus: "ok" | "pending", ctx: RunContext, wasParked: boolean): Promise<void> {
  const finalEpoch = db.getEpoch(epochId)!;
  // A real Zcash txid is always 64 lowercase hex chars (same check
  // src/zcash/devtool.ts's payBatch applies to its own output): matching that
  // shape, rather than denylisting every non-txid marker this file uses
  // ("fallback_solana:...", "carried:...", "zero_after_fee"), is what keeps
  // this correct as new markers are added.
  const zcashTxids = [
    ...new Set(
      db
        .getPayouts(epochId)
        .filter((p) => p.kind === "shielded" && p.sentAt)
        .map((p) => p.sig)
        .filter((s): s is string => !!s && /^[0-9a-f]{64}$/.test(s)),
    ),
  ];
  const unfinished = db.epochHasUnsentPayouts(epochId);
  // A leg that finished ends an earlier run's "partial" (swap was pending then) too, not only a parked epoch.
  const carried = finalEpoch.status === "needs_attention" || finalEpoch.status === "partial" ? "ok" : finalEpoch.status;
  // "fallback_solana" is no longer produced (audit S6, product decision 2); rows and epochs that carry it from before stay as they are.
  const status = shieldedStatus === "pending" ? "partial" : carried;
  const feeZats = await epochZcashFees(finalEpoch, zcashTxids, ctx);
  db.upsertEpoch({ ...finalEpoch, feeZats, status: wasParked && unfinished ? "needs_attention" : status, zcashTxids: JSON.stringify(zcashTxids) });
  if (wasParked && !unfinished) {
    db.unparkEpoch(epochId, status as Exclude<typeof status, "needs_attention" | "harvesting">);
    db.resolveAlerts("epoch_parked", epochId);
  } else if (!wasParked && unfinished) {
    recordUnfinishedRun(epochId, ctx);
  }
}

/**
 * The epoch's Zcash network fees: the sum over its distinct sent txids, read from the wallet that paid them (from the
 * regtest node locally): set, not added, so a resume never counts a tx twice nor misses one an earlier run sent.
 * The fee is reporting only (the API's feeZats): a wallet that cannot say it raises an alert and keeps the stored
 * value, it never stops the epoch's status and txids from being recorded after the money already moved.
 */
async function epochZcashFees(epoch: EpochRow, zcashTxids: string[], ctx: RunContext): Promise<string> {
  if (!ctx.zcashFeeZats || zcashTxids.length === 0) return epoch.feeZats;
  try {
    let total = 0n;
    for (const txid of zcashTxids) total += await ctx.zcashFeeZats(txid);
    db.resolveAlerts("epoch_fee_unread", epoch.id);
    return total.toString();
  } catch (err) {
    const detail = errorText(err);
    if (db.recordAlert("epoch_fee_unread", epoch.id, detail)) console.error(`ALERT epoch ${epoch.id}: network fee not read, feeZats left at ${epoch.feeZats}: ${detail}`);
    return epoch.feeZats;
  }
}

async function runEpochLocked(swap: SwapAdapter, claimStep: ClaimStep, ctx: RunContext): Promise<EpochOutcome> {
  for (const id of db.listSnapshotsAwaitingMemo()) await writeSnapshotMemo(id); // a memo that failed after its epoch finished is still owed
  await progressParkedEpochs(swap, ctx);
  let epoch = db.findDraftEpoch() ?? db.findResumableSentEpoch();
  if (!epoch) {
    // A new epoch starts only if every parked epoch's money is provably separate from it (audit O-2).
    const problems = await isolationProblems(ctx.isolation);
    if (problems.length > 0) {
      if (db.recordAlert("epochs_halted", "", problems.join("; "))) console.error(`ALERT no new epoch started: ${problems.join("; ")}`);
      return { epoch: null, halted: problems };
    }
    db.resolveAlerts("epochs_halted", "");
    epoch = createDraftEpoch(ctx.includeShielded);
  }

  if (epoch.status === "harvesting") {
    await claimStep(epoch.id);
    // A claim that is signed but unconfirmed, or waiting for an approval, may
    // already have moved ZEC the DB has not seen: finalizing now (or discarding
    // the draft as "nothing claimed") would orphan it. Wait; the next run resumes.
    const unconfirmed = db.listUnconfirmedClaims(epoch.id);
    // Audit S6-A1: a claim that landed and was measured, for a coin that has no harvest row yet (its next claim kind threw
    // after it, say an RPC error reading the surplus), holds ZEC that no share explains. Finalizing or discarding now would
    // attribute it to nothing for good (the next epoch's claim key is new), so the draft waits and the coin is retried.
    const measured = db.listMeasuredClaimsWithoutHarvest(epoch.id);
    // Loud, not only in the run's output: a coin that stays in this state (its next claim read failing run after run) holds every
    // later round, so the alert reaches the operator (Telegram through the keeper's alert line) once, and resolves when it clears.
    if (measured.length > 0) {
      const detail = measured.map((c) => `${c.kind} claim for ${c.mint} measured ${c.amountZats} zats but the coin is not attributed yet`).join("; ");
      if (db.recordAlert("claim_unattributed", epoch.id, detail)) console.error(`ALERT epoch ${epoch.id}: ${detail}; the draft waits and the coin is retried every run`);
    } else {
      db.resolveAlerts("claim_unattributed", epoch.id);
    }
    if (unconfirmed.length > 0 || measured.length > 0) {
      return {
        epoch: null,
        awaitingClaims: [
          ...unconfirmed.map((c) => `${c.kind} claim for ${c.mint} (${c.phase})`),
          ...measured.map((c) => `${c.kind} claim for ${c.mint} (measured ${c.amountZats} zats, coin not yet attributed: its claim step is retried)`),
        ],
      };
    }
    releaseStaleOrphans(epoch.id);
    const finalized = finalizeHarvest(epoch.id);
    if (!finalized) {
      // Nothing claimed means nothing to pay: discard the draft rather than
      // recording a "claimed 0 from 0 coins" row on the public treasury page.
      discardEmptyDraft(epoch.id);
      return { epoch: null };
    }
    epoch = finalized;
  }

  return runLegs(epoch, swap, ctx, false);
}

function createDraftEpoch(includeShielded: boolean): EpochRow {
  const epoch: EpochRow = {
    id: `epoch-${Date.now()}`,
    at: new Date().toISOString(),
    coinMints: "[]",
    harvestedZats: "0",
    feeZats: "0",
    status: "harvesting",
    swapProvider: null,
    swapRef: null,
    swapState: "none",
    swapAmountOutZats: null,
    zcashTxids: "[]",
    includeShielded: includeShielded ? 1 : 0,
  };
  db.upsertEpoch(epoch);
  return epoch;
}

/**
 * Runs (or resumes) one epoch. Only one caller proceeds at a time (finding
 * 5): a DB-backed exclusive lock guards the whole run, with a stale-lock
 * takeover if a prior run crashed without releasing it
 * (config.epoch.lockStaleMs). Paused payouts (src/pause.ts) stop it before the
 * lock is taken, or at the next safe point if the switch is thrown mid-run.
 */
export async function runEpoch(swap: SwapAdapter, claimStep: ClaimStep = claimRemainingCoins, options: RunOptions = {}): Promise<EpochOutcome> {
  const halt = haltReason();
  if (halt) return { epoch: null, paused: new PayoutsPaused(halt).message };
  const holder = `${process.pid}:${crypto.randomUUID()}`;
  if (!db.tryAcquireLock(EPOCH_LOCK_NAME, holder, config.epoch.lockStaleMs)) {
    throw new Error("another epoch run holds the lock (or a stale one has not yet timed out); try again shortly");
  }
  const fence = () => {
    if (!db.refreshLock(EPOCH_LOCK_NAME, holder)) throw new EpochLockLost(`epoch lock was taken over by another run; ${holder} stops before moving funds`);
  };
  const ctx: RunContext = {
    includeShielded: options.includeShielded ?? true,
    isolation: options.isolation ?? chainIsolationDeps,
    nowMs: options.nowMs ?? Date.now,
    // Both modes: the fee is the sum over every txid the epoch sent, read back, so chunks sent by an earlier run that died
    // count too (stress chaos round 7, D8: a local run used to add up only its own chunks).
    zcashFeeZats: options.zcashFeeZats ?? (config.isLocal ? regtestTxFeeZats : treasuryTxFeeZats),
    shieldedTxStatus: options.shieldedTxStatus ?? (config.isLocal ? regtestShieldedTxStatus : treasuryShieldedTxStatus),
  };
  try {
    return await lockFence.run(fence, () => runEpochLocked(swap, claimStep, ctx));
  } catch (err) {
    if (err instanceof PayoutsPaused) return { epoch: null, paused: err.message };
    throw err;
  } finally {
    db.releaseLock(EPOCH_LOCK_NAME, holder);
  }
}
