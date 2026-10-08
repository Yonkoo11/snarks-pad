// The per-epoch snapshot file: who was entitled to what, written when the epoch is finalized and before any payout
// moves, with its sha256 later written into a Solana memo by the keeper (src/epoch/snapshotMemo.ts). Anyone can
// recompute the split from it (scripts/verify-snapshot.ts).
//
// Privacy rule docs/API.md, "What is hidden vs not"): the API never publishes a per-recipient shielded amount
// or a Zcash address. So Solana-rail holders are listed in full (wallet, weight, share), and shielded-rail holders
// only as a count, a total, and one salted commitment per row. The salt is derived from a secret that stays in the
// keeper's database, so a commitment cannot be tested against guessed amounts; the wallet owner can ask the pad for
// the opening of their own row (signed request) and check it against the file.
import { createHash, createHmac } from "node:crypto";

export const SNAPSHOT_VERSION = 1;

export interface SnapshotRowInput {
  wallet: string;
  weight: bigint | null; // the least balance the holder showed across the window's samples; null for rows from before weights were stored
  shareZats: bigint;
}

export interface SnapshotCoinInput {
  mint: string;
  claimedZats: bigint;
  teamZats: bigint;
  rows: SnapshotRowInput[];
}

export interface SnapshotInput {
  epochId: string;
  at: string;
  network: string;
  teamShareBps: number;
  meteoraShareOfFeeBps: number;
  coins: SnapshotCoinInput[];
  /** Wallets on the shielded rail when the epoch was planned. */
  shieldedWallets: Set<string>;
  /** The secret that salts shielded commitments (kept in the keeper's database, never published). */
  saltSecret: string;
}

export interface SnapshotCoin {
  mint: string;
  claimedZats: string;
  teamZats: string;
  holdersZats: string;
  totalWeight: string | null;
  solana: { wallet: string; weight: string | null; shareZats: string }[];
  shielded: { count: number; totalShareZats: string; totalWeight: string | null; commitments: string[] };
}

export interface Snapshot {
  version: number;
  epochId: string;
  at: string;
  network: string;
  policy: { meteoraShareOfFeeBps: number; holdersShareOfClaimedBps: number; teamShareOfClaimedBps: number };
  coins: SnapshotCoin[];
}

/** The salt of one shielded row. Deterministic from the secret, so the pad can reopen it later without storing it. */
export function rowSalt(secret: string, epochId: string, mint: string, wallet: string): string {
  return createHmac("sha256", secret).update(`${epochId}|${mint}|${wallet}`).digest("hex");
}

/** The commitment published for a shielded row: sha256 over the epoch, coin, salt, wallet and share. */
export function rowCommitment(epochId: string, mint: string, salt: string, wallet: string, shareZats: bigint): string {
  return createHash("sha256").update(`snarks-pad-snapshot-v1\n${epochId}\n${mint}\n${salt}\n${wallet}\n${shareZats}`).digest("hex");
}

function sumWeights(rows: SnapshotRowInput[]): bigint | null {
  if (rows.some((r) => r.weight === null)) return null;
  return rows.reduce((acc, r) => acc + r.weight!, 0n);
}

function buildCoin(i: SnapshotInput, c: SnapshotCoinInput): SnapshotCoin {
  const solanaRows = c.rows.filter((r) => !i.shieldedWallets.has(r.wallet)).sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const shieldedRows = c.rows.filter((r) => i.shieldedWallets.has(r.wallet));
  const shieldedWeight = sumWeights(shieldedRows);
  const solanaWeight = sumWeights(solanaRows);
  return {
    mint: c.mint,
    claimedZats: c.claimedZats.toString(),
    teamZats: c.teamZats.toString(),
    holdersZats: (c.claimedZats - c.teamZats).toString(),
    totalWeight: shieldedWeight === null || solanaWeight === null ? null : (shieldedWeight + solanaWeight).toString(),
    solana: solanaRows.map((r) => ({ wallet: r.wallet, weight: r.weight?.toString() ?? null, shareZats: r.shareZats.toString() })),
    shielded: {
      count: shieldedRows.length,
      totalShareZats: shieldedRows.reduce((acc, r) => acc + r.shareZats, 0n).toString(),
      totalWeight: shieldedWeight?.toString() ?? null,
      commitments: shieldedRows.map((r) => rowCommitment(i.epochId, c.mint, rowSalt(i.saltSecret, i.epochId, c.mint, r.wallet), r.wallet, r.shareZats)).sort(),
    },
  };
}

export function buildSnapshot(i: SnapshotInput): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    epochId: i.epochId,
    at: i.at,
    network: i.network,
    policy: {
      meteoraShareOfFeeBps: i.meteoraShareOfFeeBps,
      holdersShareOfClaimedBps: 10_000 - i.teamShareBps,
      teamShareOfClaimedBps: i.teamShareBps,
    },
    coins: [...i.coins].sort((a, b) => (a.mint < b.mint ? -1 : 1)).map((c) => buildCoin(i, c)),
  };
}

/** The exact bytes that are hashed, stored and served. Never re-serialized: the hash covers these bytes. */
export function serializeSnapshot(s: Snapshot): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

export function snapshotSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The memo text the keeper writes on Solana. */
export function snapshotMemoText(epochId: string, sha256: string): string {
  return `snarks-pad snapshot ${epochId} sha256:${sha256}`;
}
