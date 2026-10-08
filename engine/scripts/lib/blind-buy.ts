// A buy for a pool that does not exist yet, built from addresses alone: the pool, its vaults and the buyer's token accounts are all derived from the new coin's mint and the
// config, so the transaction can be signed BEFORE the launch is sent and sent right behind it. That is the only way a stranger's buy lands in the launch's own second (the
// pad's trade-tx cannot build one until the coin exists and the launch has been confirmed, about three seconds on devnet): used to read the 99% step of the launch window off
// the chain (test/launch-window-live.test.ts on the local validator, scripts/devnet-window-proof.ts on devnet). Mode-agnostic: it only builds and signs.
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveDbcPoolAddress, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { config } from "../../src/config";
import { getConnection, getDbcClient } from "../../src/solana";

const EXACT_IN = 0; // the program's swap mode: spend exactly `amountIn`

/** The pool address of the coin `mint` on the config `configId`, as the program derives it. */
export const poolOf = (mint: PublicKey, configId: PublicKey): PublicKey => deriveDbcPoolAddress(config.solana.dbc.quoteMint, mint, configId);

/**
 * `buyer` spends `amountIn` zats of ZEC on the coin `mint` (Token-2022, launched on `configId`), signed and ready to send. `minimumAmountOut` is 0: what is read from the
 * transaction is the FEE it pays, not the price. The buyer's ZEC account must exist and hold the amount; the coin's token account is created in the same transaction.
 */
export async function buildBlindBuy(buyer: Keypair, mint: PublicKey, configId: PublicKey, amountIn: bigint): Promise<VersionedTransaction> {
  const quoteMint = config.solana.dbc.quoteMint;
  const pool = poolOf(mint, configId);
  const baseAta = getAssociatedTokenAddressSync(mint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const swap = await getDbcClient().pool.program.methods
    .swap2({ amount0: new BN(amountIn.toString()), amount1: new BN(0), swapMode: EXACT_IN })
    .accountsPartial({
      baseMint: mint,
      quoteMint,
      pool,
      baseVault: deriveDbcTokenVaultAddress(pool, mint),
      quoteVault: deriveDbcTokenVaultAddress(pool, quoteMint),
      config: configId,
      poolAuthority: deriveDbcPoolAuthority(),
      referralTokenAccount: null,
      inputTokenAccount: getAssociatedTokenAddressSync(quoteMint, buyer.publicKey, false, TOKEN_PROGRAM_ID),
      outputTokenAccount: baseAta,
      payer: buyer.publicKey,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }]) // the program reads it when the config has the first-swap rule
    .instruction();
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: buyer.publicKey,
    recentBlockhash: blockhash,
    instructions: [createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, baseAta, buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID), swap],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([buyer]);
  return tx;
}
