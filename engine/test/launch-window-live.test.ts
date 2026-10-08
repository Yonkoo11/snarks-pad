// The launch window against the real DBC program: the local validator runs the MAINNET DBC binary (CONFIG-REVIEW section 2) with the real ZEC mint. Real configs
// made from the reviewed spec, real launches through the API, real buys, real counters read off the pool; nothing mocked. Skipped when no validator is up.
//
//  - the launcher's own first buy, inside the launch transaction, pays the tier fee, never the 99%;
//  - a buy inside the window pays the step of the second its block landed in, and `feeBps` on the quote is that step's fee (each read between two reads of the
//    chain's clock must be one of the steps those two reads span); `feeNowBps` on the coin is worked out from the row and the server's clock read one second
//    back (v2.8.1), so it may also be the step of the second before, never a later one;
//  - launch stores the config's fee schedule on the coin's row and confirm the pool's activation point; a row without them gets them from its first chain read;
//  - after the window every buy pays the tier fee to the unit, and the coin and the quote say so;
//  - a launch with a Creator wallet hands the pool to it in the same transaction: the receiver claims, the launcher cannot, and nothing is lost.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ActivationType, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { createDbcConfig, ensureDbcConfig, recordKeeperIdentity } from "../src/dbc/setup";
import { splitSwapFee } from "../src/dbc/tiers";
import { REVIEWED_TIERS } from "../src/dbc/reviewed";
import { scheduleOfState, scheduleToJson } from "../src/dbc/window";
import { waitForWindowToClose } from "../src/dbc/windowWait";
import { fundTestWallet } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection, getDbcClient } from "../src/solana";
import { buildBlindBuy } from "../scripts/lib/blind-buy";
import { cosignedLaunch } from "./helpers/launch-cosign";
import { validatorUp } from "./helpers/validator-up";

const live = await validatorUp();
const QUOTE = config.solana.dbc.quoteMint;
const B = "http://pad.test/api";
const IP = { ip: "192.0.2.88" };
const CLIFF = 990_000_000n;
const TIER_FOR_BLIND = 100;
const made: { configIds: string[]; mints: string[] } = { configIds: [], mints: [] };

afterAll(() => {
  const d = db.getDb();
  for (const id of made.configIds) d.query("DELETE FROM dbc_configs WHERE configId = $id").run({ $id: id });
  for (const m of made.mints) d.query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await handleRequest(new Request(`${B}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), IP);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function send(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

/** A launch: the creator signs, the engine co-signs (contract v2.9.1), then it is sent and confirmed. */
async function sendLaunch(txBase64: string, mint: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = await cosignedLaunch(txBase64, mint, signer, IP);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

interface Counters { partner: bigint; creator: bigint; protocol: bigint }
async function counters(poolId: string): Promise<Counters> {
  const s = (await getDbcClient().state.getPool(poolId))!.poolState;
  return { partner: BigInt(s.partnerQuoteFee.toString()), creator: BigInt(s.creatorQuoteFee.toString()), protocol: BigInt(s.protocolQuoteFee.toString()) };
}
const sum = (c: Counters): bigint => c.partner + c.creator + c.protocol;
const minus = (a: Counters, b: Counters): Counters => ({ partner: a.partner - b.partner, creator: a.creator - b.creator, protocol: a.protocol - b.protocol });

/** The chain's clock, as the program's Clock sysvar will read it for a transaction landing now. */
const chainNow = async (): Promise<number> => Number((await getCurrentPoint(getConnection(), ActivationType.Timestamp)).toString());
const blockTimeOf = async (sig: string): Promise<number> => (await getConnection().getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.blockTime!;
const zecOf = async (owner: PublicKey): Promise<bigint> => {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(QUOTE, owner, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};

/** By hand: cliff - period x reduction, 1 s periods, 5 of them, for a tier whose fee after the window is `tierBps`. */
function numeratorAtSecond(tierBps: number, second: number): bigint {
  const reduction = (CLIFF - BigInt(tierBps) * 100_000n) / 5n;
  return CLIFF - BigInt(Math.min(Math.max(second, 0), 5)) * reduction;
}
const ceilFee = (amount: bigint, numerator: bigint): bigint => (amount * numerator + 999_999_999n) / 1_000_000_000n;
const bpsOf = (numerator: bigint): number => Number(numerator / 100_000n);

async function launchViaApi(tier: number, creator: Keypair, symbol: string, firstBuy: string, creatorWallet?: string): Promise<{ mint: string; poolId: string; activation: number }> {
  const made1 = await api("POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: `Win ${symbol}`, symbol, description: "", imageUrl: "", initialBuyZec: firstBuy, feeTier: tier, ...(creatorWallet ? { creatorWallet } : {}) });
  expect(made1.status).toBe(200);
  const mint = made1.body.mint as string;
  const sig = await sendLaunch(made1.body.tx as string, mint, creator);
  const confirmed = await api("POST", "/coins/confirm", { sig, mint });
  expect(confirmed.status).toBe(200);
  made.mints.push(mint);
  const poolId = confirmed.body.poolId as string;
  const activation = Number((await getDbcClient().state.getPool(poolId))!.poolState.activationPoint.toString());
  return { mint, poolId, activation };
}

interface BlindBuy {
  second: number; // seconds after the pool's activation, by the clock of the block the buy landed in
  numerator: bigint; // the fee numerator the window gives that second
  fee: bigint; // what the pool took for it, read off its counters
  failed: boolean; // the buy reached the chain before the pool existed
}

/**
 * One launch (the launcher's first buy inside it) with a stranger's buy signed beforehand from addresses alone and sent straight behind the launch, without waiting for it to
 * confirm: the only way to land in the launch's own second. The fee is what the pool's counters grew by, less the launcher's first buy.
 */
async function launchWithBlindBuy(configId: string, creator: Keypair, buyer: Keypair, symbol: string, firstBuy: bigint, amount: bigint): Promise<BlindBuy> {
  const made1 = await api("POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: `Win ${symbol}`, symbol, description: "", imageUrl: "", initialBuyZec: firstBuy.toString(), feeTier: TIER_FOR_BLIND });
  expect(made1.status).toBe(200);
  const mint = made1.body.mint as string;
  const buyTx = await buildBlindBuy(buyer, new PublicKey(mint), new PublicKey(configId), amount);
  const launchTx = await cosignedLaunch(made1.body.tx as string, mint, creator, IP);
  const conn = getConnection();
  const launchSig = await conn.sendRawTransaction(launchTx.serialize(), { skipPreflight: true });
  const buySig = await conn.sendRawTransaction(buyTx.serialize(), { skipPreflight: true });
  const [, bought] = await Promise.all([conn.confirmTransaction(launchSig, "confirmed"), conn.confirmTransaction(buySig, "confirmed")]);
  const confirmed = await api("POST", "/coins/confirm", { sig: launchSig, mint });
  expect(confirmed.status).toBe(200);
  made.mints.push(mint);
  const poolId = confirmed.body.poolId as string;
  const activation = Number((await getDbcClient().state.getPool(poolId))!.poolState.activationPoint.toString());
  if (bought.value.err) return { second: -1, numerator: 0n, fee: 0n, failed: true };
  const second = (await blockTimeOf(buySig)) - activation;
  const firstFee = ceilFee(firstBuy, 10_000_000n); // the launcher's own buy pays the tier fee (tested above)
  return { second, numerator: numeratorAtSecond(TIER_FOR_BLIND, second), fee: sum(await counters(poolId)) - firstFee, failed: false };
}

describe.if(live)("the launch window on the real DBC program (local validator, mainnet binary)", () => {
  const keeper = loadKeeperKeypair();
  const claimer = recordKeeperIdentity();
  const TIER_100 = 100;
  const TIER_200 = 200;

  test("the configs the tests launch on are made from the reviewed spec and pass the full-field check", async () => {
    const one = await ensureDbcConfig();
    expect(one.feeBps).toBe(TIER_100);
    const two = await createDbcConfig(claimer, TIER_200);
    made.configIds.push(two.configId);
    expect(two.feeBps).toBe(TIER_200);
    const state = (await getDbcClient().state.getPoolConfig(new PublicKey(two.configId)))!;
    expect([state.poolFees.baseFee.cliffFeeNumerator.toString(), state.poolFees.baseFee.firstFactor, state.poolFees.baseFee.secondFactor.toString(), state.poolFees.baseFee.thirdFactor.toString(), Number(state.enableFirstSwapWithMinFee)]).toEqual([
      "990000000", 5, "1", "194000000", 1,
    ]);
  }, 120_000);

  test("1% tier: the launcher's first buy pays 1%; a buy inside the window pays its second's step; after the window every buy pays 1% to the unit", async () => {
    const creator = Keypair.generate();
    const buyer = Keypair.generate();
    await fundTestWallet(creator.publicKey, 2, keeper);
    await fundTestWallet(buyer.publicKey, 2, keeper);
    const FIRST = 100_000_000n;
    const { mint, poolId, activation } = await launchViaApi(TIER_100, creator, "WIN1", FIRST.toString());

    // 1. the launcher's own first buy, in the launch transaction: the tier's fee (1,000,000 on 100,000,000), not the 99% a stranger would pay
    const afterFirst = await counters(poolId);
    const first = splitSwapFee(FIRST, 10_000_000n, 0);
    expect(sum(afterFirst)).toBe(1_000_000n);
    expect(afterFirst).toEqual({ partner: first.partner, creator: first.creator, protocol: first.meteora });

    // 2. what the pad says, read between two reads of the chain's clock. v2.8.1: the coin page reads no chain for it; the row holds the config's schedule (stored
    // at launch) and the pool's activation point (stored at confirm), and the server's clock is read one second back
    const config100 = (await getDbcClient().state.getPoolConfig((await getDbcClient().state.getPool(poolId))!.poolState.config))!;
    expect([db.getCoin(mint)!.feeSchedule, db.getCoin(mint)!.activationPoint]).toEqual([scheduleToJson(scheduleOfState(config100)), String(activation)]);
    const t0 = await chainNow();
    const coin = await api("GET", `/coins/${mint}`);
    const t1 = await chainNow();
    expect(coin.status).toBe(200);
    expect(coin.body.launchWindow).toEqual({
      cliffBps: 9900, endBps: 100, periods: 5, periodSeconds: 1, startsAt: new Date(activation * 1000).toISOString(), endsAt: new Date((activation + 5) * 1000).toISOString(),
    });
    const steps = new Set<number>();
    const lefts = new Set<number>();
    for (let t = t0 - 1; t <= t1; t++) {
      steps.add(bpsOf(numeratorAtSecond(TIER_100, t - activation)));
      lefts.add(Math.max(0, activation + 5 - t));
    }
    expect([...steps]).toContain(coin.body.feeNowBps as number); // exactly the fee of a second the read could have fallen in
    expect([...lefts]).toContain(coin.body.windowSecondsLeft as number); // and the seconds left of that same second
    expect(coin.body.windowSecondsLeft).toBeGreaterThan(0); // the machine landed a second transaction well inside the 5 seconds; a stall past them fails here, loudly

    // 3. a quote inside the window: its fee is a step, and its numbers agree with each other
    const q = await api("GET", `/coins/${mint}/quote?side=buy&amount=100000000&slippageBps=100`);
    expect(q.status).toBe(200);
    const quotedNumerator = BigInt(q.body.feeBps as number) * 100_000n;
    expect(q.body.feeZec).toBe(ceilFee(100_000_000n, quotedNumerator).toString());
    expect(q.body.windowSecondsLeft).toBeGreaterThanOrEqual(0);

    // 4. a buy inside the window: trade-tx is not refused, the fee charged is the step of the second the block landed in
    const before = await counters(poolId);
    const AMOUNT = 100_000_000n;
    const built = await api("POST", `/coins/${mint}/trade-tx`, { wallet: buyer.publicKey.toBase58(), side: "buy", amount: AMOUNT.toString(), slippageBps: 5000 });
    expect(built.status).toBe(200);
    const landed = await send(built.body.tx as string, buyer);
    const second = (await blockTimeOf(landed)) - activation;
    expect(second).toBeLessThan(5); // still inside the window
    const numerator = numeratorAtSecond(TIER_100, second);
    const charged = minus(await counters(poolId), before);
    const model = splitSwapFee(AMOUNT, numerator, 0);
    expect(charged).toEqual({ partner: model.partner, creator: model.creator, protocol: model.meteora });
    expect(sum(charged)).toBe(ceilFee(AMOUNT, numerator));
    expect(sum(charged)).toBeGreaterThan(1_000_000n); // more than the tier fee: the window really charged
    expect(BigInt(built.body.quote.feeZec)).toBeGreaterThanOrEqual(sum(charged)); // quoted a second or more earlier: never less than what landed later

    // 5. after the window: the coin says so, and a buy pays exactly 1%
    await waitForWindowToClose(poolId);
    const closed = await api("GET", `/coins/${mint}`);
    expect([closed.body.feeNowBps, closed.body.windowSecondsLeft]).toEqual([100, 0]);
    // a coin from before v2.8.1 (no facts on its row) gets them from its first chain read after, and the coin page says the same as before
    const facts = [db.getCoin(mint)!.feeSchedule, db.getCoin(mint)!.activationPoint];
    db.getDb().query("UPDATE coins SET feeSchedule = NULL, activationPoint = NULL WHERE mint = $m").run({ $m: mint });
    await Bun.sleep(3_100); // past the 3 s cache of the coin view, so the next request reads the pool again
    const reread = await api("GET", `/coins/${mint}`);
    expect([reread.status, reread.body.launchWindow, reread.body.feeNowBps]).toEqual([200, closed.body.launchWindow, null]); // the chain's window; the row had no facts yet
    expect([db.getCoin(mint)!.feeSchedule, db.getCoin(mint)!.activationPoint]).toEqual(facts);
    expect((await api("GET", `/coins/${mint}`)).body.feeNowBps).toBe(100);
    const closedQuote = await api("GET", `/coins/${mint}/quote?side=buy&amount=100000000&slippageBps=100`);
    expect([closedQuote.body.feeBps, closedQuote.body.windowSecondsLeft, closedQuote.body.feeZec]).toEqual([100, 0, "1000000"]);
    const before2 = await counters(poolId);
    const buy2 = await api("POST", `/coins/${mint}/trade-tx`, { wallet: buyer.publicKey.toBase58(), side: "buy", amount: "123456789", slippageBps: 100 });
    await send(buy2.body.tx as string, buyer);
    const flat = splitSwapFee(123_456_789n, 10_000_000n, 0);
    expect(minus(await counters(poolId), before2)).toEqual({ partner: flat.partner, creator: flat.creator, protocol: flat.meteora });
    expect(buy2.body.quote.feeZec).toBe(flat.fee.toString());
  }, 180_000);

  test("a buy sent right behind the launch pays the step of the second it lands in; in the launch's own second that is the 99% cliff", async () => {
    const { configId } = await ensureDbcConfig();
    const creator = Keypair.generate();
    const buyer = Keypair.generate();
    await fundTestWallet(creator.publicKey, 3, keeper);
    await fundTestWallet(buyer.publicKey, 3, keeper);
    const AMOUNT = 10_000_000n; // 0.1 ZEC: the fee at every step is a whole number of zats
    const tries: BlindBuy[] = [];
    for (let n = 1; n <= 10 && !tries.some((t) => t.second === 0); n++) tries.push(await launchWithBlindBuy(configId, creator, buyer, `BLN${n}`, 100_000_000n, AMOUNT));
    const landed = tries.filter((t) => !t.failed);
    for (const t of landed) expect(t.fee).toBe(ceilFee(AMOUNT, t.numerator)); // whichever second it fell in, the step's fee to the zat
    const cliff = landed.find((t) => t.second === 0);
    expect(cliff, `no buy landed in the launch's own second in ${tries.length} tries (seconds: ${tries.map((t) => (t.failed ? "failed" : t.second)).join(", ")})`).toBeDefined();
    expect([cliff!.numerator, cliff!.fee]).toEqual([CLIFF, 9_900_000n]); // 99% of 10,000,000
  }, 240_000);

  test("2% tier with a Creator wallet: the pool is handed over in the launch transaction; the receiver claims, the launcher cannot", async () => {
    const launcher = Keypair.generate();
    const receiver = Keypair.generate(); // never signs the launch and holds nothing when it lands
    const buyer = Keypair.generate();
    await fundTestWallet(launcher.publicKey, 2, keeper);
    await fundTestWallet(buyer.publicKey, 2, keeper);
    expect(await getConnection().getBalance(receiver.publicKey)).toBe(0);
    const { mint, poolId } = await launchViaApi(TIER_200, launcher, "WIN2", "100000000", receiver.publicKey.toBase58());

    // the chain, the row, the view and the creator-fees route all agree on who the creator is now
    expect((await getDbcClient().state.getPool(poolId))!.poolState.creator.toBase58()).toBe(receiver.publicKey.toBase58());
    expect(db.getCoin(mint)!.creatorWallet).toBe(receiver.publicKey.toBase58());
    const view = await api("GET", `/coins/${mint}`);
    expect([view.body.creator, view.body.creatorWallet]).toEqual([launcher.publicKey.toBase58(), receiver.publicKey.toBase58()]);
    expect((await api("GET", `/coins/${mint}/creator-fees`)).body.creator).toBe(receiver.publicKey.toBase58());

    // a buy after the window accrues the creator's share (2% tier: half of what is left after Meteora's 20%)
    await waitForWindowToClose(poolId);
    const spec = REVIEWED_TIERS[TIER_200]!;
    const before = await counters(poolId);
    const buy = await api("POST", `/coins/${mint}/trade-tx`, { wallet: buyer.publicKey.toBase58(), side: "buy", amount: "250000000", slippageBps: 100 });
    await send(buy.body.tx as string, buyer);
    const model = splitSwapFee(250_000_000n, 20_000_000n, spec.creatorFeePercentage);
    expect(minus(await counters(poolId), before)).toEqual({ partner: model.partner, creator: model.creator, protocol: model.meteora });

    // the launcher, who paid and signed, can claim nothing: the chain says it is not the creator, and so does the API
    const refused = await api("POST", `/coins/${mint}/creator-claim-tx`, { wallet: launcher.publicKey.toBase58() });
    expect([refused.status, refused.body.error]).toEqual([403, "not_creator"]);

    // the receiver claims with its own signature (it needs a little SOL for the ZEC account); what it receives is exactly what was waiting
    await fundTestWallet(receiver.publicKey, 0.5, keeper);
    const owed = BigInt((await api("GET", `/coins/${mint}/creator-fees`)).body.curveZats);
    expect(owed).toBeGreaterThan(0n);
    const zecBefore = await zecOf(receiver.publicKey);
    const claim = await api("POST", `/coins/${mint}/creator-claim-tx`, { wallet: receiver.publicKey.toBase58(), kind: "curve" });
    expect(claim.status).toBe(200);
    await send(claim.body.tx as string, receiver);
    expect((await zecOf(receiver.publicKey)) - zecBefore).toBe(owed);
    expect((await counters(poolId)).creator).toBe(0n);
  }, 240_000);

  test("a Creator wallet that is the launcher's own address hands nothing over: the launcher stays the pool's creator", async () => {
    const launcher = Keypair.generate();
    await fundTestWallet(launcher.publicKey, 2, keeper);
    const { mint, poolId } = await launchViaApi(TIER_200, launcher, "WIN3", "50000000", launcher.publicKey.toBase58());
    expect((await getDbcClient().state.getPool(poolId))!.poolState.creator.toBase58()).toBe(launcher.publicKey.toBase58());
    expect(db.getCoin(mint)!.creatorWallet ?? null).toBeNull();
    expect((await api("GET", `/coins/${mint}`)).body.creatorWallet).toBe(launcher.publicKey.toBase58());
  }, 120_000);
});
