// Writes an epoch snapshot's sha256 into a Solana memo transaction signed by the keeper, so the file the API serves
// can be checked against the chain. Same pattern as every payout: sign, persist the signature and bytes, then
// broadcast; a resume checks that signature's chain status and resends the same bytes, never a second memo.
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import * as db from "../db";
import { loadKeeperKeypair } from "../keeper";
import { broadcastAndConfirm, getConnection, resolvePendingTx } from "../solana";
import { snapshotMemoText } from "./snapshotFile";

/** SPL Memo v2 (same id on every cluster; the local validator ships it too). */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export function buildMemoTransaction(memo: string, signer: PublicKey): Transaction {
  return new Transaction().add(new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  }));
}

export type MemoState = "none" | "landed" | "pending";

/**
 * Makes sure the epoch's snapshot hash is on chain. "none": the epoch has no snapshot (it predates them). "pending":
 * a memo is signed and not yet confirmed; call again later. Idempotent: a landed memo is never written twice.
 * `beforeBroadcast` is the caller's fence (pause switch, epoch lock): it runs before anything is signed or sent.
 */
export async function ensureSnapshotMemo(epochId: string, beforeBroadcast: () => void = () => {}): Promise<MemoState> {
  const snap = db.getEpochSnapshot(epochId);
  if (!snap) return "none";
  if (snap.memoAt) return "landed";
  if (snap.memoSig && snap.memoRawTx && snap.memoLastValidBlockHeight != null) {
    beforeBroadcast();
    const outcome = await resolvePendingTx(snap.memoSig, new Uint8Array(Buffer.from(snap.memoRawTx, "base64")), snap.memoLastValidBlockHeight);
    if (outcome === "landed") {
      db.markSnapshotMemoLanded(epochId);
      return "landed";
    }
    if (outcome === "in_flight") return "pending";
    db.clearSnapshotMemoPending(epochId); // provably never landed: sign a fresh one below
  }
  beforeBroadcast();
  const keeper = loadKeeperKeypair();
  const tx = buildMemoTransaction(snapshotMemoText(epochId, snap.sha256), keeper.publicKey);
  tx.feePayer = keeper.publicKey;
  const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(keeper);
  const sig = bs58.encode(tx.signature!);
  const raw = tx.serialize();
  db.markSnapshotMemoPending(epochId, sig, Buffer.from(raw).toString("base64"), lastValidBlockHeight); // durable BEFORE broadcasting
  await broadcastAndConfirm(raw, sig);
  db.markSnapshotMemoLanded(epochId);
  return "landed";
}
