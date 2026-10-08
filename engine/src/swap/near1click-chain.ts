// The Solana side of the NEAR 1Click deposit: build and sign the SPL transfer to
// the quote's deposit address, send it, and answer "did it land?" without ever
// confusing "not seen yet" with "never will". Shape verified against the real
// F-030 deposit (PORT-ASSUMPTIONS N16): create the deposit address's associated
// token account, then transferChecked exactly `amount` into it.
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import { getConnection } from "../solana";

/**
 * landed:  confirmed on chain without error.
 * failed:  FINALIZED on chain with an error: the transaction ran and moved nothing.
 * seen:    known to the cluster but not yet confirmed (it can still land).
 * absent:  the RPC has no record of it. Only ever "provably never" after its blockhash expired (see isProvablyNeverLanded).
 */
export type SignatureStatus = "landed" | "failed" | "seen" | "absent";

export interface SignedDeposit {
  signature: string;
  rawTx: Uint8Array;
  lastValidBlockHeight: number;
}

export interface DepositChain {
  keeperTokenBalance(): Promise<bigint>;
  buildSignedDeposit(depositAddress: string, amountZats: bigint): Promise<SignedDeposit>;
  /** Sends the exact signed bytes. Resending is safe (Solana dedups by signature). Does not wait. */
  broadcast(rawTx: Uint8Array): Promise<void>;
  signatureStatus(signature: string): Promise<SignatureStatus>;
  /** True iff the deposit address's token account exists. Our deposit tx creates it, so it is evidence the tx landed that does not depend on transaction history. */
  depositAccountExists(depositAddress: string): Promise<boolean>;
  heights(): Promise<{ confirmed: number; finalized: number }>;
  /** The signature of a transfer of exactly `amountZats` into the keeper's ZEC account made by someone other than the keeper after `afterSignature`, if any. */
  findIncomingTransfer(afterSignature: string, amountZats: bigint): Promise<string | null>;
}

/** How far past `lastValidBlockHeight` the FINALIZED height must be before we call a missing signature "never landed". */
export const EXPIRY_MARGIN_BLOCKS = 150;
/** The refund search reads the keeper account's signatures in pages of this size, at most this many per call. */
export const REFUND_SEARCH_PAGE = 100;
export const REFUND_SEARCH_MAX_SIGNATURES = 1_000;

export interface ChainOptions {
  keeper: Keypair;
  mint: PublicKey;
  priorityMicroLamports: number;
  connection?: Connection;
}

const COMPUTE_UNIT_LIMIT = 80_000; // ATA create (~30k) + transferChecked (~6k) with headroom

export function makeSolanaDepositChain(opts: ChainOptions): DepositChain {
  const conn = (): Connection => opts.connection ?? getConnection();
  const keeperAta = getAssociatedTokenAddressSync(opts.mint, opts.keeper.publicKey, false, TOKEN_PROGRAM_ID);
  return {
    async keeperTokenBalance() {
      try {
        return (await getAccount(conn(), keeperAta, "confirmed", TOKEN_PROGRAM_ID)).amount;
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError || err instanceof TokenInvalidAccountOwnerError) return 0n; // no ZEC account yet: nothing to send
        throw err; // an RPC failure is not a balance of 0 (audit S6-C1): the caller must not decide on it
      }
    },

    async buildSignedDeposit(depositAddress, amountZats) {
      const owner = new PublicKey(depositAddress);
      const mintInfo = await getMint(conn(), opts.mint, "confirmed", TOKEN_PROGRAM_ID);
      // allowOwnerOffCurve: a deposit address is not guaranteed to be an ordinary key.
      const depositAta = getAssociatedTokenAddressSync(opts.mint, owner, true, TOKEN_PROGRAM_ID);
      const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash("confirmed");
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }),
        createAssociatedTokenAccountIdempotentInstruction(opts.keeper.publicKey, depositAta, owner, opts.mint, TOKEN_PROGRAM_ID),
        createTransferCheckedInstruction(keeperAta, opts.mint, depositAta, opts.keeper.publicKey, amountZats, mintInfo.decimals, [], TOKEN_PROGRAM_ID),
      );
      tx.feePayer = opts.keeper.publicKey;
      tx.recentBlockhash = blockhash;
      tx.sign(opts.keeper); // local only: the signature is fixed here, before anything is sent
      return { signature: bs58.encode(tx.signature!), rawTx: tx.serialize(), lastValidBlockHeight };
    },

    async broadcast(rawTx) {
      try {
        await conn().sendRawTransaction(rawTx, { skipPreflight: false });
      } catch (err) {
        if (!/already processed|AlreadyProcessed/i.test(String((err as Error)?.message ?? err))) throw err;
      }
    },

    async signatureStatus(signature) {
      const { value } = await conn().getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = value[0];
      if (!st) return "absent";
      const confirmed = st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized";
      if (!confirmed) return "seen";
      // An error is called final only once finalized: a confirmed-but-not-finalized failure could still be re-decided by a fork.
      if (st.err) return st.confirmationStatus === "finalized" ? "failed" : "seen";
      return "landed";
    },

    async depositAccountExists(depositAddress) {
      const depositAta = getAssociatedTokenAddressSync(opts.mint, new PublicKey(depositAddress), true, TOKEN_PROGRAM_ID);
      return (await conn().getAccountInfo(depositAta, "confirmed")) !== null;
    },

    async heights() {
      const [confirmed, finalized] = await Promise.all([conn().getBlockHeight("confirmed"), conn().getBlockHeight("finalized")]);
      return { confirmed, finalized };
    },

    async findIncomingTransfer(afterSignature, amountZats) {
      // Newest first, back to the deposit (`until`), a page at a time (audit S6, lens 4-3): one page of 100 let a hundred dust
      // transfers into the keeper account, which anyone can make, bury the refund for good. Bounded at REFUND_SEARCH_MAX_SIGNATURES
      // per call; the next status poll looks again.
      let before: string | undefined;
      let scanned = 0;
      while (scanned < REFUND_SEARCH_MAX_SIGNATURES) {
        const sigs = await conn().getSignaturesForAddress(keeperAta, { until: afterSignature, before, limit: REFUND_SEARCH_PAGE }, "confirmed");
        for (const s of sigs) {
          if (s.err) continue;
          const tx = await conn().getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx?.meta) continue;
          const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
          const feePayer = keys.get(0);
          if (!feePayer || feePayer.equals(opts.keeper.publicKey)) continue; // our own transactions never count as a refund
          const idx = keys.staticAccountKeys.concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? []).findIndex((k) => k.equals(keeperAta));
          if (idx === -1) continue;
          const pre = BigInt(tx.meta.preTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0");
          const post = BigInt(tx.meta.postTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0");
          if (post - pre === amountZats) return s.signature;
        }
        scanned += sigs.length;
        if (sigs.length < REFUND_SEARCH_PAGE) return null; // the deposit was reached: nothing newer than it paid the refund
        before = sigs[sigs.length - 1]!.signature;
      }
      console.error(`refund search on the keeper account stopped after ${scanned} signatures without reaching the deposit; the next poll looks again`);
      return null;
    },
  };
}

/**
 * True only when a signed transaction can no longer land AND is not on chain:
 * the RPC has no record of it, and the FINALIZED block height has passed its
 * lastValidBlockHeight by a margin. A confirm timeout, a lagging RPC or a
 * crash is never enough on its own.
 */
export async function isProvablyNeverLanded(chain: DepositChain, signature: string, lastValidBlockHeight: number): Promise<boolean> {
  if ((await chain.signatureStatus(signature)) !== "absent") return false;
  const { finalized } = await chain.heights();
  if (finalized <= lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) return false;
  return (await chain.signatureStatus(signature)) === "absent"; // looked again after reading the height
}
