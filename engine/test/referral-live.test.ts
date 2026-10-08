// Referral on the real local validator (the MAINNET DBC and DAMM v2 binaries). Meteora pays a referral out of its OWN
// share: the program takes HOST_FEE_PERCENT (20%) of the protocol part (20% of the pool fee), so 4% of the pool fee,
// and computes the partner part before the referral is applied. The proof here: the same trade with and without a
// referral accrues the SAME partner fee, and the referrer's ZEC account receives exactly the referral amount.
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { buildTradeTx, referralAccountFor, TradeError } from "../src/dbc/trade";
import { claimCoinFees, loadFeeClaimer } from "../src/dbc/claim";
import { readCurveStage, reconcileMigration } from "../src/dbc/migrate";
import * as db from "../src/db";
import { waitForCoinWindow } from "../src/dbc/windowWait";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const QUOTE = config.solana.dbc.quoteMint;
const zecOf = async (owner: PublicKey): Promise<bigint> => {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(QUOTE, owner, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};
const accrued = async (poolId: string) => BigInt((await getDbcClient().state.getPoolFeeMetrics(poolId)).current.partnerQuoteFee.toString());

async function send(txBase64: string, signer: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await getConnection().sendRawTransaction(tx.serialize());
  await getConnection().confirmTransaction(sig, "confirmed");
  return sig;
}

async function launch(): Promise<{ coin: db.CoinRow; creator: Keypair }> {
  await ensureDbcConfig();
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
  const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Ref", symbol: "REF", description: "", imageUrl: "", initialBuyZats: "20000000" });
  await confirmLaunch(await send(txBase64, creator), mint);
  await waitForCoinWindow(mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
  return { coin: db.getCoin(mint)!, creator };
}

/** A wallet with a ZEC token account holding `zats`: what a referrer needs to be paid. */
async function referrerWithAccount(zats = 1_000n): Promise<Keypair> {
  const k = loadKeeperKeypair();
  const r = Keypair.generate();
  const acct = await getOrCreateAssociatedTokenAccount(getConnection(), k, QUOTE, r.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
  await mintTo(getConnection(), k, QUOTE, acct.address, k, zats);
  return r;
}

describe.if(await validatorUp())("referral (real DBC and DAMM v2 programs, local validator)", () => {
  test("DBC curve: the partner fee is identical with and without a referral; the referrer gets 20% of Meteora's 20%", async () => {
    const { coin } = await launch();
    const buyer = Keypair.generate();
    await fundTestWallet(buyer.publicKey, 2, loadKeeperKeypair());
    const referrer = await referrerWithAccount();
    const refBefore = await zecOf(referrer.publicKey);

    const base = await accrued(coin.poolId!);
    const plain = await buildTradeTx({ wallet: buyer.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "10000000", slippageBps: 100 });
    await send(plain.txBase64, buyer);
    const partnerPlain = (await accrued(coin.poolId!)) - base;

    const mid = await accrued(coin.poolId!);
    const withRef = await buildTradeTx({ wallet: buyer.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "10000000", slippageBps: 100, referrer: referrer.publicKey.toBase58() });
    await send(withRef.txBase64, buyer);
    const partnerRef = (await accrued(coin.poolId!)) - mid;

    expect(plain.quote.feeZec).toBe("100000"); // the WHOLE 1% pool fee on 10,000,000
    expect(withRef.quote.feeZec).toBe("100000"); // the quote still reports the whole pool fee
    expect(partnerPlain).toBe(80_000n); // 80% of it
    expect(partnerRef).toBe(partnerPlain); // OUR fee does not move
    // protocol = 20% of 100,000 = 20,000; the host (referral) gets 20% of that = 4,000, out of Meteora's 20,000.
    expect((await zecOf(referrer.publicKey)) - refBefore).toBe(4_000n);
  }, 180_000);

  test("a sell with a referral: the fee is on the ZEC output, the referrer is paid, the partner part is still fee - protocol", async () => {
    const { coin, creator } = await launch();
    const referrer = await referrerWithAccount();
    const refBefore = await zecOf(referrer.publicKey);
    const mintAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(new PublicKey(coin.mint), creator.publicKey, false, (await import("@solana/spl-token")).TOKEN_2022_PROGRAM_ID);
    const balance = (await getAccount(getConnection(), mintAta, "confirmed", (await import("@solana/spl-token")).TOKEN_2022_PROGRAM_ID)).amount;
    const before = await accrued(coin.poolId!);
    const sell = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "sell", amount: (balance / 4n).toString(), slippageBps: 100, referrer: referrer.publicKey.toBase58() });
    await send(sell.txBase64, creator);
    const fee = BigInt(sell.quote.feeZec);
    const protocol = (fee * 20n) / 100n;
    expect((await accrued(coin.poolId!)) - before).toBe(fee - protocol); // partner: untouched by the referral
    expect((await zecOf(referrer.publicKey)) - refBefore).toBe((protocol * 20n) / 100n);
  }, 180_000);

  test("a wrong referral account is refused, never passed to the program", async () => {
    const { coin } = await launch();
    const trader = Keypair.generate().publicKey.toBase58();
    const noAccount = Keypair.generate().publicKey.toBase58();
    await expect(referralAccountFor(noAccount, trader)).rejects.toBeInstanceOf(TradeError); // no ZEC account at all
    await expect(referralAccountFor(trader, trader)).rejects.toBeInstanceOf(TradeError); // referring yourself
    await expect(referralAccountFor("not-a-key", trader)).rejects.toBeInstanceOf(TradeError);
    const ok = await referrerWithAccount();
    expect((await referralAccountFor(ok.publicKey.toBase58(), trader)).toBase58()).toBe(getAssociatedTokenAddressSync(QUOTE, ok.publicKey, false, TOKEN_PROGRAM_ID).toBase58());
    // Through the API: 400 bad_referral naming the field; a malformed referrer is a plain bad_request.
    const call = async (referrer: unknown) =>
      handleRequest(new Request(`http://x/api/coins/${coin.mint}/trade-tx`, { method: "POST", body: JSON.stringify({ wallet: trader, side: "buy", amount: "1000000", slippageBps: 100, referrer }) }));
    const refused = await call(noAccount);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "bad_referral", field: "referrer" });
    expect((await call(12345)).status).toBe(400);
    const accepted = await call(ok.publicKey.toBase58());
    expect(accepted.status).toBe(200);
  }, 120_000);

  test("DAMM v2 after graduation: the position fee is the same with and without a referral; the referrer is paid out of the protocol part", async () => {
    const { coin, creator } = await launch();
    await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
    await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
    const pool = new PublicKey(coin.poolId!);
    for (let i = 0; i < 6 && (await readCurveStage(coin.poolId!)) === "open"; i++) {
      const tx = await getDbcClient().pool.swap2({ owner: creator.publicKey, pool, swapMode: SwapMode.PartialFill, amountIn: new BN(400_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null });
      await sendAndConfirmTransaction(getConnection(), tx, [creator], { commitment: "confirmed" });
    }
    const claimer = loadFeeClaimer();
    const migrated = await reconcileMigration(coin, claimer.publicKey);
    expect(migrated.dammPool).toBeTruthy();
    await claimCoinFees(`epoch-test-${crypto.randomUUID()}`, migrated, claimer); // drain the curve fee so each claim below is one trade's

    const referrer = await referrerWithAccount();
    const refBefore = await zecOf(referrer.publicKey);
    const plain = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "50000000", slippageBps: 100 });
    await send(plain.txBase64, creator);
    const partnerPlain = await claimCoinFees(`epoch-test-${crypto.randomUUID()}`, migrated, claimer);

    const withRef = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "50000000", slippageBps: 100, referrer: referrer.publicKey.toBase58() });
    await send(withRef.txBase64, creator);
    const partnerRef = await claimCoinFees(`epoch-test-${crypto.randomUUID()}`, migrated, claimer);

    // The DAMM v2 fee is dynamic (it rises after the first trade), so the two trades are not the same size of fee. Each is
    // checked against ITS OWN quote: the partner part is the whole fee minus Meteora's 20%, referral or not.
    const partnerOf = (feeZec: string) => BigInt(feeZec) - (BigInt(feeZec) * 20n) / 100n;
    expect(partnerPlain).toBeGreaterThanOrEqual(partnerOf(plain.quote.feeZec) - 2n);
    expect(partnerPlain).toBeLessThanOrEqual(partnerOf(plain.quote.feeZec));
    expect(partnerRef).toBeGreaterThanOrEqual(partnerOf(withRef.quote.feeZec) - 2n); // OUR position fee is not reduced by the referral
    expect(partnerRef).toBeLessThanOrEqual(partnerOf(withRef.quote.feeZec));
    const paid = (await zecOf(referrer.publicKey)) - refBefore;
    expect(paid).toBeGreaterThan(0n);
    expect(paid).toBeLessThanOrEqual(((BigInt(withRef.quote.feeZec) * 20n) / 100n * 20n) / 100n + 1n); // at most 20% of Meteora's 20% (the config's referral percent)
  }, 240_000);
});
