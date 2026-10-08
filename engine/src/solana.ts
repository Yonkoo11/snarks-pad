// Shared Solana connection + Meteora DBC / DAMM v2 SDK handles.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { config } from "./config";
import { rpcGuard } from "./rpcGuard";

let conn: Connection | null = null;

/** Every call goes through the RPC guard (src/rpcGuard.ts): one attempt with a timeout and a circuit breaker, never web3.js's own retry-on-429. */
export function getConnection(): Connection {
  if (!conn) conn = new Connection(config.solana.rpc, { commitment: "confirmed", fetch: rpcGuard.fetch, disableRetryOnRateLimit: true });
  return conn;
}

let dbcClient: DynamicBondingCurveClient | null = null;

/** Meteora DBC SDK client (read + instruction building; it never signs or sends). */
export function getDbcClient(): DynamicBondingCurveClient {
  if (!dbcClient) dbcClient = DynamicBondingCurveClient.create(getConnection(), "confirmed");
  return dbcClient;
}

/** Meteora DAMM v2 (cp-amm) SDK: the venue a coin trades on after migration. */
export function getCpAmm(): CpAmm {
  return new CpAmm(getConnection());
}

/**
 * docs/API.md: launch-tx and trade-tx return "base64 (unsigned, versioned)".
 * The Meteora SDKs build a legacy Transaction; this recompiles its instructions
 * into a v0 message (no lookup tables) with `feePayer` first, fills in any
 * server-side signers (the new mint's keypair on launch), and leaves the
 * fee payer's signature slot empty for the browser wallet.
 */
export function toUnsignedV0Base64(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  recentBlockhash: string,
  serverSigners: Keypair[] = [],
): string {
  return Buffer.from(toV0Tx(instructions, feePayer, recentBlockhash, serverSigners).serialize()).toString("base64");
}

/**
 * A trade or a claim with a priority fee in front (research/METEORA-WORKSHOP.md L2: Meteora's own guide puts a compute unit price on every transaction, and
 * "Timeout waiting for confirmation" is its first cause). Only the price is set, not a compute limit, so a busy transaction is never cut short: at the default
 * 50,000 micro-lamports a unit and the runtime's 200,000 units an instruction, a three-instruction trade pays at most 0.00003 SOL more. PAD_PRIORITY_MICROLAMPORTS=0
 * turns it off. Not used on a launch: its size must leave room for the checks Phantom adds (research/PHANTOM-WARNINGS.md).
 */
export function withPriorityFee(instructions: TransactionInstruction[], microLamports: number = priorityMicroLamports()): TransactionInstruction[] {
  if (microLamports <= 0) return instructions;
  return [ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions];
}

export function priorityMicroLamports(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAD_PRIORITY_MICROLAMPORTS;
  if (raw === undefined || raw.trim() === "") return 50_000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5_000_000 ? n : 50_000;
}

/** The same transaction before it is encoded, for a caller that simulates it first (dbc/launch.ts). */
export function toV0Tx(instructions: TransactionInstruction[], feePayer: PublicKey, recentBlockhash: string, serverSigners: Keypair[] = []): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash, instructions }).compileToV0Message();
  const vtx = new VersionedTransaction(message);
  if (serverSigners.length) vtx.sign(serverSigners);
  return vtx;
}

export type Commitment = "confirmed" | "finalized";

const reached = (status: string | undefined, want: Commitment): boolean =>
  want === "finalized" ? status === "finalized" : status === "confirmed" || status === "finalized";

/** Waits for a signature to reach `commitment`. Returns null if never seen, else the tx error (null on success). */
export async function waitForSignature(sig: string, timeoutMs = 20_000, commitment: Commitment = "confirmed"): Promise<{ err: unknown } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await getConnection().getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    if (st && reached(st.confirmationStatus, commitment)) return { err: st.err };
    if (st?.err) return { err: st.err };
    if (Date.now() > deadline) return null; // not seen, or seen but not yet at the wanted commitment
    await Bun.sleep(500);
  }
}

/** True iff `sig` has reached at least "confirmed" on chain and succeeded (a single check, no waiting). */
export async function isSignatureLanded(sig: string): Promise<boolean> {
  const { value } = await getConnection().getSignatureStatuses([sig], { searchTransactionHistory: true });
  const st = value[0];
  return !!st && !st.err && reached(st.confirmationStatus, "confirmed");
}

/**
 * Reads how much `ata`'s token balance changed within one specific confirmed
 * transaction, from that transaction's OWN pre/post token balance snapshots
 * (finding 5) -- never from a separate before/after `getAccount` poll, which
 * can be corrupted by anything else that touches the same shared account
 * between the two reads. Retries briefly: `getTransaction` can lag a few
 * hundred ms behind the confirmation this same connection just observed.
 */
export async function getTokenBalanceDelta(sig: string, ata: PublicKey, attempts = 5, commitment: Commitment = "confirmed"): Promise<bigint> {
  const conn = getConnection();
  for (let i = 0; i < attempts; i++) {
    const tx = await conn.getTransaction(sig, { commitment, maxSupportedTransactionVersion: 0 });
    if (tx?.meta) {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      const idx = keys.staticAccountKeys.concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? []).findIndex((k) => k.equals(ata));
      if (idx === -1) return 0n; // ata wasn't touched by this tx at all
      const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount;
      const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount;
      return BigInt(post ?? "0") - BigInt(pre ?? "0");
    }
    await Bun.sleep(500);
  }
  throw new Error(`transaction ${sig} not found after ${attempts} attempts (cannot read its balance delta)`);
}

/**
 * Sends an already-signed transaction and waits for it to land. Safe to call
 * more than once with the exact same signed bytes for the exact same
 * signature (Solana dedups by signature; a resend of an already-processed tx
 * is a no-op, not a second execution) -- this is what makes "persist the
 * signed bytes, then broadcast, and resend the same bytes on resume" safe
 * (see src/epoch/solanaPayout.ts, src/swap/simulated.ts).
 *
 * While it waits it offers the same bytes again every `resendEveryMs`: a cluster
 * drops transactions under load, and one send followed by polling stopped a
 * whole epoch run on a dropped payout batch (stress scale run, audit/STRESS-REPORT.md).
 * Only the first send can fail the call; a resend's error is ignored and the
 * signature status decides.
 */
export async function broadcastAndConfirm(rawTx: Uint8Array, sig: string, timeoutMs = 20_000, commitment: Commitment = "confirmed", resendEveryMs = 2_000): Promise<void> {
  try {
    await getConnection().sendRawTransaction(rawTx, { skipPreflight: false });
  } catch (err) {
    // "already processed" (or equivalent) just means a prior attempt landed;
    // fall through to the confirmation check below instead of failing.
    if (!/already processed|AlreadyProcessed/i.test(String((err as Error)?.message ?? err))) throw err;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await waitForSignature(sig, Math.max(0, Math.min(resendEveryMs, deadline - Date.now())), commitment);
    if (result) {
      if (result.err) throw new Error(`transaction ${sig} failed on chain: ${JSON.stringify(result.err)}`);
      return;
    }
    if (Date.now() >= deadline) throw new Error(`transaction ${sig} did not land within ${timeoutMs}ms (may need a fresh blockhash)`);
    await getConnection().sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
  }
}

/**
 * Resolves a signed Solana transaction whose outcome is unknown (audit S2-01):
 * "landed" once it is confirmed without error; "dead" once it provably never
 * can land (its blockhash's last valid block height has passed and it is not on
 * chain, or it is finalized with an error and moved nothing); otherwise
 * "in_flight". While in flight it resends the SAME signed bytes (Solana dedups
 * by signature), so a resume never signs a second transaction for the same
 * payout while the first can still land.
 */
export async function resolvePendingTx(sig: string, rawTx: Uint8Array, lastValidBlockHeight: number): Promise<"landed" | "dead" | "in_flight"> {
  if (await isSignatureLanded(sig)) return "landed";
  try {
    await broadcastAndConfirm(rawTx, sig);
    return "landed";
  } catch {
    const { value } = await getConnection().getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    if (st && !st.err && reached(st.confirmationStatus, "confirmed")) return "landed";
    if (st?.err && st.confirmationStatus === "finalized") return "dead";
    // The FINALIZED height (audit S6-K1): a confirmed height can still roll back, and a wrong "dead" re-signs a payout batch.
    if ((await getConnection().getBlockHeight("finalized")) <= lastValidBlockHeight) return "in_flight";
    return (await isSignatureLanded(sig)) ? "landed" : st ? "in_flight" : "dead"; // looked again after reading the height
  }
}
