// A creator's own fee on a fee-tier coin. The creator's share is never in our vault: Meteora records it in the pool
// (`creator_quote_fee`) and, after graduation, in the creator's own locked DAMM v2 position, and only the pool's creator
// wallet can claim either (DBC `claim_creator_trading_fee` runs under `is_pool_creator`, access_control.rs:35-40; a DAMM v2
// position is claimed by its NFT's owner). So this module builds an UNSIGNED transaction for the creator to sign and send; the
// pad signs nothing and holds nothing here, and it must never load the keeper key (INV-17: test/api-no-keeper.test.ts).
//
// The authority is the CHAIN: the wallet must equal the pool's recorded creator, read now, not the creator written in our
// database (the pool's creator can be handed to another wallet, `transfer_pool_creator`). A wallet that is not the creator is
// refused before any transaction is built; the program would refuse it too.
import { PublicKey, Transaction } from "@solana/web3.js";
import { U64_MAX } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getTokenProgram, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { config } from "../config";
import { getConnection, getCpAmm, getDbcClient, toUnsignedV0Base64, withPriorityFee } from "../solana";
import * as db from "../db";
import type { CoinRow } from "../db";
import { coinTier } from "./read";
import { reviewedTier } from "./reviewed";

export type CreatorClaimKind = "curve" | "pool";

export type CreatorClaimErrorCode = "unknown_mint" | "not_creator" | "no_creator_fee" | "nothing_to_claim";

export class CreatorClaimError extends Error {
  constructor(public code: CreatorClaimErrorCode) {
    super(code);
  }
}

export interface CreatorFees {
  /** The wallet the chain records as this pool's creator: the only one that can claim. */
  creator: string;
  /** This coin's creator share of the whole fee, in bps (0 on the 1% tier: nothing is ever owed to a creator). */
  creatorShareBps: number;
  /** Unclaimed ZEC the curve holds for the creator (zats), claimable at any time. */
  curveZats: bigint;
  /** Unclaimed ZEC in the creator's locked DAMM v2 position(s) after graduation (zats); 0 before. */
  poolZats: bigint;
  graduated: boolean;
}

function launchedCoin(mint: string): CoinRow {
  const coin = db.getCoin(mint);
  if (!coin || coin.status !== "launched" || !coin.poolId) throw new CreatorClaimError("unknown_mint");
  return coin;
}

async function chainCreatorOf(coin: CoinRow): Promise<PublicKey> {
  const pool = await getDbcClient().state.getPool(coin.poolId!);
  if (!pool) throw new CreatorClaimError("unknown_mint");
  return pool.poolState.creator;
}

async function poolPositions(coin: CoinRow, creator: PublicKey) {
  const cp = getCpAmm();
  const dammPool = new PublicKey(coin.dammPool!);
  const pool = await cp.fetchPoolState(dammPool);
  return { cp, dammPool, pool, positions: await cp.getUserPositionByPool(dammPool, creator) };
}

async function positionFeeZats(coin: CoinRow, creator: PublicKey): Promise<bigint> {
  const { pool, positions } = await poolPositions(coin, creator);
  const quoteIsA = pool.tokenAMint.equals(config.solana.dbc.quoteMint);
  return positions.reduce((sum, p) => {
    const fee = getUnClaimLpFee(pool, p.positionState);
    return sum + BigInt((quoteIsA ? fee.feeTokenA : fee.feeTokenB).toString());
  }, 0n);
}

/** What the creator of `mint` can claim right now, read from the chain. Public numbers: anyone can read them. */
export async function readCreatorFees(mint: string): Promise<CreatorFees> {
  const coin = launchedCoin(mint);
  const tier = reviewedTier(coinTier(coin))!;
  const creator = await chainCreatorOf(coin);
  const creatorShareBps = (8000 * tier.creatorFeePercentage) / 100;
  const { current } = await getDbcClient().state.getPoolFeeMetrics(coin.poolId!);
  const graduated = !!coin.dammPool;
  return {
    creator: creator.toBase58(),
    creatorShareBps,
    curveZats: BigInt(current.creatorQuoteFee.toString()),
    poolZats: graduated && creatorShareBps > 0 ? await positionFeeZats(coin, creator) : 0n,
    graduated,
  };
}

async function curveClaimIxs(coin: CoinRow, creator: PublicKey): Promise<Transaction> {
  return getDbcClient().creator.claimCreatorTradingFee({
    creator, payer: creator, pool: new PublicKey(coin.poolId!), maxBaseAmount: new BN(U64_MAX.toString()), maxQuoteAmount: new BN(U64_MAX.toString()),
  });
}

async function poolClaimIxs(coin: CoinRow, creator: PublicKey): Promise<Transaction> {
  const { cp, dammPool, pool, positions } = await poolPositions(coin, creator);
  const tx = new Transaction();
  for (const p of positions) {
    const claim = await cp.claimPositionFee2({
      owner: creator, receiver: creator, pool: dammPool, position: p.position, positionNftAccount: p.positionNftAccount,
      tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
      tokenAProgram: getTokenProgram(pool.tokenAFlag), tokenBProgram: getTokenProgram(pool.tokenBFlag), feePayer: creator,
    });
    tx.add(...claim.instructions);
  }
  return tx;
}

export interface CreatorClaimTx {
  txBase64: string;
  kind: CreatorClaimKind;
  /** What the claim moves to the creator's ZEC account at the time of building (zats); it can only grow before the creator signs. */
  claimableZats: string;
}

/**
 * An unsigned claim for `wallet` (fee payer and signer: the creator). `kind` picks the curve fee or the graduated pool's;
 * omitted, the curve fee comes first, then the pool's. Refuses a wallet that is not the pool's creator on chain, a coin whose tier
 * has no creator share, and a claim of nothing.
 */
export async function buildCreatorClaimTx(mint: string, wallet: string, kind?: CreatorClaimKind): Promise<CreatorClaimTx> {
  const fees = await readCreatorFees(mint);
  if (fees.creator !== wallet) throw new CreatorClaimError("not_creator");
  if (fees.creatorShareBps === 0) throw new CreatorClaimError("no_creator_fee");
  const chosen: CreatorClaimKind | null = kind ?? (fees.curveZats > 0n ? "curve" : fees.poolZats > 0n ? "pool" : null);
  const amount = chosen === "curve" ? fees.curveZats : chosen === "pool" ? fees.poolZats : 0n;
  if (!chosen || amount <= 0n) throw new CreatorClaimError("nothing_to_claim");
  const coin = launchedCoin(mint);
  const creator = new PublicKey(wallet);
  const tx = chosen === "curve" ? await curveClaimIxs(coin, creator) : await poolClaimIxs(coin, creator);
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  return { txBase64: toUnsignedV0Base64(withPriorityFee(tx.instructions), creator, blockhash, []), kind: chosen, claimableZats: amount.toString() };
}
