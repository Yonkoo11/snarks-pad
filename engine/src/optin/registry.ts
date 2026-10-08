// Opt-in registry: nonce issuance, signature verification, unified-address gate,
// DB persistence. The server always reconstructs the expected message from
// (wallet, zcashAddress, nonce) itself; it never trusts a client-supplied string.
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { checkZcashAddress, maskZcashAddress, precheckZcashAddress } from "../zcash/address";
import { optinMessage, optoutMessage, shieldedViewMessage } from "./message";
import { verifyWalletSignature } from "./verify";
import * as db from "../db";
import { shieldedRewardsOf, type ShieldedRewards } from "../rewards";

const NONCE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
// Audit S2-09: GET /optin/nonce is public and writes a row per call. Expired
// nonces are dropped, a wallet keeps at most a few unused ones, and past a
// total the route answers 429 instead of growing the DB.
// Audit S6 (lens 1-02, and its hostile review): the route is public for ANY wallet, so no per-wallet rule can tell the
// wallet's owner from a stranger asking in their name. The old rule kept a wallet's newest 5 unused nonces and dropped the
// rest: five requests in a victim's name made the nonce the victim was about to use stale. A per-wallet cap instead would
// let the same stranger lock the victim out. So there is no per-wallet rule at all: a nonce lives 10 minutes, the route is
// limited per client address (src/api.ts), and the table cannot grow past MAX_LIVE_NONCES in all (a flood then gets 429
// for everyone, which is loud, rather than one wallet quietly failing).
export const MAX_LIVE_NONCES = 20_000;

export class NonceLimitError extends Error {}

export function issueNonce(wallet: string): { nonce: string; message: string } {
  if (db.pruneExpiredNonces(NONCE_MAX_AGE_MS) >= MAX_LIVE_NONCES) throw new NonceLimitError("too many outstanding nonces");
  const nonce = bs58.encode(randomBytes(16));
  const message = optinMessage(wallet, "<u1 address>", nonce); // template for the UI to display; not what gets signature-checked
  db.createNonce(wallet, nonce, message);
  return { nonce, message };
}

export type OptinError = "invalid_signature" | "no_orchard_receiver" | "bad_address" | "stale_nonce";
export type OptinResult = { ok: true; registeredAt: string } | { ok: false; error: OptinError };

// Order matters: the signature is checked before the nonce is consumed, so a
// stranger who fetched someone else's nonce (GET /optin/nonce is public)
// cannot burn it by posting a junk signature.
// Audit S2-13: the full address check spawns zcash-devtool synchronously, so it
// runs only after the signature and a live nonce are proven; anything cheaper
// (shape, prefix) runs first.
// Audit S6 (lenses 1-03, 5-5): the nonce is SPENT before that spawn, so one signed
// body whose address fails cannot be replayed to spawn devtool again and again;
// a failed check costs the wallet one fresh nonce, nothing more.
// Audit S6 (lens 1-01): the address is checked trimmed and STORED trimmed. It used
// to be stored as sent: one address with a stray space made the whole shielded
// batch (every opted-in holder, every epoch) fail at the payment URI.
export function registerOptin(wallet: string, zcashAddress: string, nonce: string, signatureB58: string): OptinResult {
  const precheck = precheckZcashAddress(zcashAddress);
  if (!precheck.ok) return { ok: false, error: precheck.reason };

  const message = optinMessage(wallet, zcashAddress, nonce); // the text the wallet signed: the address exactly as the client sent it
  if (!verifyWalletSignature(wallet, message, signatureB58)) return { ok: false, error: "invalid_signature" };

  const expected = db.consumeNonce(wallet, nonce, NONCE_MAX_AGE_MS);
  if (expected === null) return { ok: false, error: "stale_nonce" };

  const stored = zcashAddress.trim();
  const addressCheck = checkZcashAddress(stored);
  if (!addressCheck.ok) return { ok: false, error: addressCheck.reason };

  db.upsertOptin(wallet, stored);
  const row = db.getOptin(wallet)!;
  return { ok: true, registeredAt: row.registeredAt };
}

export type OptoutResult = { ok: true } | { ok: false; error: OptinError };

export function deregisterOptin(wallet: string, nonce: string, signatureB58: string): OptoutResult {
  const message = optoutMessage(wallet, nonce);
  if (!verifyWalletSignature(wallet, message, signatureB58)) return { ok: false, error: "invalid_signature" };

  const expected = db.consumeNonce(wallet, nonce, NONCE_MAX_AGE_MS);
  if (expected === null) return { ok: false, error: "stale_nonce" };

  db.deactivateOptin(wallet);
  return { ok: true };
}

/**
 * What a wallet's signature opens (contract v2.9): its own shielded delivery. Nothing here is ever given to a request that has not proved it owns
 * the wallet, not even `optedIn`: the product promise is that shielded delivery is private, so whether a wallet opted in is the wallet's to show.
 */
export interface OptinStatus {
  optedIn: boolean;
  /** The first and last 4 characters of the registered address, null when delivery is off. Never the whole address, not even to its owner. */
  zcashAddressMasked: string | null;
  pendingZats: string;
  shielded: ShieldedRewards;
}

export type StatusResult = { ok: true; status: OptinStatus } | { ok: false; error: "invalid_signature" | "stale_nonce" };

/**
 * The signed read. Same order as opt-in and opt-out: the signature over this purpose's own text (shieldedViewMessage) is checked first, so a stranger who
 * fetched someone else's nonce (GET /optin/nonce is public) cannot burn it with a junk signature, and only then is the nonce spent (it works once).
 * A signature made for anything else (an opt-in, an opt-out, a receipt) fails here, because its text is different.
 */
export function readOptinStatus(wallet: string, nonce: string, signatureB58: string): StatusResult {
  if (!verifyWalletSignature(wallet, shieldedViewMessage(wallet, nonce), signatureB58)) return { ok: false, error: "invalid_signature" };
  if (db.consumeNonce(wallet, nonce, NONCE_MAX_AGE_MS) === null) return { ok: false, error: "stale_nonce" };
  const row = db.getOptin(wallet);
  const active = row && row.active === 1 ? row : null;
  return {
    ok: true,
    status: {
      optedIn: active !== null,
      zcashAddressMasked: active ? maskZcashAddress(active.zcashAddress) : null,
      pendingZats: db.getCarry(wallet, "shielded").toString(),
      shielded: shieldedRewardsOf(wallet),
    },
  };
}
