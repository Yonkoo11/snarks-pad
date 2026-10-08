// A one-shot, permanent creation (the DBC config, the Squads multisig) is signed, recorded, THEN broadcast,
// like every other money-moving step here: a crash or a lost answer after the broadcast must never lead to a
// second creation. The record stays until the transaction provably landed (the caller then verifies and
// records the result) or provably can never land (blockhash expired, not on chain). Keeper-side only.
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import * as db from "../db";
import { broadcastAndConfirm, getConnection, resolvePendingTx } from "../solana";

export interface PendingCreate {
  /** The address being created (config account / multisig PDA). */
  subject: string;
  sig: string;
  rawTx: string; // base64 of the fully signed transaction
  lastValidBlockHeight: number;
  at: string;
}

export function readPendingCreate(metaKey: string): PendingCreate | null {
  const raw = db.getMeta(metaKey);
  return raw ? (JSON.parse(raw) as PendingCreate) : null;
}

export type PendingState =
  | { state: "none" }
  | { state: "landed"; pending: PendingCreate }
  | { state: "in_flight"; pending: PendingCreate };

/** Looks at an earlier attempt: landed, still possibly landing, or gone (then its record is cleared and `none` is returned). */
export async function resolvePendingCreate(metaKey: string): Promise<PendingState> {
  const pending = readPendingCreate(metaKey);
  if (!pending) return { state: "none" };
  const outcome = await resolvePendingTx(pending.sig, new Uint8Array(Buffer.from(pending.rawTx, "base64")), pending.lastValidBlockHeight);
  if (outcome === "dead") {
    db.deleteMeta(metaKey);
    return { state: "none" };
  }
  return { state: outcome === "landed" ? "landed" : "in_flight", pending };
}

/** Signs `tx`, records it as pending under `metaKey`, then broadcasts and waits. Returns the signature. */
export async function signRecordAndSend(metaKey: string, subject: string, tx: Transaction, payer: Keypair, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...signers);
  const sig = bs58.encode(tx.signature!);
  const raw = tx.serialize();
  const pending: PendingCreate = { subject, sig, rawTx: Buffer.from(raw).toString("base64"), lastValidBlockHeight, at: new Date().toISOString() };
  db.setMeta(metaKey, JSON.stringify(pending)); // durable BEFORE broadcasting
  await broadcastAndConfirm(raw, sig);
  return sig;
}

/** Forgets a record once its result has been verified and stored. */
export function clearPendingCreate(metaKey: string): void {
  db.deleteMeta(metaKey);
}
