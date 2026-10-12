// The creator-fee tiers against the real DBC program: the local validator runs the MAINNET DBC binary (byte-identical, CONFIG-REVIEW
// section 2) with the real ZEC mint. Real configs, real launches, real trades, real claims; nothing mocked.
//
//  - every tier's config passes the full-field check for ITS tier and fails it for every other tier;
//  - what the program accrues for Meteora, the creator and the pad on real buys and sells equals src/dbc/tiers.ts to the zat
//    (that is the check that creator_trading_fee_percentage > 0 behaves as the source says: research Unverified item 1);
//  - the creator claims their share with their own signature; nobody else can, through our API or straight at the program;
//  - the pad's claim for a tier coin is exactly the partner part, and the 12.5/87.5 policy is applied to that.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SwapMode, U64_MAX, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { config } from "../src/config";
import { getConnection, getCpAmm, getDbcClient } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { createDbcConfig, recordKeeperIdentity } from "../src/dbc/setup";
import { requireDbcConfig, tierOfRow, verifyConfigState, TierNotAvailableError, ConfigRefusedError } from "../src/dbc/config";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { buildTradeTx } from "../src/dbc/trade";
import { claimCoinFees, loadFeeClaimer } from "../src/dbc/claim";
import { CreatorClaimError, buildCreatorClaimTx, readCreatorFees } from "../src/dbc/creatorClaim";
import { readCurveStage, reconcileMigration } from "../src/dbc/migrate";
import { REVIEWED_TIERS, TIER_MENU_BPS } from "../src/dbc/reviewed";
import { feeNumeratorOf, splitSwapFee } from "../src/dbc/tiers";
import { splitClaim } from "../src/epoch/split";
import * as db from "../src/db";
import { validatorUp } from "./helpers/validator-up";
import { waitForCoinWindow } from "../src/dbc/windowWait";

const live = await validatorUp();
const QUOTE = config.solana.dbc.quoteMint;
const TIERS = TIER_MENU_BPS.filter((b) => b !== 100);
// Graduation needs the tier's DAMM v2 config on the validator: scripts/local-up.ts clones all four from mainnet at start.
const dammConfigOnChain = new Map<number, boolean>();
if (live) for (const tier of TIERS) dammConfigOnChain.set(tier, !!(await getConnection().getAccountInfo(new PublicKey(REVIEWED_TIERS[tier]!.dammMigrationConfig))));
const made: { configIds: string[]; mints: string[] } = { configIds: [], mints: [] };

afterAll(() => {
  // The shared test database must not keep tier rows or coins: other suites read "the newest config" and list coins.
  const d = db.getDb();
  for (const id of made.configIds) d.query("DELETE FROM dbc_configs WHERE configId = $id").run({ $id: id });
  for (const m of made.mints) d.query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
});

async function send(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

const zecOf = async (owner: PublicKey): Promise<bigint> => {
  const ata = getAssociatedTokenAddressSync(QUOTE, owner, false, TOKEN_PROGRAM_ID);
  try {
    return (await getAccount(getConnection(), ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};

interface Fees {
  partner: bigint;
  creator: bigint;
  protocol: bigint;
}
async function poolFees(poolId: string): Promise<Fees> {
  const s = (await getDbcClient().state.getPool(poolId))!.poolState;
  return { partner: BigInt(s.partnerQuoteFee.toString()), creator: BigInt(s.creatorQuoteFee.toString()), protocol: BigInt(s.protocolQuoteFee.toString()) };
}
const delta = (a: Fees, b: Fees): Fees => ({ partner: b.partner - a.partner, creator: b.creator - a.creator, protocol: b.protocol - a.protocol });

describe.if(live)("fee tiers on the real DBC program (local validator, mainnet binary)", () => {
  const keeper = loadKeeperKeypair();
  const claimer = recordKeeperIdentity();
  const configs = new Map<number, db.DbcConfigRow>();

  test("each tier's config is created from the reviewed spec and passes the full-field check; none passes for any other tier", async () => {
    for (const tier of TIERS) {
      const row = await createDbcConfig(claimer, tier);
      made.configIds.push(row.configId);
      configs.set(tier, row);
      expect(row.feeBps).toBe(tier);
      expect(tierOfRow(row)).toBe(tier);
      expect(row.dammConfig).toBe(REVIEWED_TIERS[tier]!.dammMigrationConfig);
    }
    for (const [tier, row] of configs) {
      const state = (await getDbcClient().state.getPoolConfig(new PublicKey(row.configId)))!;
      for (const other of TIER_MENU_BPS) {
        const problems = verifyConfigState(state, claimer, other);
        if (other === tier) expect(problems).toEqual([]);
        else expect(problems.length).toBeGreaterThan(0);
      }
      // the five fields that differ, read off the chain
      const t = REVIEWED_TIERS[tier]!;
      expect([state.creatorTradingFeePercentage, state.migrationFeeOption, state.partnerPermanentLockedLiquidityPercentage, state.creatorPermanentLockedLiquidityPercentage]).toEqual([
        t.creatorFeePercentage, t.migrationFeeOption, t.partnerLockedLpPercentage, t.creatorLockedLpPercentage,
      ]);
    }
  }, 120_000);

  test.each(TIERS.map((t) => [t]))("tier %d bps: real buys and a sell accrue exactly what src/dbc/tiers.ts says; the creator claims it alone", async (tier) => {
    const row = configs.get(tier)!;
    const spec = REVIEWED_TIERS[tier]!;
    const creator = Keypair.generate();
    await fundTestWallet(creator.publicKey, 2, keeper);
    const launch = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: `Tier${tier}`, symbol: `T${tier}`, description: "", imageUrl: "", initialBuyZats: "250000000", feeTier: tier });
    await confirmLaunch(await send(launch.txBase64, creator), launch.mint);
    await waitForCoinWindow(launch.mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
    made.mints.push(launch.mint);
    const coin = db.getCoin(launch.mint)!;
    expect([coin.configId, coin.feeBps]).toEqual([row.configId, tier]);

    const num = feeNumeratorOf(tier);
    // 1) the first buy (2.5 ZEC)
    let seen = await poolFees(coin.poolId!);
    const first = splitSwapFee(250_000_000n, num, spec.creatorFeePercentage);
    expect(seen).toEqual({ partner: first.partner, creator: first.creator, protocol: first.meteora });

    // 2) a second, odd-sized buy: rounding on the chain equals rounding in the model
    const before = seen;
    const buy = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "123456789", slippageBps: 100 });
    await send(buy.txBase64, creator);
    seen = await poolFees(coin.poolId!);
    const second = splitSwapFee(123_456_789n, num, spec.creatorFeePercentage);
    expect(delta(before, seen)).toEqual({ partner: second.partner, creator: second.creator, protocol: second.meteora });
    expect(buy.quote.feeZec).toBe(second.fee.toString());

    // 3) a sell: the fee is on the gross output, so gross = what the seller received + the fee
    const tokenAta = getAssociatedTokenAddressSync(new PublicKey(coin.mint), creator.publicKey, false, (await getConnection().getAccountInfo(new PublicKey(coin.mint)))!.owner);
    const held = (await getAccount(getConnection(), tokenAta, "confirmed", (await getConnection().getAccountInfo(new PublicKey(coin.mint)))!.owner)).amount;
    const zecBefore = await zecOf(creator.publicKey);
    const feesBefore = seen;
    const sell = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "sell", amount: (held / 3n).toString(), slippageBps: 500 });
    await send(sell.txBase64, creator);
    const sellDelta = delta(feesBefore, await poolFees(coin.poolId!));
    const received = (await zecOf(creator.publicKey)) - zecBefore;
    const wholeFee = sellDelta.partner + sellDelta.creator + sellDelta.protocol;
    const sold = splitSwapFee(received + wholeFee, num, spec.creatorFeePercentage);
    expect(sold.fee).toBe(wholeFee);
    expect(sellDelta).toEqual({ partner: sold.partner, creator: sold.creator, protocol: sold.meteora });
    expect(sell.quote.feeZec).toBe(sold.fee.toString());

    // 4) the creator's share is readable and claimable by the creator only
    const fees = await readCreatorFees(coin.mint);
    const totals = await poolFees(coin.poolId!);
    expect(fees.creator).toBe(creator.publicKey.toBase58());
    expect(fees.curveZats).toBe(totals.creator);
    expect(totals.creator).toBeGreaterThan(0n);
    const stranger = Keypair.generate();
    await expect(buildCreatorClaimTx(coin.mint, stranger.publicKey.toBase58())).rejects.toMatchObject({ code: "not_creator" });

    const zecBeforeClaim = await zecOf(creator.publicKey);
    const claim = await buildCreatorClaimTx(coin.mint, creator.publicKey.toBase58());
    expect([claim.kind, claim.claimableZats]).toEqual(["curve", totals.creator.toString()]);
    await send(claim.txBase64, creator);
    expect((await zecOf(creator.publicKey)) - zecBeforeClaim).toBe(totals.creator);
    expect((await poolFees(coin.poolId!)).creator).toBe(0n);
    await expect(buildCreatorClaimTx(coin.mint, creator.publicKey.toBase58())).rejects.toMatchObject({ code: "nothing_to_claim" });

    // 5) the pad claims exactly the partner part; holders/team 12.5/87.5 of THAT, whatever the tier
    const epoch = `epoch-tier-${crypto.randomUUID()}`;
    const claimed = await claimCoinFees(epoch, coin, loadFeeClaimer());
    expect(claimed).toBe(totals.partner);
    const { holders, team } = splitClaim(claimed, 2500);
    expect(holders + team).toBe(claimed);
    expect(team).toBe((claimed * 2500n) / 10_000n);
  }, 240_000);

  test("another coin's fees: a creator cannot claim a coin they did not launch, through the API builder or straight at the program", async () => {
    const tier = TIERS[0]!;
    const mine = Keypair.generate();
    const victim = Keypair.generate();
    for (const w of [mine, victim]) await fundTestWallet(w.publicKey, 2, keeper);
    const l1 = await buildLaunchTx({ creator: mine.publicKey.toBase58(), name: "Mine", symbol: "MINE", description: "", imageUrl: "", initialBuyZats: "100000000", feeTier: tier });
    await confirmLaunch(await send(l1.txBase64, mine), l1.mint);
    await waitForCoinWindow(l1.mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
    const l2 = await buildLaunchTx({ creator: victim.publicKey.toBase58(), name: "Vict", symbol: "VICT", description: "", imageUrl: "", initialBuyZats: "100000000", feeTier: tier });
    await confirmLaunch(await send(l2.txBase64, victim), l2.mint);
    await waitForCoinWindow(l2.mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
    made.mints.push(l1.mint, l2.mint);

    // our builder refuses before building anything
    await expect(buildCreatorClaimTx(l2.mint, mine.publicKey.toBase58())).rejects.toBeInstanceOf(CreatorClaimError);
    await expect(buildCreatorClaimTx(l2.mint, mine.publicKey.toBase58())).rejects.toMatchObject({ code: "not_creator" });
    await expect(buildCreatorClaimTx(Keypair.generate().publicKey.toBase58(), mine.publicKey.toBase58())).rejects.toMatchObject({ code: "unknown_mint" });

    // the program refuses it too: build the claim by hand with the SDK, naming the victim's pool, signed by the wrong wallet
    const victimPool = db.getCoin(l2.mint)!.poolId!;
    const before = await poolFees(victimPool);
    const hostile = await getDbcClient().creator.claimCreatorTradingFee({
      creator: mine.publicKey, payer: mine.publicKey, pool: new PublicKey(victimPool), maxBaseAmount: new BN(U64_MAX.toString()), maxQuoteAmount: new BN(U64_MAX.toString()),
    });
    hostile.feePayer = mine.publicKey;
    hostile.recentBlockhash = (await getConnection().getLatestBlockhash("confirmed")).blockhash;
    hostile.sign(mine);
    const zecBefore = await zecOf(mine.publicKey);
    await expect(getConnection().sendRawTransaction(hostile.serialize())).rejects.toThrow();
    expect(await poolFees(victimPool)).toEqual(before);
    expect(await zecOf(mine.publicKey)).toBe(zecBefore);

    // and the victim's own claim still works: the failed attempt changed nothing
    const own = await buildCreatorClaimTx(l2.mint, victim.publicKey.toBase58());
    expect(BigInt(own.claimableZats)).toBe(before.creator);
    await send(own.txBase64, victim);
  }, 180_000);

  test("the 1% tier (SNARKS) has no creator share: even its creator gets no_creator_fee, and the pad claims all 80%", async () => {
    const creator = Keypair.generate();
    await fundTestWallet(creator.publicKey, 2, keeper);
    const defaultCfg = await requireDbcConfig().catch(async () => createDbcConfig(claimer, 100).then((r) => (made.configIds.push(r.configId), r)));
    expect(defaultCfg.feeBps).toBe(100);
    const l = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Snk", symbol: "SNK", description: "", imageUrl: "", initialBuyZats: "100000000" });
    await confirmLaunch(await send(l.txBase64, creator), l.mint);
    await waitForCoinWindow(l.mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
    made.mints.push(l.mint);
    const coin = db.getCoin(l.mint)!;
    expect(coin.feeBps).toBe(100);
    await expect(buildCreatorClaimTx(l.mint, creator.publicKey.toBase58())).rejects.toMatchObject({ code: "no_creator_fee" });
    const f = await poolFees(coin.poolId!);
    expect(f.creator).toBe(0n);
    expect(f.partner).toBe(800_000n); // 1% of 1 ZEC = 1,000,000; Meteora 20%
  }, 120_000);

  test("a tier launch is refused for a fee not on the menu, a tier with no config, and a recorded config whose fee claimer is not the pad's", async () => {
    const creator = Keypair.generate().publicKey.toBase58();
    for (const bad of [0, 150, 300, 999, 10_000]) {
      await expect(requireDbcConfig(bad)).rejects.toBeInstanceOf(TierNotAvailableError);
      await expect(buildLaunchTx({ creator, name: "X", symbol: "XX", description: "", imageUrl: "", feeTier: bad })).rejects.toBeInstanceOf(TierNotAvailableError);
    }
    // a tier whose config this pad never created: remove the 4% row for a moment
    const four = configs.get(400)!;
    db.getDb().query("DELETE FROM dbc_configs WHERE configId = $id").run({ $id: four.configId });
    try {
      await expect(requireDbcConfig(400)).rejects.toMatchObject({ reason: "not_created" });
    } finally {
      db.insertDbcConfig(four);
    }
    // a tier config someone else created: the 10% spec exactly, but its fee claimer is a stranger's key (config creation is permissionless)
    const stranger = Keypair.generate().publicKey;
    const foreign = await createDbcConfig(stranger, 1000); // verified against the claimer it was created for, so it records as a row
    made.configIds.push(foreign.configId);
    try {
      expect(foreign.feeClaimer).toBe(stranger.toBase58());
      await expect(requireDbcConfig(1000)).rejects.toBeInstanceOf(ConfigRefusedError); // the newest 10% row names a stranger: refused
      await expect(buildLaunchTx({ creator, name: "X", symbol: "XX", description: "", imageUrl: "", feeTier: 1000 })).rejects.toBeInstanceOf(ConfigRefusedError);
      // a row that CLAIMS our vault for that same config is caught by the chain read-back instead
      db.getDb().query("UPDATE dbc_configs SET feeClaimer = $c WHERE configId = $id").run({ $c: claimer.toBase58(), $id: foreign.configId });
      await expect(requireDbcConfig(1000)).rejects.toThrow(/fee claimer: on chain/);
    } finally {
      db.getDb().query("DELETE FROM dbc_configs WHERE configId = $id").run({ $id: foreign.configId });
    }
    expect((await requireDbcConfig(1000)).configId).toBe(configs.get(1000)!.configId); // the legitimate 10% config is untouched
  }, 60_000);

  test.each(TIERS.map((t) => [t]))("tier %d bps graduates into its own DAMM v2 pool; the LP, and so the pool's fee, is split between the pad and the creator as reviewed", async (tier) => {
    if (!dammConfigOnChain.get(tier)) {
      console.warn(`tier ${tier}: its DAMM v2 config is not on this validator (it was started before the tiers); restart it with bun run local:up to run this check`);
      return;
    }
    const spec = REVIEWED_TIERS[tier]!;
    const creator = Keypair.generate();
    for (let i = 0; i < 3; i++) await fundTestWallet(creator.publicKey, 2, keeper); // 15 ZEC: the curve takes about 7
    const l = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: `Grad${tier}`, symbol: `G${tier}`, description: "", imageUrl: "", initialBuyZats: "200000000", feeTier: tier });
    await confirmLaunch(await send(l.txBase64, creator), l.mint);
    await waitForCoinWindow(l.mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
    made.mints.push(l.mint);
    let coin = db.getCoin(l.mint)!;
    const pool = new PublicKey(coin.poolId!);
    for (let i = 0; i < 12 && (await readCurveStage(coin.poolId!)) === "open"; i++) {
      const tx = await getDbcClient().pool.swap2({ owner: creator.publicKey, pool, swapMode: SwapMode.PartialFill, amountIn: new BN(500_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null });
      await sendAndConfirmTransaction(getConnection(), tx, [creator], { commitment: "confirmed" });
    }
    expect(await readCurveStage(coin.poolId!)).toBe("complete");

    coin = await reconcileMigration(coin, claimer);
    expect(coin.dammPool).toBeTruthy();
    const dammPool = new PublicKey(coin.dammPool!);
    const cp = getCpAmm();
    // the pool address is derived from the tier's DAMM v2 config, and the program checks that config against the one the DBC config names
    expect(deriveDammV2PoolAddress(new PublicKey(spec.dammMigrationConfig), new PublicKey(coin.mint), QUOTE).toBase58()).toBe(dammPool.toBase58());

    // the graduated LP: both positions are permanently locked, split as the tier says
    const lp = async (owner: PublicKey) => (await cp.getUserPositionByPool(dammPool, owner)).reduce((s2, p) => s2 + BigInt(p.positionState.permanentLockedLiquidity.toString()), 0n);
    const [padLp, creatorLp] = [await lp(claimer), await lp(creator.publicKey)];
    expect(padLp + creatorLp).toBeGreaterThan(0n);
    expect(Number((padLp * 10_000n) / (padLp + creatorLp))).toBeGreaterThanOrEqual(spec.partnerLockedLpPercentage * 100 - 1);
    expect(Number((padLp * 10_000n) / (padLp + creatorLp))).toBeLessThanOrEqual(spec.partnerLockedLpPercentage * 100 + 1);

    // a trade on the graduated pool: the pool charges the tier's post-graduation fee, 80% of it to the LPs (Meteora keeps 20%)
    const buy = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "300000000", slippageBps: 100 });
    await send(buy.txBase64, creator);
    const poolFee = (300_000_000n * BigInt(spec.postGraduationFeeBps)) / 10_000n;
    const lpFees = (poolFee * 80n) / 100n;
    const padCurveFee = await poolFees(coin.poolId!); // curve fees accrued before graduation, claimed separately
    expect(padCurveFee.creator).toBeGreaterThan(0n);

    const padPool = await claimCoinFees(`epoch-grad-${crypto.randomUUID()}`, coin, loadFeeClaimer());
    const padPositionOnly = padPool - padCurveFee.partner; // claimCoinFees pays curve + position (+ any surplus)
    const creatorClaim = await buildCreatorClaimTx(coin.mint, creator.publicKey.toBase58(), "pool");
    const before = await zecOf(creator.publicKey);
    await send(creatorClaim.txBase64, creator);
    const creatorPosition = (await zecOf(creator.publicKey)) - before;
    expect(BigInt(creatorClaim.claimableZats)).toBe(creatorPosition);
    // pad + creator = the LPs' fee (DAMM rounds each position down: a few zats), split by the LP percentages
    expect(padPositionOnly + creatorPosition).toBeLessThanOrEqual(lpFees);
    expect(padPositionOnly + creatorPosition).toBeGreaterThanOrEqual(lpFees - 4n);
    const padShare = Number(padPositionOnly) / Number(padPositionOnly + creatorPosition);
    expect(Math.abs(padShare - spec.partnerLockedLpPercentage / 100)).toBeLessThan(0.002);
  }, 900_000);
});
