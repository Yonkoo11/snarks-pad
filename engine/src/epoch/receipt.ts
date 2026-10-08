// Opens a shielded holder's own rows of an epoch snapshot. The published file only carries salted commitments for
// shielded rows (no wallet, no amount); the wallet's owner proves ownership with a signed nonce and gets the salt and
// the share for their own rows, which they can check against the file. Nobody else can: the salt comes from a secret
// that stays in the keeper's database.
import * as db from "../db";
import { epochReceiptMessage } from "../optin/message";
import { verifyWalletSignature } from "../optin/verify";
import { rowCommitment, rowSalt } from "./snapshotFile";

const NONCE_MAX_AGE_MS = 10 * 60 * 1000;

export interface ReceiptRow {
  mint: string;
  shareZats: string;
  salt: string;
  commitment: string;
}

export type ReceiptResult = { ok: true; rows: ReceiptRow[] } | { ok: false; error: "invalid_signature" | "stale_nonce" | "no_snapshot" };

/** A wallet's own rows of an epoch, each with its salt and commitment: the opening of what the snapshot file lists only as commitments. */
export function walletRows(epochId: string, wallet: string): ReceiptRow[] {
  const secret = db.snapshotSaltSecret();
  return db.listEpochCoinSharesOfWallet(epochId, wallet).map((r) => {
    const salt = rowSalt(secret, epochId, r.mint, wallet);
    return { mint: r.mint, shareZats: r.amountZats, salt, commitment: rowCommitment(epochId, r.mint, salt, wallet, BigInt(r.amountZats)) };
  });
}

/** Whether the wallet was on the shielded rail when the epoch was planned (the snapshot keeps that list private). */
export function wasShieldedIn(epochId: string, wallet: string): boolean {
  const snap = db.getEpochSnapshot(epochId);
  return !!snap && (JSON.parse(snap.shieldedWallets) as string[]).includes(wallet);
}

export function openReceipt(epochId: string, wallet: string, nonce: string, signature: string): ReceiptResult {
  const snap = db.getEpochSnapshot(epochId);
  if (!snap) return { ok: false, error: "no_snapshot" };
  // Signature first, nonce second: a stranger holding someone else's nonce cannot burn it with a junk signature.
  if (!verifyWalletSignature(wallet, epochReceiptMessage(wallet, epochId, nonce), signature)) return { ok: false, error: "invalid_signature" };
  if (db.consumeNonce(wallet, nonce, NONCE_MAX_AGE_MS) === null) return { ok: false, error: "stale_nonce" };
  if (!wasShieldedIn(epochId, wallet)) return { ok: true, rows: [] };
  return { ok: true, rows: walletRows(epochId, wallet) };
}
