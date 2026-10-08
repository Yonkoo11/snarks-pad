// Default holder payouts: direct Solana ZEC (SPL token) transfers from the
// keeper's wallet. Batched a handful of recipients per transaction to stay
// under the legacy transaction size limit.
//
// Resumable (finding 1): each batch's transaction is signed locally first (its
// signature is fixed the instant it's signed, with zero network calls), the
// caller persists that signature as "pending" BEFORE the batch is broadcast,
// and only marks it "sent" once confirmed. A crash between those two points
// resumes by checking the pending signature's chain status
// (checkPendingSolanaBatch) instead of blindly resending -- and if it truly
// never landed, resending the exact same signed bytes is always safe
// (Solana dedups by signature; see src/solana.ts broadcastAndConfirm).
//
// Per-recipient safety (finding 3): a recipient whose destination ATA cannot
// be resolved (an off-curve/PDA owner) never halts the whole batch. Off-curve
// owners still get a valid destination via allowOwnerOffCurve; only a
// genuinely malformed wallet is skipped, reported via `skipped` so the caller
// can carry it forward instead of silently losing it.
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  unpackAccount,
} from "@solana/spl-token";
import * as db from "../db";
import bs58 from "bs58";
import { config } from "../config";
import { getConnection, broadcastAndConfirm } from "../solana";
import { loadKeeperKeypair } from "../keeper";
import { chunk, type Share } from "./math";
import { readAccountsInfo } from "../multiAccounts";

const RECIPIENTS_PER_TX = 8;

export interface SkippedRecipient {
  wallet: string;
  amount: bigint;
  reason: string;
}

export interface ResolvedRecipient {
  wallet: string;
  amount: bigint;
  ata: PublicKey;
}

/**
 * Resolves each share's destination ATA. Pure/local (PDA derivation only, no
 * RPC calls): safe and cheap to call for every recipient every epoch. A
 * normal (on-curve) wallet gets its usual ATA; an off-curve owner (a PDA)
 * still gets a valid ATA via allowOwnerOffCurve, since a PDA can legitimately
 * hold an SPL balance even though it can't sign to move it further. Only a
 * malformed wallet string is diverted to `skipped`.
 */
export function resolveDestinations(quoteMint: PublicKey, shares: Share[]): { resolved: ResolvedRecipient[]; skipped: SkippedRecipient[] } {
  const resolved: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  for (const s of shares) {
    let owner: PublicKey;
    try {
      owner = new PublicKey(s.wallet);
    } catch {
      skipped.push({ wallet: s.wallet, amount: s.amount, reason: "invalid_wallet_pubkey" });
      continue;
    }
    try {
      const ata = getAssociatedTokenAddressSync(quoteMint, owner, false, TOKEN_PROGRAM_ID);
      resolved.push({ wallet: s.wallet, amount: s.amount, ata });
    } catch {
      try {
        const ata = getAssociatedTokenAddressSync(quoteMint, owner, true, TOKEN_PROGRAM_ID);
        resolved.push({ wallet: s.wallet, amount: s.amount, ata });
      } catch {
        skipped.push({ wallet: s.wallet, amount: s.amount, reason: "cannot_derive_destination_ata" });
      }
    }
  }
  return { resolved, skipped };
}

/**
 * Payout policy for the Solana leg (plan 4, review 2026-09-30): a recipient
 * with no ZEC token account costs the keeper about 0.00204 SOL of rent to
 * create one, so such a payout is sent only when it exceeds `minNewAccountZats`;
 * otherwise it is deferred (carried) until it does. Existing accounts are
 * always paid. Pure: the caller says which accounts exist.
 *
 * Audit S2-03/S2-04 (opts): an account that exists but cannot receive this
 * mint for this wallet (owner reassigned, frozen, not a token account) is
 * deferred, never put in a batch where its failure would sink every other
 * recipient; and an account the keeper already paid rent for once, that is now
 * gone (closed by its owner, who kept the rent), is not paid for again.
 */
export function partitionByAccountPolicy(
  resolved: ResolvedRecipient[],
  existingAtas: Set<string>,
  minNewAccountZats: bigint,
  opts: { unusable?: Set<string>; keeperFunded?: Set<string> } = {},
): { payable: ResolvedRecipient[]; deferred: ResolvedRecipient[]; reasons: Map<string, string> } {
  const payable: ResolvedRecipient[] = [];
  const deferred: ResolvedRecipient[] = [];
  const reasons = new Map<string, string>(); // wallet -> why it was deferred
  const defer = (r: ResolvedRecipient, reason: string) => {
    deferred.push(r);
    reasons.set(r.wallet, reason);
  };
  for (const r of resolved) {
    const ata = r.ata.toBase58();
    if (opts.unusable?.has(ata)) defer(r, "destination_account_unusable");
    else if (existingAtas.has(ata)) payable.push(r);
    else if (opts.keeperFunded?.has(ata)) defer(r, "account_closed_after_keeper_paid_rent");
    else if (r.amount > minNewAccountZats) payable.push(r);
    else defer(r, "new_account_below_rent");
  }
  return { payable, deferred, reasons };
}

/** Which destination accounts exist, and which of those cannot take a transfer of `mint` for their wallet. */
async function readAccounts(resolved: ResolvedRecipient[], mint: PublicKey): Promise<{ existing: Set<string>; unusable: Set<string> }> {
  const existing = new Set<string>();
  const unusable = new Set<string>();
  {
    const infos = await readAccountsInfo(resolved.map((r) => r.ata));
    infos.forEach((info, i) => {
      if (!info) return;
      const r = resolved[i]!;
      const ata = r.ata.toBase58();
      existing.add(ata);
      try {
        const acct = unpackAccount(r.ata, info, TOKEN_PROGRAM_ID);
        if (!acct.mint.equals(mint) || acct.owner.toBase58() !== r.wallet || !acct.isInitialized || acct.isFrozen) unusable.add(ata);
      } catch {
        unusable.add(ata); // not a token account of this program at all
      }
    });
  }
  return { existing, unusable };
}

/**
 * The engine-level payout policy, applied BEFORE sending: shares that may be
 * sent now, and shares deferred (no ZEC account and under the rent, an account
 * that cannot receive, or an account the keeper already funded once). Deferred
 * shares are carried by the caller, the same way `skipped` recipients are.
 * `newAccounts` maps each payable wallet whose account the keeper will create
 * to that account, so the caller can record the rent it paid.
 */
export async function applyAccountPolicy(shares: Share[]): Promise<{ payable: Share[]; deferred: SkippedRecipient[]; newAccounts: Map<string, string> }> {
  const mint = config.solana.dbc.quoteMint;
  const { resolved, skipped } = resolveDestinations(mint, shares);
  const { existing, unusable } = await readAccounts(resolved, mint);
  const keeperFunded = db.keeperFundedAtas(resolved.map((r) => r.ata.toBase58()));
  const { payable, deferred, reasons } = partitionByAccountPolicy(resolved, existing, config.epoch.newAccountMinZats, { unusable, keeperFunded });
  return {
    // `skipped` (malformed wallets) stay in the payable list so sendSolanaZecPayouts reports them with its own reason.
    payable: [...payable, ...skipped].map((r) => ({ wallet: r.wallet, amount: r.amount })),
    deferred: deferred.map((d) => ({ wallet: d.wallet, amount: d.amount, reason: reasons.get(d.wallet)! })),
    newAccounts: new Map(payable.filter((r) => !existing.has(r.ata.toBase58())).map((r) => [r.wallet, r.ata.toBase58()])),
  };
}

export interface SolanaPayoutHooks {
  /** Called right after a batch is signed, BEFORE it is broadcast: persist this signature (and the signed bytes, to resend on resume) as pending. */
  onPending: (wallets: string[], sig: string, signed: { rawTx: string; lastValidBlockHeight: number }) => void | Promise<void>;
  /** Called only once the batch is confirmed on chain: persist this signature as sent. */
  onSent: (wallets: string[], sig: string) => void | Promise<void>;
}

export interface SendResult {
  sentSigsByWallet: Map<string, string>;
  skipped: SkippedRecipient[];
}

export async function sendSolanaZecPayouts(shares: Share[], hooks: SolanaPayoutHooks): Promise<SendResult> {
  const sentSigsByWallet = new Map<string, string>();
  if (shares.length === 0) return { sentSigsByWallet, skipped: [] };

  const conn = getConnection();
  const keeper = loadKeeperKeypair();
  const quoteMint = config.solana.dbc.quoteMint;
  const mintInfo = await getMint(conn, quoteMint, "confirmed", TOKEN_PROGRAM_ID);
  const keeperAta = (
    await getOrCreateAssociatedTokenAccount(conn, keeper, quoteMint, keeper.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)
  ).address;

  const { resolved, skipped } = resolveDestinations(quoteMint, shares);

  for (const batch of chunk(resolved, RECIPIENTS_PER_TX)) {
    const tx = new Transaction();
    for (const r of batch) {
      const owner = new PublicKey(r.wallet);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, r.ata, owner, quoteMint, TOKEN_PROGRAM_ID));
      tx.add(createTransferCheckedInstruction(keeperAta, quoteMint, r.ata, keeper.publicKey, r.amount, mintInfo.decimals, [], TOKEN_PROGRAM_ID));
    }
    tx.feePayer = keeper.publicKey;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(keeper); // local: the signature (and hence the batch's sig/ref) is now fixed
    const sig = bs58.encode(tx.signature!);
    const raw = tx.serialize();
    const wallets = batch.map((r) => r.wallet);

    await hooks.onPending(wallets, sig, { rawTx: Buffer.from(raw).toString("base64"), lastValidBlockHeight }); // durable, BEFORE broadcasting
    await broadcastAndConfirm(raw, sig);
    await hooks.onSent(wallets, sig);
    for (const w of wallets) sentSigsByWallet.set(w, sig);
  }
  return { sentSigsByWallet, skipped };
}
