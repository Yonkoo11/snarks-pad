// Non-custodial buy/sell: unsigned tx with the trader's wallet as fee payer,
// same pattern as launch.ts. A coin trades on its DBC curve until it migrates
// and on its DAMM v2 pool after (venue, docs/API.md v2.0; the trading
// fee on both is paid in ZEC. Quote numbers come straight off each SDK's own
// curve computation, the same numbers baked into the instruction's minimum out.
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { getCurrentPoint, SwapMode as DbcSwapMode, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { SwapMode as DammSwapMode, getCurrentPoint as getDammCurrentPoint, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { config } from "../config";
import { getConnection, getCpAmm, getDbcClient, toUnsignedV0Base64, withPriorityFee, waitForSignature } from "../solana";
import * as db from "../db";

export type TradeSide = "buy" | "sell";

export class TradeError extends Error {
  constructor(public code: "unknown_mint" | "tx_not_found" | "tx_failed" | "not_a_trade" | "bad_referral") {
    super(code);
  }
}

export interface TradeParams {
  wallet: string;
  mint: string;
  side: TradeSide;
  amount: string; // base units: quote (ZEC zats) for buy, token raw units for sell
  slippageBps: number;
  /** A wallet whose ZEC token account receives Meteora's host fee on this trade (see referralAccountFor). */
  referrer?: string;
}

export interface TradeQuote {
  in: string;
  out: string;
  minOut: string;
  // The pool trading fee on this trade, in ZEC zats (paid on the input for a
  // buy and on the output for a sell, `collect_fee_mode = QuoteToken`).
  feeZec: string;
}

export interface TradeTxResult {
  txBase64: string;
  quote: TradeQuote;
}

/**
 * The referrer's ZEC token account to pass to the swap, or a refusal. Meteora pays the referral out of ITS OWN share:
 * of the pool fee the protocol takes 20%, and a swap with a referral account moves HOST_FEE_PERCENT (20%) of that
 * protocol part to the account, i.e. 4% of the pool fee. The partner (holders + team) part is computed before the
 * referral is applied and never changes (DBC state/config.rs get_fee_on_amount and split_fees; DAMM v2 state/fee.rs
 * split_fees, same shape; PORT-ASSUMPTIONS D22). The program does not check the referral account's mint (the transfer
 * simply fails), so a wrong account is refused here instead of being passed: it must exist, be a ZEC token account
 * owned by the referrer, initialized and not frozen, and the referrer may not be the trader.
 */
export async function referralAccountFor(referrer: string, trader: string): Promise<PublicKey> {
  let owner: PublicKey;
  try {
    owner = new PublicKey(referrer);
  } catch {
    throw new TradeError("bad_referral");
  }
  if (referrer === trader) throw new TradeError("bad_referral");
  const mint = config.solana.dbc.quoteMint;
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  const info = await getConnection().getAccountInfo(ata, "confirmed");
  if (!info) throw new TradeError("bad_referral");
  try {
    const acct = unpackAccount(ata, info, TOKEN_PROGRAM_ID);
    if (!acct.mint.equals(mint) || !acct.owner.equals(owner) || !acct.isInitialized || acct.isFrozen) throw new TradeError("bad_referral");
  } catch {
    throw new TradeError("bad_referral");
  }
  return ata;
}

async function dbcTrade(coin: db.CoinRow, p: TradeParams, referral: PublicKey | null): Promise<{ instructions: TransactionInstruction[]; quote: TradeQuote }> {
  const client = getDbcClient();
  const pool = new PublicKey(coin.poolId!);
  const virtualPool = await client.state.getPool(pool);
  const poolConfig: PoolConfig | null = virtualPool ? await client.state.getPoolConfig(virtualPool.poolState.config) : null;
  if (!virtualPool || !poolConfig) throw new TradeError("unknown_mint");

  const swapBaseForQuote = p.side === "sell";
  const amountIn = new BN(p.amount);
  const q = client.pool.swapQuote2({
    virtualPool, config: poolConfig, swapBaseForQuote, hasReferral: referral !== null, eligibleForFirstSwapWithMinFee: false,
    currentPoint: await withBlockRetry(() => getCurrentPoint(getConnection(), poolConfig.activationType)), slippageBps: p.slippageBps,
    swapMode: DbcSwapMode.ExactIn, amountIn,
  });
  const minOut = q.minimumAmountOut ?? new BN(0);
  const tx = await client.pool.swap({ owner: new PublicKey(p.wallet), pool, amountIn, minimumAmountOut: minOut, swapBaseForQuote, referralTokenAccount: referral });
  const fee = q.tradingFee.add(q.protocolFee).add(q.referralFee); // the whole pool fee, with or without a referral
  return { instructions: tx.instructions, quote: { in: p.amount, out: q.outputAmount.toString(), minOut: minOut.toString(), feeZec: fee.toString() } };
}

/**
 * The SDKs' current-point read is getSlot() then getBlockTime(slot). On Helius devnet the block of a just-confirmed
 * slot is sometimes not yet readable ("failed to get block time for slot N: Block not available"; seen on 2026-10-03
 * in the server soak, which then failed a share of its quotes). A short retry reads a slot whose block is there.
 */
export async function withBlockRetry<T>(read: () => Promise<T>, tries = 4, waitMs = 400): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (i >= tries || !/block not available|failed to get block time/i.test(msg)) throw err;
      await Bun.sleep(waitMs * i);
    }
  }
}

async function dammTrade(coin: db.CoinRow, p: TradeParams, referral: PublicKey | null): Promise<{ instructions: TransactionInstruction[]; quote: TradeQuote }> {
  const cp = getCpAmm();
  const dammPool = new PublicKey(coin.dammPool!);
  const poolState = await cp.fetchPoolState(dammPool);
  const quoteMint = config.solana.dbc.quoteMint;
  const coinMint = new PublicKey(coin.mint);
  const [inMint, outMint] = p.side === "buy" ? [quoteMint, coinMint] : [coinMint, quoteMint];
  const decimalsOf = (m: PublicKey) => (m.equals(quoteMint) ? config.solana.dbc.quoteDecimals : config.solana.dbc.baseDecimals);
  const amountIn = new BN(p.amount);
  const currentPoint = await withBlockRetry(() => getDammCurrentPoint(getConnection(), poolState.activationType));
  const q = cp.getQuote2({
    inputTokenMint: inMint, slippage: p.slippageBps / 100, currentPoint, poolState, hasReferral: referral !== null,
    tokenADecimal: decimalsOf(poolState.tokenAMint), tokenBDecimal: decimalsOf(poolState.tokenBMint),
    swapMode: DammSwapMode.ExactIn, amountIn,
  });
  const built = await cp.swap2({
    payer: new PublicKey(p.wallet), pool: dammPool, poolState, swapMode: DammSwapMode.ExactIn, amountIn, minimumAmountOut: q.minimumAmountOut ?? new BN(0),
    inputTokenMint: inMint, outputTokenMint: outMint, tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag), tokenBProgram: getTokenProgram(poolState.tokenBFlag), referralTokenAccount: referral,
  });
  const tx = await built;
  return { instructions: tx.instructions, quote: { in: p.amount, out: q.outputAmount.toString(), minOut: (q.minimumAmountOut ?? new BN(0)).toString(), feeZec: q.claimingFee.add(q.protocolFee).add(q.referralFee).toString() } };
}

export async function buildTradeTx(p: TradeParams): Promise<TradeTxResult> {
  const coin = db.getCoin(p.mint);
  if (!coin || coin.status !== "launched" || !coin.poolId) throw new TradeError("unknown_mint");
  const wallet = new PublicKey(p.wallet);
  const referral = p.referrer ? await referralAccountFor(p.referrer, p.wallet) : null;
  const built = coin.dammPool ? await dammTrade(coin, p, referral) : await dbcTrade(coin, p, referral);
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  return { txBase64: toUnsignedV0Base64(withPriorityFee(built.instructions), wallet, blockhash), quote: built.quote };
}

export function recordTrade(sig: string, p: TradeParams, quote: TradeQuote): void {
  db.insertTrade({
    sig,
    mint: p.mint,
    side: p.side,
    wallet: p.wallet,
    amountToken: p.side === "buy" ? quote.out : p.amount,
    amountZec: p.side === "buy" ? p.amount : quote.out,
    at: new Date().toISOString(),
  });
}

/**
 * Records a trade the browser signed and sent itself (the server never sees
 * the signed tx). Everything recorded is read back from the chain: the tx
 * must have confirmed without error and touched this coin's pool (the DBC
 * curve or, after migration, its DAMM v2 pool); side and amounts come from the
 * fee payer's pre/post token balances. Idempotent per sig.
 */
export async function confirmTrade(sig: string, mint: string): Promise<db.TradeRow> {
  const coin = db.getCoin(mint);
  if (!coin || coin.status !== "launched" || !coin.poolId) throw new TradeError("unknown_mint");
  const status = await waitForSignature(sig);
  if (!status) throw new TradeError("tx_not_found");
  if (status.err) throw new TradeError("tx_failed");
  return recordTradeFromTx(sig, mint);
}

/**
 * Records the trade a confirmed transaction made in this coin, read from the transaction once with no wait (the caller saw it confirmed): the confirm of a
 * trade, and a launch's own first buy (api.ts, audit S5-02). Throws not_a_trade when the transaction moved none of the coin for its fee payer.
 */
export async function recordTradeFromTx(sig: string, mint: string): Promise<db.TradeRow> {
  const coin = db.getCoin(mint);
  if (!coin || coin.status !== "launched" || !coin.poolId) throw new TradeError("unknown_mint");
  const tx = await getConnection().getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta) throw new TradeError("tx_not_found");
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).staticAccountKeys.map((k) => k.toBase58());
  if (!keys.includes(coin.poolId) && !(coin.dammPool && keys.includes(coin.dammPool))) throw new TradeError("not_a_trade");
  const payer = keys[0]!;

  const quoteMint = config.solana.dbc.quoteMint.toBase58();
  const delta = (m: string): bigint => {
    const sum = (list: typeof tx.meta.preTokenBalances) =>
      (list ?? []).filter((b) => b.mint === m && b.owner === payer).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(tx.meta!.postTokenBalances) - sum(tx.meta!.preTokenBalances);
  };
  const dToken = delta(mint);
  const dZec = delta(quoteMint);
  if (dToken === 0n) throw new TradeError("not_a_trade");
  const row: db.TradeRow = {
    sig,
    mint,
    side: dToken > 0n ? "buy" : "sell",
    wallet: payer,
    amountToken: (dToken < 0n ? -dToken : dToken).toString(),
    amountZec: (dZec < 0n ? -dZec : dZec).toString(),
    at: new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  db.insertTrade(row);
  return row;
}

