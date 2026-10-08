// What one wallet was paid, and a check that a shielded note is the pad's docs/API.md v2.6, "Rewards of one wallet, and the memo check"; v2.9 "Signed
// reads"). The public answer holds a wallet's Solana-rail payouts only. A shielded share that fell back to Solana ZEC, because the shielded batch could not run, is
// not one of them: it is the holder's own (ShieldedRewards.fallback), since listing it publicly would show which wallets opted in. Anything about the shielded rail
// is the wallet's own business: `shieldedRewardsOf` (the rounds that paid it, their salted commitments and its fallback payouts) is given only to a request that
// carries the wallet's fresh signature (optin/registry.ts readOptinStatus), and nothing public says whether a wallet opted in. An amount, a salt or a Zcash address
// is never in any answer to a stranger: opening a row takes the same signed proof as GET /epochs/:id/receipt, and the memo check only returns a wallet's own rows
// to that wallet's proof.
// Read-only; no keeper key (INV-17).
import * as db from "./db";
import { payoutRail, railSig, snapshotSummary, summarizePayouts } from "./epoch/publicView";
import { openReceipt, walletRows, wasShieldedIn } from "./epoch/receipt";
import type { Snapshot } from "./epoch/snapshotFile";
import { rewardMemo } from "./zcash/devtool";

export const REWARDS_DEFAULT_LIMIT = 50;
export const REWARDS_MAX_LIMIT = 200;
/** How many shielded rounds are listed (the count covers all of them). */
export const SHIELDED_ROUNDS_LISTED = 100;

export interface SolanaPayout {
  epochId: string;
  at: string;
  sig: string;
  zats: string;
  coins: { mint: string; shareZats: string }[];
}

export interface ShieldedRound {
  epochId: string;
  at: string;
  snapshotSha256: string | null;
  commitments: string[];
}

/** Payouts on the Solana rail: how many there were (all of them), what they came to, and the page asked for. */
export interface SolanaPayouts {
  count: number;
  totalZats: string;
  payouts: SolanaPayout[];
}

export interface RewardsView {
  wallet: string;
  solana: SolanaPayouts;
  memoFormat: string;
}

/**
 * A wallet's shielded rounds (v2.9: given only after its signature). `rounds` counts the rounds a real shielded transaction paid it, `commitments` lists the newest
 * SHIELDED_ROUNDS_LISTED. `fallback` is its shielded share paid as Solana ZEC in a round when the shielded batch could not run: the money moved on the Solana rail, but
 * the share is a shielded holder's, and a public answer listing it would show which wallets had opted in, so it is the wallet's own to see.
 */
export interface ShieldedRewards {
  rounds: number;
  commitments: ShieldedRound[];
  fallback: SolanaPayouts;
}

/** Newest first: by the time the row was sent, then by epoch id so the order is total. */
const newestFirst = (a: db.PayoutRow, b: db.PayoutRow): number => ((b.sentAt ?? "") < (a.sentAt ?? "") ? -1 : (b.sentAt ?? "") > (a.sentAt ?? "") ? 1 : a.epochId < b.epochId ? 1 : -1);

/** When a round ran; a row whose epoch is gone (not expected) falls back to the time it was sent. */
const roundTime = (p: db.PayoutRow): string => db.getEpoch(p.epochId)?.at ?? p.sentAt ?? "";

/** A shielded-kind payout that fell back to Solana ZEC: it moved over the Solana rail, but it is a shielded holder's share (see ShieldedRewards.fallback). */
const isFallback = (p: db.PayoutRow): boolean => p.kind === "shielded" && payoutRail(p) === "solana";

/** The rows as a list on the Solana rail: every row is counted and added up, the page is listed with each coin's share from the published snapshot. */
function payoutList(wallet: string, rows: db.PayoutRow[], page: { limit: number; offset: number }): SolanaPayouts {
  return {
    count: rows.length,
    totalZats: rows.reduce((sum, p) => sum + BigInt(p.amountZats), 0n).toString(),
    payouts: rows.slice(page.offset, page.offset + page.limit).map((p) => ({
      epochId: p.epochId, at: roundTime(p), sig: railSig(p), zats: p.amountZats,
      coins: db.listEpochCoinSharesOfWallet(p.epochId, wallet).map((r) => ({ mint: r.mint, shareZats: r.amountZats })),
    })),
  };
}

export function rewardsOf(wallet: string, page: { limit: number; offset: number }): RewardsView {
  const solana = db.listPayoutsOfWallet(wallet).filter((p) => payoutRail(p) === "solana" && !isFallback(p)).sort(newestFirst);
  return { wallet, solana: payoutList(wallet, solana, page), memoFormat: rewardMemo("<epochId>") };
}

/** The rounds in which a real shielded transaction was sent for this wallet, and the ones that paid its shielded share on Solana. Never call this for a request that has not proved it owns `wallet`. */
export function shieldedRewardsOf(wallet: string): ShieldedRewards {
  const all = db.listPayoutsOfWallet(wallet);
  const shielded = all.filter((p) => payoutRail(p) === "shielded").sort(newestFirst);
  const fallback = all.filter(isFallback).sort(newestFirst);
  return {
    fallback: payoutList(wallet, fallback, { limit: SHIELDED_ROUNDS_LISTED, offset: 0 }),
    rounds: shielded.length,
    commitments: shielded.slice(0, SHIELDED_ROUNDS_LISTED).map((p) => ({
      epochId: p.epochId, at: roundTime(p), snapshotSha256: db.getEpochSnapshot(p.epochId)?.sha256 ?? null,
      commitments: wasShieldedIn(p.epochId, wallet) ? walletRows(p.epochId, wallet).map((r) => r.commitment) : [],
    })),
  };
}

// ---- the memo check ----

/** The longest memo a Zcash note can carry (ZIP 302). */
export const MEMO_MAX_BYTES = 512;
const MEMO_FORMAT = /^SNARKS pad reward, epoch ([A-Za-z0-9._-]{1,64})$/;

export interface MemoProof {
  wallet: string;
  nonce: string;
  signature: string;
}

export interface MemoCheck {
  epochId: string | null;
  matches: boolean;
  coins: { mint: string; symbol: string }[];
  checks: { memo: boolean; txid: boolean | null; commitment: boolean | null };
  round: {
    at: string;
    status: string;
    shielded: { count: number; totalZats: string };
    zcashTxids: string[];
    snapshot: { sha256: string; memoSig: string | null; url: string } | null;
  } | null;
  rows?: { mint: string; shareZats: string; commitment: string }[];
}

export type MemoCheckResult = { ok: true; check: MemoCheck } | { ok: false; error: "invalid_signature" | "stale_nonce" };

const NOT_OURS: MemoCheck = { epochId: null, matches: false, coins: [], checks: { memo: false, txid: false, commitment: false }, round: null };

/** The commitments the published snapshot lists, all coins together. */
function publishedCommitments(epochId: string): Set<string> {
  const snap = db.getEpochSnapshot(epochId);
  if (!snap) return new Set();
  const file = JSON.parse(snap.json) as Snapshot;
  return new Set(file.coins.flatMap((c) => c.shielded.commitments));
}

/**
 * Checks a memo a holder saw on a note. The memo carries no wallet and no coin, so on its own it proves only what it names: that the
 * text is exactly what the pad writes for a published round that really paid a shielded batch (`checks.memo`), with that round's
 * public numbers. `txid` (what the wallet shows) adds whether the note's transaction is one of the round's batch (public ids). A
 * signed `proof` (same scheme and nonce as the receipt) adds the wallet's OWN rows of the round and whether each is in the published
 * commitments; nobody else is ever given a row.
 */
export function checkMemo(input: { memo: string; txid: string | null; proof: MemoProof | null }): MemoCheckResult {
  const named = MEMO_FORMAT.exec(input.memo)?.[1];
  const epoch = named ? db.getEpoch(named) : null;
  if (!named || !epoch || epoch.status === "harvesting") return { ok: true, check: { ...NOT_OURS, checks: { memo: false, txid: input.txid === null ? null : false, commitment: input.proof === null ? null : false } } };

  const paid = summarizePayouts(epoch.id, "shielded");
  const coins = (JSON.parse(epoch.coinMints) as string[]).map((mint) => ({ mint, symbol: db.getCoin(mint)?.symbol ?? "" }));
  const zcashTxids = paid.zcashTxids ?? [];
  const checks: MemoCheck["checks"] = { memo: paid.count > 0, txid: input.txid === null ? null : zcashTxids.includes(input.txid), commitment: null };
  const check: MemoCheck = {
    epochId: epoch.id, matches: false, coins, checks,
    round: { at: epoch.at, status: epoch.status, shielded: { count: paid.count, totalZats: paid.totalZats }, zcashTxids, snapshot: snapshotSummary(epoch.id) },
  };

  if (input.proof) {
    const opened = openReceipt(epoch.id, input.proof.wallet, input.proof.nonce, input.proof.signature);
    if (!opened.ok && opened.error !== "no_snapshot") return { ok: false, error: opened.error };
    const rows = opened.ok ? opened.rows : [];
    const published = publishedCommitments(epoch.id);
    checks.commitment = rows.length > 0 && rows.every((r) => published.has(r.commitment));
    check.rows = rows.map(({ mint, shareZats, commitment }) => ({ mint, shareZats, commitment }));
  }
  check.matches = checks.memo && checks.txid !== false && checks.commitment !== false;
  return { ok: true, check };
}
