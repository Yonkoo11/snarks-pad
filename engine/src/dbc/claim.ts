// Fee claims. Replaces the old harvest+sell step: a coin's pool fee is already
// paid in ZEC, so claiming it is one transaction and the ZEC lands in the
// keeper's Solana ZEC account. There is no swap and no withheld-token sweep.
//
// Three claim kinds per coin (db.ClaimKind): the DBC partner trading fee
// (curve stage), the DAMM v2 position fee (after migration), and the partner
// surplus (after migration). Each is resumable: the claim is signed, its
// signature + signed bytes are persisted, and only then broadcast, so a crash
// resumes by checking that signature's chain status rather than claiming twice
// (engine/README.md "Payout resume design"). The amount of each claim is the
// change in the keeper's ZEC balance inside THAT claim transaction, never a
// before/after poll of the shared account (getTokenBalanceDelta).
//
// WHO signs a claim is a FeeClaimer (the config's `fee_claimer` is permanent):
// a local keypair (this file) or a Squads v4 vault whose claims need the
// owner's approval (dbc/squads.ts). Both implement `advance`, one resumable
// step that either returns the signature of a landed claim or says what it is
// waiting for.
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { U64_MAX, deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getTokenProgram, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import bs58 from "bs58";
import { config } from "../config";
import {
  broadcastAndConfirm, getConnection, getCpAmm, getDbcClient, getTokenBalanceDelta, isSignatureLanded, waitForSignature,
} from "../solana";
import { loadKeeperKeypair } from "../keeper";
import * as db from "../db";
import type { ClaimKind, CoinRow } from "../db";
import { coinTier } from "./read";
import { reviewedTier } from "./reviewed";

export interface ClaimId {
  epochId: string;
  mint: string;
  kind: ClaimKind;
}

/**
 * A claim split by who must sign it. `claimIxs` are the Meteora instructions
 * that name the fee claimer as signer; `setupIxs` are keeper-paid, idempotent
 * account creations (the receiver's token accounts) that need nobody else's
 * signature. A Squads vault cannot sign for a setup instruction paid by the
 * keeper, so the split is what lets the same builder serve both claimers.
 */
export interface ClaimParts {
  setupIxs: TransactionInstruction[];
  claimIxs: TransactionInstruction[];
}

export type ClaimBuilder = () => Promise<ClaimParts>;

export type Advance = { sig: string } | { pending: string };

export interface FeeClaimer {
  /** The address written into the DBC config and the DAMM v2 partner position: a keypair's key or a vault PDA. */
  readonly publicKey: PublicKey;
  /**
   * One resumable step of a claim. Returns the signature of a claim that landed,
   * or `{ pending }` while something outside the keeper (an owner approval) is
   * awaited. Safe to call repeatedly for the same ClaimId: it picks up from the
   * row persisted in claim_progress.
   */
  advance(id: ClaimId, build: ClaimBuilder): Promise<Advance>;
  /** Called once a claim is confirmed and measured: housekeeping that needs no approval (a Squads claimer closes the finished proposal to recover its rent). */
  settle?(id: ClaimId): Promise<void>;
}

export class ClaimPending extends Error {
  constructor(public id: ClaimId, public detail: string) {
    super(`claim ${id.kind} for ${id.mint} is waiting: ${detail}`);
  }
}

/** The Meteora programs whose instructions need the fee claimer's signature. */
const isClaimProgram = (ix: TransactionInstruction) =>
  ix.programId.equals(config.solana.dbc.programId) || ix.programId.equals(config.solana.dbc.dammProgramId);

/** Splits an SDK-built transaction into keeper-paid setup and the claim instructions proper. */
export function splitClaimTx(tx: Transaction): ClaimParts {
  return { setupIxs: tx.instructions.filter((ix) => !isClaimProgram(ix)), claimIxs: tx.instructions.filter(isClaimProgram) };
}

/**
 * True once a signed claim can never land: its blockhash's last valid block height has passed (at the FINALIZED height, which
 * cannot roll back) and it is still not on chain when looked at again after that read (audit S6-K1: one status answer from a
 * lagging node must not let a transaction that lands late be forgotten and signed a second time).
 */
export async function isExpiredAndUnlanded(sig: string, lastValidBlockHeight: number): Promise<boolean> {
  if (await isSignatureLanded(sig)) return false;
  if ((await getConnection().getBlockHeight("finalized")) <= lastValidBlockHeight) return false;
  return !(await isSignatureLanded(sig));
}

/** Signs `tx` with the keeper as fee payer (plus `extra` signers), persists it for `id` BEFORE it is broadcast. Returns its signature and bytes. */
export async function signAndPersist(
  id: ClaimId, tx: Transaction, extra: Keypair[], phase: db.ClaimPhase, ref: string | null, persist: "insert" | "replace",
): Promise<{ sig: string; raw: Buffer; lastValidBlockHeight: number }> {
  const keeper = loadKeeperKeypair();
  const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = blockhash;
  tx.partialSign(keeper, ...extra.filter((k) => !k.publicKey.equals(keeper.publicKey)));
  const sig = bs58.encode(tx.signature!);
  const raw = Buffer.from(tx.serialize());
  const row = { ...id, sig, rawTx: raw.toString("base64"), lastValidBlockHeight };
  if (persist === "insert") db.recordClaimSigned({ ...row, phase, ref });
  else db.replaceClaimTx({ ...row, phase });
  return { sig, raw, lastValidBlockHeight };
}

/** Option A of plan 4 "Key custody": a local keypair (the keeper's own) is the fee claimer. */
export function localKeypairFeeClaimer(keypair: Keypair): FeeClaimer {
  return {
    publicKey: keypair.publicKey,
    async advance(id, build) {
      const existing = db.getClaimProgress(id.epochId, id.mint, id.kind);
      if (existing) {
        if (await isSignatureLanded(existing.sig)) return { sig: existing.sig };
        try {
          await broadcastAndConfirm(new Uint8Array(Buffer.from(existing.rawTx, "base64")), existing.sig);
          return { sig: existing.sig };
        } catch (err) {
          if (!(await isExpiredAndUnlanded(existing.sig, existing.lastValidBlockHeight))) throw err; // not landed yet, not expired: try again next resume
          db.clearUnlandedClaim(id.epochId, id.mint, id.kind); // it can never land: build a fresh one
        }
      }
      const { setupIxs, claimIxs } = await build();
      const tx = new Transaction().add(...setupIxs, ...claimIxs);
      const { sig, raw } = await signAndPersist(id, tx, [keypair], "single", null, "insert"); // durable, BEFORE broadcasting
      await broadcastAndConfirm(raw, sig);
      return { sig };
    },
  };
}

/** The keeper key as the fee claimer. Loads the secret key: keeper-side code only, never the HTTP API. */
export function loadFeeClaimer(): FeeClaimer {
  return localKeypairFeeClaimer(loadKeeperKeypair());
}

async function keeperQuoteAta(): Promise<PublicKey> {
  const keeper = loadKeeperKeypair();
  const { address } = await getOrCreateAssociatedTokenAccount(getConnection(), keeper, config.solana.dbc.quoteMint, keeper.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  return address;
}

/** Waits for `sig` to reach the commitment that makes its ZEC countable, then reads the keeper ZEC account's change inside that one transaction. */
async function measure(sig: string, quoteAta: PublicKey): Promise<bigint> {
  const commitment = config.solana.dbc.claimCommitment;
  if (commitment === "finalized") {
    const result = await waitForSignature(sig, 90_000, "finalized");
    if (!result) throw new Error(`claim ${sig} landed but is not finalized yet; the next resume measures it`);
    if (result.err) throw new Error(`claim ${sig} failed on chain: ${JSON.stringify(result.err)}`);
  }
  return getTokenBalanceDelta(sig, quoteAta, 5, commitment);
}

/**
 * Runs one claim as far as it can go. Returns the ZEC that landed in the
 * keeper's account (measured from the claim tx itself) once the claim is done;
 * throws ClaimPending while an approval is awaited. Safe to call any number of
 * times for the same (epoch, coin, kind): a confirmed claim returns its
 * recorded amount without touching the chain.
 */
export async function runClaim(epochId: string, mint: string, kind: ClaimKind, build: ClaimBuilder, claimer: FeeClaimer): Promise<bigint> {
  const existing = db.getClaimProgress(epochId, mint, kind);
  if (existing?.status === "confirmed") return BigInt(existing.amountZats ?? "0");
  const quoteAta = await keeperQuoteAta();
  const id: ClaimId = { epochId, mint, kind };
  const step = await claimer.advance(id, build);
  if ("pending" in step) throw new ClaimPending(id, step.pending);
  const amount = await measure(step.sig, quoteAta);
  db.recordClaimConfirmed(epochId, mint, kind, amount);
  await claimer.settle?.(id).catch((err) => console.error(`settling claim ${kind} for ${mint} failed (the claim itself is recorded):`, (err as Error)?.message ?? err));
  return amount;
}

/** DBC `claim_partner_trading_fee`: everything the curve has accrued for the partner, paid to the keeper's ZEC account. */
export function tradingFeeBuilder(coin: CoinRow, claimer: FeeClaimer): ClaimBuilder {
  return async () => {
    const keeper = loadKeeperKeypair().publicKey;
    return splitClaimTx(
      await getDbcClient().partner.claimPartnerTradingFee({
        feeClaimer: claimer.publicKey,
        payer: keeper,
        pool: new PublicKey(coin.poolId!),
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
        receiver: keeper,
      }),
    );
  };
}

/**
 * DBC `partner_withdraw_surplus`: the quote the curve raised beyond the
 * migration threshold, payable to the partner once the curve is complete. Built
 * by hand because the SDK's builder pays the FEE CLAIMER'S OWN token account
 * (dist/index.js partnerWithdrawSurplus): with a vault that is the vault's
 * account, and the keeper would measure 0 and holders would never be paid.
 */
export function surplusBuilder(coin: CoinRow, claimer: FeeClaimer): ClaimBuilder {
  return async () => {
    const client = getDbcClient();
    const poolId = new PublicKey(coin.poolId!);
    const virtualPool = await client.state.getPool(poolId);
    if (!virtualPool) throw new Error(`DBC pool ${coin.poolId} not found`);
    const poolConfigState = await client.state.getPoolConfig(virtualPool.poolState.config);
    if (!poolConfigState) throw new Error(`DBC config ${virtualPool.poolState.config.toBase58()} not found`);
    const receiver = await keeperQuoteAta();
    const ix = await client.partner.program.methods
      .partnerWithdrawSurplus()
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(),
        config: virtualPool.poolState.config,
        virtualPool: poolId,
        tokenQuoteAccount: receiver,
        quoteVault: virtualPool.poolState.quoteVault,
        quoteMint: poolConfigState.quoteMint,
        feeClaimer: claimer.publicKey,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return { setupIxs: [], claimIxs: [ix] };
  };
}

/** DAMM v2 `claim_position_fee` on the partner's permanently locked LP position(s), paid to the keeper. */
export function dammPositionFeeBuilder(coin: CoinRow, claimer: FeeClaimer): ClaimBuilder {
  return async () => {
    const cp = getCpAmm();
    const keeper = loadKeeperKeypair().publicKey;
    const dammPool = new PublicKey(coin.dammPool!);
    const pool = await cp.fetchPoolState(dammPool);
    const positions = await cp.getUserPositionByPool(dammPool, claimer.publicKey);
    const tx = new Transaction();
    for (const p of positions) {
      const claim = await cp.claimPositionFee2({
        owner: claimer.publicKey, receiver: keeper, pool: dammPool, position: p.position,
        positionNftAccount: p.positionNftAccount, tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint,
        tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
        tokenAProgram: getTokenProgram(pool.tokenAFlag), tokenBProgram: getTokenProgram(pool.tokenBFlag),
        feePayer: keeper,
      });
      tx.add(...claim.instructions);
    }
    return splitClaimTx(tx);
  };
}

/** Worth a claim: the accrued ZEC reaches `config.epoch.minClaimZats` (any base-token fee, which QuoteToken mode never produces, is claimed at once). */
async function hasUnclaimedTradingFee(coin: CoinRow): Promise<boolean> {
  const { current } = await getDbcClient().state.getPoolFeeMetrics(coin.poolId!);
  return BigInt(current.partnerQuoteFee.toString()) >= config.epoch.minClaimZats || !current.partnerBaseFee.isZero();
}

async function hasUnclaimedPositionFee(coin: CoinRow, claimer: FeeClaimer): Promise<boolean> {
  const cp = getCpAmm();
  const dammPool = new PublicKey(coin.dammPool!);
  const pool = await cp.fetchPoolState(dammPool);
  const positions = await cp.getUserPositionByPool(dammPool, claimer.publicKey);
  const quoteIsA = pool.tokenAMint.equals(config.solana.dbc.quoteMint);
  const accrued = positions.reduce((sum, p) => {
    const fee = getUnClaimLpFee(pool, p.positionState);
    return sum + BigInt((quoteIsA ? fee.feeTokenA : fee.feeTokenB).toString());
  }, 0n);
  return accrued >= config.epoch.minClaimZats;
}

/**
 * The partner's surplus: 80% of (quote_reserve - migration threshold), less the
 * creator's `creator_trading_fee_percentage` of that (state/virtual_pool.rs:1130-1151;
 * all of it is ours on the 1% tier, whose creator share is 0), payable once, once the curve is complete. Measured on
 * the local validator, a curve filled by partial-fill buys ends 1 raw unit
 * over the threshold, so the surplus is 0 and no claim (and no owner approval)
 * is worth making; the claim runs only when the amount is positive.
 */
/** `creator_trading_fee_percentage` of the config the coin launched on (0 for the 1% tier). */
function creatorPercentageOf(coin: CoinRow): number {
  return reviewedTier(coinTier(coin))?.creatorFeePercentage ?? 0;
}

async function hasPartnerSurplus(coin: CoinRow): Promise<boolean> {
  const client = getDbcClient();
  const pool = await client.state.getPool(coin.poolId!);
  if (!pool || pool.poolState.isPartnerWithdrawSurplus !== 0) return false;
  const threshold = await client.state.getPoolMigrationQuoteThreshold(coin.poolId!);
  const reserve = pool.poolState.quoteReserve;
  if (!reserve.gt(threshold)) return false;
  const partnerAndCreator = reserve.sub(threshold).muln(80).divn(100); // PARTNER_AND_CREATOR_SURPLUS_SHARE
  const creator = partnerAndCreator.muln(creatorPercentageOf(coin)).divn(100); // rounded down, as the program does
  return partnerAndCreator.sub(creator).gtn(0);
}

/**
 * Claims everything a coin has accrued for the partner and returns the ZEC
 * that landed, summed over the claim kinds (each measured from its own tx).
 * A kind with nothing accrued is skipped without sending a transaction, unless
 * a claim for it was already started this epoch: then it is resumed first.
 * Throws ClaimPending if a kind is waiting on an approval.
 */
export async function claimCoinFees(epochId: string, coin: CoinRow, claimer: FeeClaimer): Promise<bigint> {
  const steps: { kind: ClaimKind; build: ClaimBuilder; due: () => Promise<boolean> }[] = [
    { kind: "trading", build: tradingFeeBuilder(coin, claimer), due: () => hasUnclaimedTradingFee(coin) },
  ];
  if (coin.dammPool) {
    steps.push({ kind: "damm_position", build: dammPositionFeeBuilder(coin, claimer), due: () => hasUnclaimedPositionFee(coin, claimer) });
  }
  // The surplus is payable as soon as the curve is complete, which is before
  // the migration transaction lands; reconcileMigration runs first, so by now
  // the coin is migrated or the curve is not full.
  steps.push({ kind: "surplus", build: surplusBuilder(coin, claimer), due: () => hasPartnerSurplus(coin) });
  let total = 0n;
  for (const s of steps) {
    const started = db.getClaimProgress(epochId, coin.mint, s.kind);
    // A held kind stays in the pool this round (config.epoch.heldClaimKinds), unless its claim already started.
    if (!started && config.epoch.heldClaimKinds.has(s.kind)) continue;
    if (!started && !(await s.due())) continue;
    total += await runClaim(epochId, coin.mint, s.kind, s.build, claimer);
  }
  return total;
}
