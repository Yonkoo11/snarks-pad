// Live proof of the claim path against the real local validator running the
// MAINNET Meteora DBC binary (guarded: skipped if it isn't reachable). Real
// launch, real trades, real signing and broadcast: not a mock.
//
//  - a claim's amount is what the claim transaction itself moved, even while
//    unrelated ZEC lands in the same keeper account (a before/after poll of the
//    shared account would have counted it);
//  - a claim that was signed and persisted but never broadcast (crash) resumes
//    by sending the SAME signed bytes: one claim, not two;
//  - a signed claim whose blockhash expired without landing is forgotten and
//    rebuilt, and pays out exactly once.
import { describe, expect, test } from "bun:test";
import { LAMPORTS_PER_SOL, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { config } from "../src/config";
import { getConnection, getCpAmm, getDbcClient, getTokenBalanceDelta, waitForSignature } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { ensureDbcConfig, recordKeeperIdentity } from "../src/dbc/setup";
import { checkConfigOnChain, requireDbcConfig } from "../src/dbc/config";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { buildTradeTx } from "../src/dbc/trade";
import { claimCoinFees, loadFeeClaimer, runClaim, signAndPersist, surplusBuilder, tradingFeeBuilder } from "../src/dbc/claim";
import { decodeClaimReceivers, resolveInstructions } from "../src/dbc/squads";
import { getAllTokenAccountsForMint, getExcludedOwners, snapshotHolders } from "../src/holders";
import { deriveDammV2PoolAuthority, deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
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
const keeperAta = () => getAssociatedTokenAddressSync(QUOTE, loadKeeperKeypair().publicKey, false, TOKEN_PROGRAM_ID);
const keeperZec = async () => (await getAccount(getConnection(), keeperAta(), "confirmed", TOKEN_PROGRAM_ID)).amount;
const epochId = () => `epoch-test-${crypto.randomUUID()}`;

async function send(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function launchCoin(firstBuyZats: string): Promise<{ coin: db.CoinRow; creator: Keypair }> {
  await ensureDbcConfig(); // the API only reads a config; the keeper-side setup creates it (idempotent)
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
  const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Live", symbol: "LIVE", description: "", imageUrl: "", initialBuyZats: firstBuyZats });
  await confirmLaunch(await send(txBase64, creator), mint);
  await waitForCoinWindow(mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
  return { coin: db.getCoin(mint)!, creator };
}

const accrued = async (poolId: string) => BigInt((await getDbcClient().state.getPoolFeeMetrics(poolId)).current.partnerQuoteFee.toString());

// a launch now ends with the launch window's wait (launchCoin), a few seconds on the chain's own clock: the tests that launch get the time (the default is 5 s)
const slow = (name: string, fn: () => Promise<void>) => test(name, fn, 60_000);

describe.if(await validatorUp())("claims against the real DBC program (live validator)", () => {
  test("a recorded config the chain does not have (validator reset) is never trusted: the keeper replaces it, the API refuses it", async () => {
    const claimer = config.solana.dbc.feeClaimer ?? recordKeeperIdentity();
    const ghost = Keypair.generate().publicKey.toBase58();
    db.insertDbcConfig({ configId: ghost, feeBps: config.solana.dbc.feeBps, feeClaimer: claimer.toBase58(), migrationQuoteThreshold: "1", dammConfig: config.solana.dbc.dammConfig.toBase58(), poolCreationFeeLamports: "0", createdAt: new Date().toISOString() });
    expect(db.getLatestDbcConfig()!.configId).toBe(ghost);
    await expect(requireDbcConfig()).rejects.toThrow(/fails the on-chain check/);
    const cfg = await ensureDbcConfig();
    expect(cfg.configId).not.toBe(ghost);
    expect((await checkConfigOnChain(new PublicKey(cfg.configId), claimer)).ok).toBe(true);
    expect((await requireDbcConfig()).configId).toBe(cfg.configId);
    // An existing account the DBC program does not own (the quote mint) is refused too.
    const notDbc = await checkConfigOnChain(QUOTE, claimer);
    expect(notDbc.ok).toBe(false);
    if (!notDbc.ok) expect(notDbc.problems.join()).toMatch(/is not the DBC program/);
  });

  slow("launch: the coin is on this pad's config, a first buy accrues exactly 80% of the 1% fee for the partner", async () => {
    const cfg = await ensureDbcConfig();
    const { coin } = await launchCoin("20000000");
    expect(coin.status).toBe("launched");
    expect(coin.configId).toBe(cfg.configId);
    expect(await accrued(coin.poolId!)).toBe(160_000n); // 1% of 20,000,000 = 200,000; Meteora keeps 20%
  });

  slow("a crash after signing (before broadcast) resumes with the same signed bytes; the amount ignores unrelated ZEC arriving in the same account", async () => {
    const { coin } = await launchCoin("20000000");
    const claimer = loadFeeClaimer();
    const epoch = epochId();
    const expected = await accrued(coin.poolId!);

    // Sign and persist exactly as the claimer does, then "crash" before broadcasting.
    const keeper = loadKeeperKeypair();
    const parts = await tradingFeeBuilder(coin, claimer)();
    const { sig } = await signAndPersist({ epochId: epoch, mint: coin.mint, kind: "trading" }, new Transaction().add(...parts.setupIxs, ...parts.claimIxs), [keeper], "single", null, "insert");
    expect(await accrued(coin.poolId!)).toBe(expected); // nothing has been claimed yet

    // Unrelated ZEC lands in the keeper's account between the crash and the resume.
    await mintTo(getConnection(), keeper, QUOTE, keeperAta(), keeper, 777_777n);
    const before = await keeperZec();

    const amount = await runClaim(epoch, coin.mint, "trading", tradingFeeBuilder(coin, claimer), claimer);
    expect(amount).toBe(expected); // a before/after poll would have said expected + 777,777
    expect((await keeperZec()) - before).toBe(expected);
    expect(db.getClaimProgress(epoch, coin.mint, "trading")).toMatchObject({ sig, status: "confirmed", amountZats: expected.toString() }); // the original signature, not a second claim

    const again = await runClaim(epoch, coin.mint, "trading", tradingFeeBuilder(coin, claimer), claimer);
    expect(again).toBe(expected);
    expect(await keeperZec()).toBe(before + expected); // replaying a confirmed claim moves nothing
  });

  slow("a signed claim whose blockhash expired without landing is cleared and rebuilt, paying out exactly once", async () => {
    const { coin } = await launchCoin("20000000");
    const claimer = loadFeeClaimer();
    const epoch = epochId();
    const expected = await accrued(coin.poolId!);
    db.recordClaimSigned({ epochId: epoch, mint: coin.mint, kind: "trading", sig: bs58.encode(new Uint8Array(64).fill(9)), rawTx: Buffer.from(new Uint8Array(40)).toString("base64"), lastValidBlockHeight: 1 });
    const before = await keeperZec();
    const amount = await runClaim(epoch, coin.mint, "trading", tradingFeeBuilder(coin, claimer), claimer);
    expect(amount).toBe(expected);
    expect((await keeperZec()) - before).toBe(expected);
    expect(db.getClaimProgress(epoch, coin.mint, "trading")?.status).toBe("confirmed");
  });

  slow("claimCoinFees sends nothing when nothing has accrued, and a second epoch claims only what accrued since", async () => {
    const { coin, creator } = await launchCoin("20000000");
    const claimer = loadFeeClaimer();
    expect(await claimCoinFees(epochId(), coin, claimer)).toBe(160_000n);
    const idle = epochId();
    expect(await claimCoinFees(idle, coin, claimer)).toBe(0n);
    expect(db.getClaimProgress(idle, coin.mint, "trading")).toBeNull(); // no transaction was sent

    const { txBase64, quote } = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "10000000", slippageBps: 100 });
    expect(quote.feeZec).toBe("100000"); // the quote reports the whole 1% fee on a curve buy
    await send(txBase64, creator);
    expect(await claimCoinFees(epochId(), coin, claimer)).toBe(80_000n); // 1% of 10,000,000 = 100,000; 80% of it
  });

  slow("fees below the minimum claim size are left in the pool, and are claimed together once they add up", async () => {
    const { coin, creator } = await launchCoin("500000"); // 1% of 500,000 = 5,000; partner 80% = 4,000, under the 10,000 minimum
    const claimer = loadFeeClaimer();
    expect(await accrued(coin.poolId!)).toBe(4_000n);
    const early = epochId();
    expect(await claimCoinFees(early, coin, claimer)).toBe(0n);
    expect(db.getClaimProgress(early, coin.mint, "trading")).toBeNull(); // no transaction, no owner approval for dust
    const { txBase64 } = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "1000000", slippageBps: 100 });
    await send(txBase64, creator); // another 8,000 for the partner: 12,000 in all
    expect(await claimCoinFees(epochId(), coin, claimer)).toBe(12_000n);
  });

  slow("reconcileMigration leaves a coin whose curve is not full alone", async () => {
    const { coin } = await launchCoin("20000000");
    expect(await readCurveStage(coin.poolId!)).toBe("open");
    expect(await reconcileMigration(coin, loadFeeClaimer().publicKey)).toEqual(coin);
  });

  test("a launch confirmation for a signature that never landed is refused", async () => {
    const creator = Keypair.generate();
    // funded: the engine simulates a launch before answering (contract v2.9.1) and refuses a wallet with no SOL
    await getConnection().confirmTransaction(await getConnection().requestAirdrop(creator.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const { mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Ghost", symbol: "GHOST", description: "", imageUrl: "" });
    await expect(confirmLaunch(bs58.encode(new Uint8Array(64).fill(3)), mint)).rejects.toMatchObject({ code: "tx_not_found" });
    expect(db.getCoin(mint)?.status).toBe("pending");
    expect(new PublicKey(mint).toBase58()).toBe(mint);
  }, 40_000); // confirmLaunch waits up to 20 s for a signature that never lands

  test("the launched mint is Token-2022 with no mint authority, and the launch transaction fits well inside 1,232 bytes", async () => {
    const creator = Keypair.generate();
    await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
    const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Size", symbol: "SIZE", description: "", imageUrl: "", initialBuyZats: "20000000" });
    expect(Buffer.from(txBase64, "base64").length).toBeLessThanOrEqual(1232);
    await confirmLaunch(await send(txBase64, creator), mint);
    const info = await getMint(getConnection(), new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID); // throws if it is not owned by Token-2022
    expect(info.mintAuthority).toBeNull();
    expect(info.decimals).toBe(config.solana.dbc.baseDecimals);
  });

  slow("a sell accrues the fee in ZEC too, and the partner base-token fee stays zero", async () => {
    const { coin, creator } = await launchCoin("20000000");
    const before = await accrued(coin.poolId!);
    const ata = getAssociatedTokenAddressSync(new PublicKey(coin.mint), creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const held = (await getAccount(getConnection(), ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const { txBase64 } = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "sell", amount: (held / 2n).toString(), slippageBps: 500 });
    await send(txBase64, creator);
    expect(await accrued(coin.poolId!)).toBeGreaterThan(before);
    const metrics = await getDbcClient().state.getPoolFeeMetrics(coin.poolId!);
    expect(metrics.current.partnerBaseFee.isZero()).toBe(true);
  });

  test("a claim measured at 'finalized' (what devnet and mainnet use) lands and reads the same amount", async () => {
    const { coin } = await launchCoin("20000000");
    const claimer = loadFeeClaimer();
    const epoch = epochId();
    const expected = await accrued(coin.poolId!);
    await runClaim(epoch, coin.mint, "trading", tradingFeeBuilder(coin, claimer), claimer);
    const row = db.getClaimProgress(epoch, coin.mint, "trading")!;
    expect(await waitForSignature(row.sig, 90_000, "finalized")).toEqual({ err: null });
    expect(await getTokenBalanceDelta(row.sig, keeperAta(), 5, "finalized")).toBe(expected);
  }, 120_000);

  slow("the surplus claim names the KEEPER's ZEC account as the receiver (the SDK builder would name the fee claimer's own)", async () => {
    const { coin } = await launchCoin("20000000");
    const claimer = loadFeeClaimer();
    const { claimIxs } = await surplusBuilder(coin, claimer)();
    const { receivers, unknown } = decodeClaimReceivers(resolveInstructions(claimIxs));
    expect(unknown).toEqual([]);
    expect(receivers).toEqual([{ instruction: "dbc partner_withdraw_surplus", tokenAccount: keeperAta().toBase58() }]);
  });

  test("a full curve: the keeper migrates it once, the curve fee and then the DAMM v2 position fee are claimed into the keeper account", async () => {
    const { coin, creator } = await launchCoin("20000000");
    await fundTestWallet(creator.publicKey, 1, loadKeeperKeypair());
    await fundTestWallet(creator.publicKey, 1, loadKeeperKeypair()); // 10 ZEC in all: the curve takes 6.67
    const pool = new PublicKey(coin.poolId!);
    for (let i = 0; i < 6 && (await readCurveStage(coin.poolId!)) === "open"; i++) {
      const tx = await getDbcClient().pool.swap2({ owner: creator.publicKey, pool, swapMode: SwapMode.PartialFill, amountIn: new BN(400_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null });
      await sendAndConfirmTransaction(getConnection(), tx, [creator], { commitment: "confirmed" });
    }
    expect(await readCurveStage(coin.poolId!)).toBe("complete");
    const claimer = loadFeeClaimer();
    const curveFee = await accrued(coin.poolId!);

    const migrated = await reconcileMigration(coin, claimer.publicKey);
    expect(migrated.dammPool).toBeTruthy();
    expect(migrated.positionNft).toBeTruthy();
    expect(await readCurveStage(coin.poolId!)).toBe("migrated");
    expect(await reconcileMigration(migrated, claimer.publicKey)).toEqual(migrated); // a second call changes nothing and sends nothing

    const epoch = epochId();
    expect(await claimCoinFees(epoch, migrated, claimer)).toBe(curveFee); // the surplus is under one raw unit, so there is nothing to claim for it
    expect(db.getClaimProgress(epoch, coin.mint, "surplus")).toBeNull();
    expect(await claimCoinFees(epochId(), migrated, claimer)).toBe(0n); // nothing accrued since

    const { txBase64, quote } = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "50000000", slippageBps: 100 });
    expect(quote.feeZec).toBe("500000"); // the quote reports the WHOLE 1% pool fee (80% of it is the holders'), not just their part
    await send(txBase64, creator); // trades on the DAMM v2 pool now

    // The graduated coin's pool vaults hold most of the supply and are never paid: both pool authorities own token accounts here,
    // so this exclusion is exercised, not vacuous (the Raydium-era "pool vault exclusion" tests this replaces).
    const everyAccount = await getAllTokenAccountsForMint(new PublicKey(coin.mint));
    const poolOwners = [deriveDbcPoolAuthority().toBase58(), deriveDammV2PoolAuthority().toBase58()];
    expect(everyAccount.some((a) => poolOwners.includes(a.owner) && a.balance > 0n)).toBe(true);
    // The second migration position (the pool creator's) holds none of the LP: the config gives the creator 0%.
    const creatorPositions = await getCpAmm().getUserPositionByPool(new PublicKey(migrated.dammPool!), creator.publicKey);
    for (const p of creatorPositions) expect(p.positionState.unlockedLiquidity.add(p.positionState.vestedLiquidity).add(p.positionState.permanentLockedLiquidity).isZero()).toBe(true);
    const holders = await snapshotHolders({ mint: new PublicKey(coin.mint), excludeOwners: getExcludedOwners(loadKeeperKeypair().publicKey, [claimer.publicKey]), minBalance: 1n });
    expect(holders.map((h) => h.wallet)).toEqual([creator.publicKey.toBase58()]);
    const position = await claimCoinFees(epochId(), migrated, claimer);
    expect(position).toBeGreaterThanOrEqual(399_998n); // 80% of the 1% pool fee on 50,000,000, minus DAMM's rounding
    expect(position).toBeLessThanOrEqual(400_000n);
  }, 180_000);
});
