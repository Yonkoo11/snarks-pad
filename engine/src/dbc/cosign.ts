// The launch's second signature, added by the engine after the creator's wallet has signed (audit/S5-REVIEW-2026-10-06.md S5-01, research/PHANTOM-WARNINGS.md
// Option B, the order Jupiter Studio documents). Phantom shows a warning for a transaction someone signed before the wallet, so the wallet must sign first;
// and the new coin's key must never leave the engine, or whoever holds it could create the pool with a transaction of their own and show any wallet as the
// coin's creator. So POST /coins/launch-tx answers with a transaction nobody has signed and keeps the coin's key here for HOLD_MS; the page has the wallet
// sign it and posts it to POST /coins/launch-cosign, which checks it against what was built and only then signs with the coin's key, once.
//
// What the check allows the wallet to change: nothing in the instructions that were built (program, accounts, signer flags and data, in order), the fee
// payer, the signers and the blockhash stay as built; a wallet may add instructions from any program (a priority fee, Phantom's Lighthouse assertions, its
// own guards or memos) as long as none of them names a key the pad signs with (the coin, the pad's launch signer). Built Compute Budget instructions are
// optional: a wallet that sets its own fee may drop or replace them (owner decision 2026-10-11, see addedOk). No address lookup tables.
// A refusal's detail says which instruction the wallet added or changed (program, account and byte counts only), for the api log. Account writability may differ, because added
// instructions change how a compiled message marks shared accounts and it gives no instruction any new power.
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { verifyEd25519 } from "../crypto/ed25519";
import { launchpadSigner } from "./launchSigner";

/** Phantom's Lighthouse assertion program (github.com/Jac0xb/lighthouse README; research/PHANTOM-WARNINGS.md F3). */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
/** A launch's blockhash lasts about 60 to 90 seconds; past this nothing signed for it can land, so its key is dropped. */
export const HOLD_MS = 180_000;

export type CosignCode = "unknown_launch" | "bad_tx" | "tx_mismatch";
export class CosignError extends Error {
  constructor(public code: CosignCode, public detail = "") {
    super(code);
  }
}

interface Held {
  key: Keypair;
  built: VersionedMessage;
  creator: PublicKey;
  until: number;
}
const held = new Map<string, Held>();

function forgetExpired(now: number): void {
  for (const [mint, h] of held) if (h.until <= now) held.delete(mint);
}

/** Keeps the coin's key until the creator's signed transaction comes back (or HOLD_MS passes). */
export function holdLaunchKey(key: Keypair, built: VersionedMessage, creator: PublicKey, now: number = Date.now()): void {
  forgetExpired(now);
  held.set(key.publicKey.toBase58(), { key, built, creator, until: now + HOLD_MS });
}

/** Drops a held key (a launch whose row could not be written). */
export function forgetLaunchKey(mint: string): void {
  held.delete(mint);
}

/** How many keys are held now (for tests and the health view). */
export const heldLaunchKeys = (now: number = Date.now()): number => (forgetExpired(now), held.size);

const sameIx = (a: TransactionInstruction, b: TransactionInstruction): boolean =>
  a.programId.equals(b.programId) &&
  Buffer.from(a.data).equals(Buffer.from(b.data)) &&
  a.keys.length === b.keys.length &&
  a.keys.every((k, i) => k.pubkey.equals(b.keys[i]!.pubkey) && k.isSigner === b.keys[i]!.isSigner);

/**
 * An added instruction may come from any program but may not name a key the pad signs with (the coin, the pad's launch signer): without one of those keys
 * it cannot spend the coin's or the pad's signature, and a new signer is refused before the instructions are compared. Owner decision 2026-10-11 after
 * mainnet launches were refused over instructions wallets add (the earlier allowlist was Compute Budget and Lighthouse only).
 */
const addedOk = (ix: TransactionInstruction, protect: PublicKey[]): boolean => !ix.keys.some((k) => protect.some((p) => p.equals(k.pubkey)));

/** The built instructions a wallet must keep: everything but Compute Budget ones, which a wallet that sets its own fee may drop or replace. */
const required = (built: TransactionInstruction[]): TransactionInstruction[] => built.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

/** One instruction for the log: program, account count, data bytes; "!" when it names a protected key. Addresses only, nothing secret. */
const describe = (ix: TransactionInstruction, protect: PublicKey[], tag: string): string =>
  `${tag}${ix.programId.toBase58().slice(0, 8)}:${ix.keys.length}k/${ix.data.length}b${ix.keys.some((k) => protect.some((p) => p.equals(k.pubkey))) ? "!" : ""}`;

/**
 * Every required built instruction, in order, with only allowed instructions around them. Returns null when they match; otherwise a line for the log that
 * says what came back ("=" a built instruction, "+" one the wallet added, "?" one it may not add), what was required, and how many of those were found.
 * Written 2026-10-11 after 40 mainnet refusals in 20 minutes said only "instructions".
 */
function instructionsMatch(builtAll: TransactionInstruction[], got: TransactionInstruction[], protect: PublicKey[]): string | null {
  const built = required(builtAll);
  const seen: string[] = [];
  let i = 0;
  let refused = false;
  for (const ix of got) {
    if (i < built.length && sameIx(ix, built[i]!)) {
      i++;
      seen.push(describe(ix, protect, "="));
    } else if (addedOk(ix, protect)) seen.push(describe(ix, protect, "+"));
    else {
      refused = true;
      seen.push(describe(ix, protect, "?"));
    }
  }
  if (!refused && i === built.length) return null;
  return `got ${seen.join(" ")}; built ${built.map((ix) => describe(ix, protect, "")).join(" ")}; found ${i} of ${built.length}`;
}

function decode(signedBase64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(signedBase64, "base64"));
  } catch {
    throw new CosignError("bad_tx");
  }
}

/** Throws tx_mismatch unless `tx` is the launch that was built for `h`, signed by its creator, as the header comment allows. */
function check(tx: VersionedTransaction, h: Held): void {
  const msg = tx.message;
  const mint = h.key.publicKey;
  if (msg.version !== 0 || msg.addressTableLookups.length > 0) throw new CosignError("tx_mismatch", "version or lookup tables");
  if (msg.recentBlockhash !== h.built.recentBlockhash) throw new CosignError("tx_mismatch", "blockhash");
  // The signers as built: the creator, the coin, and (when this instance has one) the pad's launch signer, in that order and no other.
  const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures);
  const builtSigners = h.built.staticAccountKeys.slice(0, h.built.header.numRequiredSignatures);
  if (signers.length !== builtSigners.length || !signers.every((k, i) => k.equals(builtSigners[i]!))) throw new CosignError("tx_mismatch", "signers");
  if (!signers[0]!.equals(h.creator) || !signers[1]!.equals(mint)) throw new CosignError("tx_mismatch", "signers");
  if (!verifyEd25519(msg.serialize(), tx.signatures[0]!, h.creator.toBytes())) throw new CosignError("tx_mismatch", "wallet signature");
  const got = TransactionMessage.decompile(msg).instructions;
  const built = TransactionMessage.decompile(h.built).instructions;
  // Protected keys: every signer this engine adds (the coin, and the pad's launch signer when there is one); never the creator, who signed for themselves.
  const why = instructionsMatch(built, got, builtSigners.slice(1));
  if (why) throw new CosignError("tx_mismatch", `instructions: ${why}`);
}

/**
 * The launch transaction the creator's wallet signed, checked and signed with the coin's key: what the page sends. The key is used once and dropped,
 * whatever the outcome of the check, so a refused transaction cannot be retried with the same key: the page asks for a new launch.
 */
export function cosignLaunch(mint: string, signedBase64: string, now: number = Date.now()): string {
  forgetExpired(now);
  const h = held.get(mint);
  if (!h) throw new CosignError("unknown_launch");
  held.delete(mint);
  const tx = decode(signedBase64);
  check(tx, h);
  // The pad's launch signer signs too when the built launch carries it (dbc/launchSigner.ts): the check above proved the signer list is as built.
  const pad = launchpadSigner();
  tx.sign(pad && tx.message.staticAccountKeys.some((k) => k.equals(pad.publicKey)) ? [h.key, pad] : [h.key]);
  return Buffer.from(tx.serialize()).toString("base64");
}
