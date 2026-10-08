// The NEAR 1Click swap leg as a crash-safe state machine, against the real local
// validator (real SPL transfers, real signatures, real confirmations) and a fake
// 1Click server. Every test that reaches the chain ends with the same
// assertion: exactly ONE deposit of exactly the swap amount reached the deposit
// address, and the keeper paid exactly that once (threat model INV-3, hypotheses
// H2 and H9; PORT-ASSUMPTIONS 6c).
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import * as db from "../src/db";
import { progressSwap } from "../src/epoch/engine";
import { fundTestWallet } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import { makeNear1ClickAdapter, type Near1ClickDeps, type Step, type SwapLimits, type TreasuryReceipt } from "../src/swap/near1click";
import { makeSolanaDepositChain, type DepositChain } from "../src/swap/near1click-chain";
import { makeOneClickClient } from "../src/swap/near1click-api";
import { SwapFundsMayHaveMoved, type SwapAdapter } from "../src/swap/types";
import { Fake1Click } from "./helpers/fake-1click";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const MINT = config.solana.dbc.quoteMint;
const AMOUNT = 2_000_000n; // 0.02 ZEC
const TREASURY = JSON.parse(readFileSync(join(config.paths.repoRoot, "probe", "f030", "quote-req.json"), "utf8")).recipient as string;
const randomTxid = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const keeper = () => loadKeeperKeypair();
const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner, true, TOKEN_PROGRAM_ID);

async function balanceOf(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(getConnection(), ataOf(owner), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function fundKeeper(zats: bigint): Promise<void> {
  const k = keeper();
  await mintTo(getConnection(), k, MINT, ataOf(k.publicKey), k, zats);
}

class Crash extends Error {}

/** One test world: a fake 1Click, a controllable clock and treasury wallet, and adapters that share the real chain and the real DB. */
function world(opts: { limits?: Partial<SwapLimits>; chain?: (real: DepositChain) => DepositChain; key?: string } = {}) {
  const fake = new Fake1Click();
  const clock = { t: Date.now() };
  const treasury: { receipt: TreasuryReceipt | null } = { receipt: null };
  const realChain = makeSolanaDepositChain({ keeper: keeper(), mint: MINT, priorityMicroLamports: 0 });
  const key = opts.key ?? `epoch-n1c-${crypto.randomUUID()}`;
  let crashAt: Step | null = null;

  const mk = (over: Partial<Near1ClickDeps> = {}): SwapAdapter =>
    makeNear1ClickAdapter(TREASURY, {
      client: makeOneClickClient({ baseUrl: "http://fake-1click", fetch: fake.fetch }),
      chain: opts.chain ? opts.chain(realChain) : realChain,
      keeperAddress: keeper().publicKey.toBase58(),
      receivedByTreasury: async () => treasury.receipt,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
        await Bun.sleep(ms / 6); // real time for the validator to confirm: 1 s of swap time = ~170 ms
      },
      quoteSigner: fake.signer,
      limits: { pollWindowMs: 0, confirmTimeoutMs: 20_000, ...opts.limits } as SwapLimits,
      checkpoint: (s) => {
        if (s === crashAt) {
          crashAt = null; // the process "dies" once
          throw new Crash(`crash after ${s}`);
        }
      },
      ...over,
    });

  return {
    fake, clock, treasury, key, mk,
    crashAt: (s: Step) => (crashAt = s),
    /** What reached the deposit address of the swap this epoch actually recorded (0 if it recorded none). */
    deposit: () => {
      const row = db.getNear1ClickSwap(key);
      return row ? balanceOf(new PublicKey(row.depositAddress)) : Promise.resolve(0n);
    },
    row: () => db.getNear1ClickSwap(key)!,
  };
}

type World = ReturnType<typeof world>;

/** The invariant of every test: one deposit of exactly `amount` and the keeper paid exactly that. */
async function expectExactlyOneDeposit(w: World, keeperBefore: bigint, amount = AMOUNT): Promise<void> {
  for (let i = 0; i < 40 && (await w.deposit()) < amount; i++) await Bun.sleep(250); // a broadcast may still be confirming
  await Bun.sleep(400); // and a second deposit, if one existed, would be here by now
  expect(await w.deposit()).toBe(amount);
  expect(keeperBefore - (await balanceOf(keeper().publicKey))).toBe(amount);
}

function deliver(w: World, over: Partial<TreasuryReceipt> = {}, txid = randomTxid()): void {
  w.fake.script(w.fake.lastDepositAddress, { status: "SUCCESS", swapDetails: { amountOut: (AMOUNT - 32_000n).toString(), destinationChainTxHashes: [{ hash: txid }] } });
  w.treasury.receipt = { zats: AMOUNT - 25_000n, confirmations: 12, spendableZats: AMOUNT - 25_000n, ...over };
}

async function sendToKeeper(from: Keypair, zats: bigint): Promise<string> {
  const k = keeper();
  const tx = new Transaction().add(createTransferCheckedInstruction(ataOf(from.publicKey), MINT, ataOf(k.publicKey), from.publicKey, zats, 8, [], TOKEN_PROGRAM_ID));
  tx.feePayer = from.publicKey;
  tx.recentBlockhash = (await getConnection().getLatestBlockhash("confirmed")).blockhash;
  tx.sign(from);
  const sig = await getConnection().sendRawTransaction(tx.serialize());
  await getConnection().confirmTransaction(sig, "confirmed");
  return sig;
}

/** A wallet with SOL and 5 test ZEC (the faucet's fill), standing in for 1Click's refund account. */
async function fundedStranger(): Promise<Keypair> {
  const stranger = Keypair.generate();
  await fundTestWallet(stranger.publicKey, 1, keeper());
  return stranger;
}

async function started(w: World): Promise<SwapAdapter> {
  const adapter = w.mk();
  await adapter.submit(AMOUNT, w.key);
  return adapter;
}

describe.if(await validatorUp())("near1click state machine (real chain, fake 1Click)", () => {
  test("happy path: one deposit, the request is the F-030 shape, and the settled amount is what the treasury received, not 1Click's amountOut", async () => {
    await fundKeeper(AMOUNT);
    const before = await balanceOf(keeper().publicKey);
    const w = world();
    const adapter = w.mk();
    expect(await adapter.submit(AMOUNT, w.key)).toEqual({ ref: w.key });

    const sent = w.fake.quotes[0]!.quoteRequest;
    expect(sent).toMatchObject({ dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", recipient: TREASURY, refundTo: keeper().publicKey.toBase58(), amount: AMOUNT.toString(), slippageTolerance: 100, destinationAsset: "nep141:zec.omft.near" });
    expect(sent.originAsset).toBe(`1cs_v1:sol:spl:${MINT.toBase58()}`);
    await expectExactlyOneDeposit(w, before);
    expect(w.row().phase).toBe("deposited");

    w.fake.script(w.fake.lastDepositAddress, { status: "PROCESSING" });
    expect((await adapter.status(w.key)).status).toBe("pending");

    deliver(w); // 1Click says amountOut 1,968,000; the wallet received 1,975,000 (the F-030 shape: 7,000 more)
    expect(await adapter.status(w.key)).toEqual({ status: "settled", amountOutZats: AMOUNT - 25_000n });
    expect(w.row()).toMatchObject({ phase: "settled", amountOutZats: (AMOUNT - 25_000n).toString() });
    const calls = w.fake.statusCalls;
    expect((await adapter.status(w.key)).status).toBe("settled");
    expect(w.fake.statusCalls).toBe(calls); // settled is replayed from the DB, 1Click is not asked again
  });

  describe("a crash after every durable step: the restarted adapter resumes and the deposit is made exactly once", () => {
    const steps: [Step, "plain" | "unresolved", number][] = [
      ["quote_received", "plain", 2], // nothing stored: a new quote is fine, no deposit exists
      ["quote_persisted", "plain", 1], // the stored quote is reused
      ["signed_persisted", "unresolved", 1], // bytes stored, never broadcast: resume broadcasts those bytes
      ["broadcast_sent", "unresolved", 1], // broadcast, not yet confirmed: resume finds it on chain
      ["confirmed", "unresolved", 1], // confirmed: resume does nothing new
    ];
    for (const [step, kind, quotes] of steps) {
      test(`crash after ${step}`, async () => {
        await fundKeeper(AMOUNT);
        const before = await balanceOf(keeper().publicKey);
        const w = world();
        w.crashAt(step);
        const err = await w.mk().submit(AMOUNT, w.key).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        if (kind === "unresolved") expect(err).toBeInstanceOf(SwapFundsMayHaveMoved);
        else expect(err).not.toBeInstanceOf(SwapFundsMayHaveMoved);

        const restarted = w.mk(); // a new process: no memory, same DB and chain
        expect(await restarted.submit(AMOUNT, w.key)).toEqual({ ref: w.key });
        expect(w.fake.quoteRequests).toBe(quotes);
        await expectExactlyOneDeposit(w, before);
        // and a third call changes nothing
        await restarted.submit(AMOUNT, w.key);
        await expectExactlyOneDeposit(w, before);
      });
    }
  });

  test("a confirm timeout is never 'no funds moved': it rejects with SwapFundsMayHaveMoved, and a later status() finds the deposit that did land", async () => {
    await fundKeeper(AMOUNT);
    const before = await balanceOf(keeper().publicKey);
    const w = world({ chain: (real) => ({ ...real, signatureStatus: async () => "absent" as const }), limits: { confirmTimeoutMs: 2_000 } });
    const err = await w.mk().submit(AMOUNT, w.key).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SwapFundsMayHaveMoved);
    expect(w.row().phase).toBe("signed");
    expect((err as SwapFundsMayHaveMoved).ref).toBe(w.key);

    for (let i = 0; i < 40 && (await w.deposit()) < AMOUNT; i++) await Bun.sleep(250); // let the broadcast confirm
    const honest = w.mk({ chain: makeSolanaDepositChain({ keeper: keeper(), mint: MINT, priorityMicroLamports: 0 }) });
    const first = await honest.status(w.key);
    expect(first.status).toBe("pending");
    expect(w.row().phase).toBe("deposited");
    await expectExactlyOneDeposit(w, before);
  });

  test("an RPC that cannot see a deposit that did land does not turn into a fallback: 1Click's own record wins, and without it the signature must also be old enough", async () => {
    await fundKeeper(AMOUNT);
    const before = await balanceOf(keeper().publicKey);
    // Blind: no signature status, and a finalized height far past the blockhash. The real chain still gets the broadcast.
    const blind = (real: DepositChain): DepositChain => ({ ...real, signatureStatus: async () => "absent", heights: async () => ({ confirmed: (await real.heights()).confirmed, finalized: 9e9 }) });
    const w = world({ chain: blind, limits: { confirmTimeoutMs: 1_000 } });
    w.fake.afterSign = (q) => w.fake.script(q.quote.depositAddress!, { status: "PROCESSING" }); // 1Click sees the deposit
    expect((await w.mk().submit(AMOUNT, w.key)).ref).toBe(w.key); // 1Click's record settles it: deposited
    expect(w.row().phase).toBe("deposited");
    await expectExactlyOneDeposit(w, before);

    // The same blindness, 1Click has not seen it yet, the signature is seconds old: not enough to say "no deposit".
    await fundKeeper(AMOUNT);
    const blinder = (real: DepositChain): DepositChain => ({ ...blind(real), depositAccountExists: async () => false });
    const w2 = world({ chain: blinder, limits: { confirmTimeoutMs: 1_000 } });
    const err = await w2.mk().submit(AMOUNT, w2.key).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SwapFundsMayHaveMoved);
    expect(w2.row().phase).toBe("signed");
    // The deposit address's token account is created by our own tx: seeing it settles the question without transaction history.
    for (let i = 0; i < 40 && (await w2.deposit()) < AMOUNT; i++) await Bun.sleep(250); // let the broadcast confirm
    const seeing = w2.mk({ chain: blind(makeSolanaDepositChain({ keeper: keeper(), mint: MINT, priorityMicroLamports: 0 })) });
    expect((await seeing.status(w2.key)).status).toBe("pending");
    expect(w2.row().phase).toBe("deposited");
  });

  describe("provably no deposit is the only way back to Solana payouts after a signature exists", () => {
    const expiredChain = (real: DepositChain): DepositChain => ({ ...real, heights: async () => ({ confirmed: 9e9, finalized: 9e9 }) });

    /** Signed bytes stored, never broadcast, then the process "dies" and a long time passes. */
    async function signedNeverSent(extra: Parameters<typeof world>[0] = {}) {
      await fundKeeper(AMOUNT);
      const w = world({ chain: expiredChain, ...extra });
      w.crashAt("signed_persisted");
      await w.mk().submit(AMOUNT, w.key).catch(() => null);
      expect(w.row().phase).toBe("signed");
      w.clock.t += 3 * 3_600_000; // past the request deadline
      return w;
    }

    test("signature absent, blockhash long expired, 1Click saw nothing: no_deposit, a PLAIN rejection, and the stale bytes are never sent", async () => {
      const w = await signedNeverSent();
      const err = await w.mk().submit(AMOUNT, w.key).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SwapFundsMayHaveMoved);
      expect(w.row().phase).toBe("no_deposit");
      expect(await w.deposit()).toBe(0n);
      expect(await makeSolanaDepositChain({ keeper: keeper(), mint: MINT, priorityMicroLamports: 0 }).signatureStatus(w.row().signature!)).toBe("absent");
      expect((await w.mk().status(w.key)).status).toBe("returned");
    });

    test("the same, but 1Click reports a deposit: it is a deposit, never a fallback", async () => {
      const w = await signedNeverSent();
      w.fake.script(w.fake.lastDepositAddress, { status: "PROCESSING" });
      const res = await w.mk().status(w.key);
      expect(res.status).toBe("pending");
      expect(w.row().phase).toBe("deposited");
    });

    test("the same, but 1Click cannot be reached: not proven, so still pending", async () => {
      const w = await signedNeverSent();
      w.fake.statusFails = true;
      const res = await w.mk().status(w.key);
      expect(res.status).toBe("pending");
      expect(w.row().phase).toBe("signed");
    });

    test("PENDING_DEPOSIT from 1Click counts as 'saw nothing', same as a 404", async () => {
      const w = await signedNeverSent();
      w.fake.unscripted = "PENDING_DEPOSIT";
      expect((await w.mk().status(w.key)).status).toBe("returned");
    });

    test("expired by the confirmed height but not yet by the finalized height plus margin: not proven", async () => {
      await fundKeeper(AMOUNT);
      const w = world({ chain: (real) => ({ ...real, heights: async () => ({ confirmed: 9e9, finalized: 0 }) }) });
      w.crashAt("signed_persisted");
      await w.mk().submit(AMOUNT, w.key).catch(() => null);
      w.clock.t += 3 * 3_600_000;
      expect((await w.mk().status(w.key)).status).toBe("pending");
      expect(w.row().phase).toBe("signed");
    });
  });

  describe("the engine's view (progressSwap)", () => {
    function epochWith(shares: [string, string][]): { id: string; unsent: db.PayoutRow[] } {
      const epoch: db.EpochRow = { id: `epoch-n1c-${crypto.randomUUID()}`, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" };
      db.upsertEpoch(epoch);
      for (const [wallet, amountZats] of shares) db.planPayout({ epochId: epoch.id, wallet, kind: "shielded", amountZats, zcashAddress: `uregtest1${wallet}` });
      return { id: epoch.id, unsent: db.getUnsentPayouts(epoch.id, "shielded") };
    }

    test("a crash after submit() resolved but before the epoch recorded it: the next run resumes the same swap, no second quote, no second deposit", async () => {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const { id, unsent } = epochWith([["w1", "1500000"], ["w2", "500000"]]);
      const w = world({ key: id });
      await w.mk().submit(AMOUNT, id); // the epoch id IS the key // deposit made; the engine process dies before upsertEpoch(submitted)
      expect(db.getEpoch(id)!.swapState).toBe("none");
      const key = id;
      const adapter = w.mk();
      expect(await progressSwap(id, unsent, adapter)).toBe("pending");
      expect(db.getEpoch(id)).toMatchObject({ swapState: "submitted", swapRef: key, swapProvider: "near-1click" });
      expect(w.fake.quoteRequests).toBe(1);
      await expectExactlyOneDeposit(w, before);

      deliver(w); // received 1,975,000; fee 5000 x (2 + 1); pro rata 3:1 of 1,960,000
      expect(await progressSwap(id, unsent, adapter)).toBe("settled");
      expect(db.getEpoch(id)!.swapAmountOutZats).toBe((AMOUNT - 25_000n).toString());
      const repriced = new Map(db.getFreshUnsentPayouts(id, "shielded").map((p) => [p.wallet, BigInt(p.amountZats)]));
      expect(repriced.get("w1")! + repriced.get("w2")!).toBe(AMOUNT - 25_000n - 15_000n);
      await expectExactlyOneDeposit(w, before);
    });

    test("submit() unresolved after the deposit was sent: the epoch is 'submitted', never 'failed_before_funds_moved'", async () => {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const { id, unsent } = epochWith([["w1", AMOUNT.toString()]]);
      const w = world({ key: id, chain: (real) => ({ ...real, signatureStatus: async () => "absent" as const }), limits: { confirmTimeoutMs: 1_500 } });
      expect(await progressSwap(id, unsent, w.mk())).toBe("pending");
      expect(db.getEpoch(id)!.swapState).toBe("submitted");
      await expectExactlyOneDeposit(w, before);
    });

    test("a swap refused before anything is signed falls back (plain rejection) and asks 1Click for nothing it cannot use", async () => {
      const { id, unsent } = epochWith([["w1", "999999"]]); // below the 1,000,000 floor
      const w = world();
      expect(await progressSwap(id, unsent, w.mk())).toBe("failed_before_funds_moved");
      expect(w.fake.quoteRequests).toBe(0);
    });

    test("REFUNDED and the refund is in the keeper's account: the epoch moves to returned_to_keeper (the fallback state), once", async () => {
      await fundKeeper(AMOUNT);
      const { id, unsent } = epochWith([["w1", AMOUNT.toString()]]);
      const w = world({ key: id });
      const adapter = w.mk();
      expect(await progressSwap(id, unsent, adapter)).toBe("pending");
      w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED", swapDetails: { refundedAmount: (AMOUNT - 715n).toString(), refundReason: "TEST" } });
      expect(await progressSwap(id, unsent, adapter)).toBe("pending"); // not on chain yet: no fallback
      expect(db.getEpoch(id)!.swapState).toBe("submitted");
      await sendToKeeper(await fundedStranger(), AMOUNT - 715n);
      expect(await progressSwap(id, unsent, adapter)).toBe("returned_to_keeper");
      expect(db.getEpoch(id)!.swapState).toBe("returned_to_keeper");
      expect(await progressSwap(id, unsent, adapter)).toBe("returned_to_keeper");
    });

    test("calling progressSwap again and again, with two adapters, makes one deposit", async () => {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const { id, unsent } = epochWith([["w1", AMOUNT.toString()]]);
      const w = world({ key: id });
      const results = await Promise.all([progressSwap(id, unsent, w.mk()), progressSwap(id, unsent, w.mk())]);
      expect(results).toEqual(["pending", "pending"]);
      expect(await progressSwap(id, unsent, w.mk())).toBe("pending");
      await expectExactlyOneDeposit(w, before);
    });
  });

  describe("1Click's answers after the deposit", () => {
    async function deposited(): Promise<{ w: World; adapter: SwapAdapter; before: bigint }> {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const w = world();
      const adapter = await started(w);
      return { w, adapter, before };
    }

    test("an unreadable status (HTTP 500), then an unknown address, then PENDING_DEPOSIT, PROCESSING, KNOWN_DEPOSIT_TX: always pending, never an error, never a fallback", async () => {
      const { w, adapter, before } = await deposited();
      w.fake.statusFails = true;
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/unavailable/) });
      w.fake.statusFails = false;
      expect((await adapter.status(w.key)).status).toBe("pending"); // 404: 1Click has not seen it yet
      for (const status of ["PENDING_DEPOSIT", "PROCESSING", "KNOWN_DEPOSIT_TX"] as const) {
        w.fake.script(w.fake.lastDepositAddress, { status });
        expect((await adapter.status(w.key)).status).toBe("pending");
      }
      await expectExactlyOneDeposit(w, before);
    });

    test("past the request deadline with the swap unfinished: still pending, with the reason, never a fallback", async () => {
      const { w, adapter, before } = await deposited();
      w.fake.script(w.fake.lastDepositAddress, { status: "PROCESSING" });
      w.clock.t += 3 * 3_600_000;
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/past the request deadline/) });
      w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED", swapDetails: { refundedAmount: (AMOUNT - 715n).toString() } });
      expect((await adapter.status(w.key)).status).toBe("pending"); // the refund itself must be seen first
      expect(w.row().phase).toBe("deposited");
      await expectExactlyOneDeposit(w, before);
    });

    test("a chain RPC that throws while polling is a pending answer, never an exception and never a fallback", async () => {
      const { w, before } = await deposited();
      const flaky = w.mk({ chain: { ...makeSolanaDepositChain({ keeper: keeper(), mint: MINT, priorityMicroLamports: 0 }), signatureStatus: async () => { throw new Error("RPC down"); }, findIncomingTransfer: async () => { throw new Error("RPC down"); } } });
      w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED", swapDetails: { refundedAmount: (AMOUNT - 715n).toString() } });
      expect(await flaky.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/could not search the keeper account/) });
      expect(w.row().phase).toBe("deposited");
      await expectExactlyOneDeposit(w, before);
    });

    test("a landed deposit that 1Click does not see is nudged with deposit/submit (best effort), without a second deposit", async () => {
      const { w, adapter, before } = await deposited();
      await adapter.status(w.key);
      expect(w.fake.depositSubmits.length).toBe(1);
      expect(w.fake.depositSubmits[0]).toEqual({ txHash: w.row().signature!, depositAddress: w.fake.lastDepositAddress });
      await expectExactlyOneDeposit(w, before);
    });

    test("SUCCESS is not settled until the treasury wallet has the note, with enough confirmations, spendable, and not more than was deposited", async () => {
      const { w, adapter } = await deposited();
      deliver(w);
      w.treasury.receipt = null;
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/has not seen it/) });
      w.treasury.receipt = { zats: AMOUNT - 25_000n, confirmations: 3, spendableZats: 0n };
      expect((await adapter.status(w.key)).status).toBe("pending");
      w.treasury.receipt = { zats: AMOUNT - 25_000n, confirmations: 12, spendableZats: 100n };
      expect((await adapter.status(w.key)).status).toBe("pending");
      w.treasury.receipt = { zats: AMOUNT + 1n, confirmations: 12, spendableZats: AMOUNT + 1n };
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/needs a human/) });
      w.treasury.receipt = { zats: 0n, confirmations: 12, spendableZats: 0n };
      expect((await adapter.status(w.key)).status).toBe("pending");
      expect(w.row().phase).toBe("deposited");
      w.treasury.receipt = { zats: AMOUNT - 25_000n, confirmations: 12, spendableZats: AMOUNT - 25_000n };
      expect((await adapter.status(w.key)).status).toBe("settled");
    });

    test("a delivery txid that already settled another epoch is never counted twice", async () => {
      const replayed = randomTxid();
      const first = await deposited();
      deliver(first.w, {}, replayed);
      expect((await first.adapter.status(first.w.key)).status).toBe("settled");
      const second = await deposited();
      deliver(second.w, {}, replayed); // the same txid, replayed in the next epoch's status
      expect(await second.adapter.status(second.w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/already the settlement/) });
      expect(second.w.row().phase).toBe("deposited");
    });

    test("SUCCESS without a valid Zcash txid is pending", async () => {
      const { w, adapter } = await deposited();
      w.fake.script(w.fake.lastDepositAddress, { status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ hash: "not-a-txid" }] } });
      expect((await adapter.status(w.key)).status).toBe("pending");
    });

    test("a status payload whose embedded quote is not signed by 1Click, or is for another address, is ignored", async () => {
      const { w, adapter } = await deposited();
      deliver(w);
      const forged = w.fake.quotes[w.fake.quotes.length - 1]!;
      forged.quote.amountOut = "1"; // the stored copy the fake serves no longer matches its signature
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/signature/) });
      expect(w.row().phase).toBe("deposited");
    });

    test("FAILED stays pending (no fallback); INCOMPLETE_DEPOSIT stays pending; a later REFUNDED with the refund in the account then returns", async () => {
      const { w, adapter, before } = await deposited();
      w.fake.script(w.fake.lastDepositAddress, { status: "FAILED" });
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/FAILED/) });
      w.fake.script(w.fake.lastDepositAddress, { status: "INCOMPLETE_DEPOSIT" });
      expect((await adapter.status(w.key)).status).toBe("pending");
      w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED", swapDetails: { refundedAmount: (AMOUNT - 715n).toString() } });
      expect((await adapter.status(w.key)).status).toBe("pending");
      await expectExactlyOneDeposit(w, before); // nothing came back yet, the deposit still counts once

      const stranger = await fundedStranger();
      await sendToKeeper(stranger, AMOUNT - 700n); // wrong amount: not the refund
      expect((await adapter.status(w.key)).status).toBe("pending");
      await sendToKeeper(stranger, AMOUNT - 715n); // the refund
      expect((await adapter.status(w.key)).status).toBe("returned");
      expect(w.row().phase).toBe("returned");
      expect(w.row().refundSig).toBeTruthy();
    });

    test("REFUNDED with no refunded amount, or with only the keeper's own transfer of that amount, never returns", async () => {
      const { w, adapter } = await deposited();
      w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED" });
      expect(await adapter.status(w.key)).toMatchObject({ status: "pending", note: expect.stringMatching(/without a refunded amount/) });
      w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED", swapDetails: { refundedAmount: "123456" } });
      await fundKeeper(123_456n); // minted by the keeper itself: the keeper is the fee payer, so it does not count
      expect((await adapter.status(w.key)).status).toBe("pending");
      expect(w.row().phase).toBe("deposited");
    });
  });

  describe("quotes that are refused before anything is signed (INV-14)", () => {
    const attacks: [string, (f: Fake1Click) => void, RegExp][] = [
      ["a different recipient (signed by 1Click)", (f) => (f.beforeSign = (q) => (q.quoteRequest.recipient = "u1attacker")), /quoteRequest\.recipient/],
      ["a different refund address", (f) => (f.beforeSign = (q) => (q.quoteRequest.refundTo = Keypair.generate().publicKey.toBase58())), /quoteRequest\.refundTo/],
      ["a different amountIn", (f) => (f.beforeSign = (q) => (q.quote.amountIn = (BigInt(q.quote.amountIn) * 2n).toString())), /quote\.amountIn/],
      ["the keeper's own address as the deposit address", (f) => (f.beforeSign = (q) => (q.quote.depositAddress = keeper().publicKey.toBase58())), /keeper's own address/],
      ["a deposit address that is not an address", (f) => (f.beforeSign = (q) => (q.quote.depositAddress = "nope")), /depositAddress/],
      ["a minAmountOut that loses nearly everything", (f) => (f.beforeSign = (q) => (q.quote.minAmountOut = "1")), /loses more than/],
      ["a request deadline that is not the one we sent", (f) => (f.beforeSign = (q) => (q.quoteRequest.deadline = new Date(Date.now() + 1000).toISOString())), /quoteRequest\.deadline/],
      ["a man in the middle changing the deposit address after signing", (f) => (f.afterSign = (q) => (q.quote.depositAddress = Keypair.generate().publicKey.toBase58())), /signature does not verify/],
      ["a quote signed by someone else", (f) => (f.afterSign = (q) => (q.signature = "ed25519:" + "1".repeat(64))), /signature does not verify/],
    ];
    for (const [label, attack, expected] of attacks) {
      test(label, async () => {
        await fundKeeper(AMOUNT);
        const before = await balanceOf(keeper().publicKey);
        const w = world();
        attack(w.fake);
        const err = await w.mk().submit(AMOUNT, w.key).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(SwapFundsMayHaveMoved);
        expect((err as Error).message).toMatch(expected);
        expect(db.getNear1ClickSwap(w.key)).toBeNull(); // nothing stored, nothing signed
        expect(await balanceOf(keeper().publicKey)).toBe(before);
        expect(w.fake.quotes.length > 0 ? await w.deposit() : 0n).toBe(0n);
      });
    }

    test("a deposit address 1Click already gave to another epoch is refused (it would be a shared deposit)", async () => {
      await fundKeeper(AMOUNT * 2n);
      const w1 = world();
      await w1.mk().submit(AMOUNT, w1.key);
      const w2 = world();
      w2.fake.beforeSign = (q) => (q.quote.depositAddress = w1.fake.lastDepositAddress);
      await expect(w2.mk().submit(AMOUNT, w2.key)).rejects.toThrow();
      expect(db.getNear1ClickSwap(w2.key)).toBeNull();
    });
  });

  describe("limits and preconditions: plain rejections before any quote", () => {
    test("below the floor, above the per-epoch cap, and more than the keeper holds", async () => {
      const w = world();
      const adapter = w.mk();
      await expect(adapter.submit(999_999n, w.key)).rejects.toThrow(/below the 1000000 zats floor/);
      await expect(adapter.submit(config.near1click.maxSwapZats + 1n, w.key)).rejects.toThrow(/per-epoch cap/);
      const uncapped = world({ limits: { maxSwapZats: 10n ** 15n } }).mk();
      await expect(uncapped.submit((await balanceOf(keeper().publicKey)) + 1n, w.key)).rejects.toThrow(/balance is below/);
      expect(w.fake.quoteRequests).toBe(0);
      expect(db.getNear1ClickSwap(w.key)).toBeNull();
    });

    test("the defaults are the plan's: 0.01 ZEC floor, 0.5 ZEC cap", () => {
      expect(config.near1click.minSwapZats).toBe(1_000_000n);
      expect(config.near1click.maxSwapZats).toBe(50_000_000n);
    });

    test("1Click refusing the quote (HTTP 400) is a plain rejection and stores nothing", async () => {
      await fundKeeper(AMOUNT);
      const w = world();
      w.fake.quoteFails = true;
      const err = await w.mk().submit(AMOUNT, w.key).then(() => null, (e: unknown) => e);
      expect((err as Error).message).toMatch(/HTTP 400/);
      expect(err).not.toBeInstanceOf(SwapFundsMayHaveMoved);
      expect(db.getNear1ClickSwap(w.key)).toBeNull();
    });

    test("a dry quote works and needs no keeper balance; a quote with a bad signature is refused", async () => {
      const w = world();
      expect(await w.mk().quote(AMOUNT)).toEqual({ outZats: AMOUNT - 32_000n });
      const bad = new Fake1Click();
      const adapter = makeNear1ClickAdapter(TREASURY, { client: makeOneClickClient({ baseUrl: "http://x", fetch: bad.fetch }), chain: makeSolanaDepositChain({ keeper: keeper(), mint: MINT, priorityMicroLamports: 0 }), keeperAddress: keeper().publicKey.toBase58(), receivedByTreasury: async () => null, now: Date.now, sleep: async () => {}, quoteSigner: new Fake1Click().signer });
      await expect(adapter.quote(AMOUNT)).rejects.toThrow(/signature/);
    });
  });

  describe("a quote that expired before anything was signed", () => {
    test("is replaced by a fresh one (nothing was signed, so no deposit can exist), and the deposit is still made once", async () => {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const w = world();
      w.crashAt("quote_persisted");
      await w.mk().submit(AMOUNT, w.key).catch(() => null);
      w.clock.t += 3 * 3_600_000;
      await w.mk().submit(AMOUNT, w.key);
      expect(w.fake.quoteRequests).toBe(2);
      expect(w.row().attempts).toBe(2);
      await expectExactlyOneDeposit(w, before);
    });

    test("after the attempt limit it gives up with a plain rejection", async () => {
      await fundKeeper(AMOUNT);
      const w = world({ limits: { maxQuoteAttempts: 1 } });
      w.crashAt("quote_persisted");
      await w.mk().submit(AMOUNT, w.key).catch(() => null);
      w.clock.t += 3 * 3_600_000;
      const err = await w.mk().submit(AMOUNT, w.key).then(() => null, (e: unknown) => e);
      expect((err as Error).message).toMatch(/no usable 1Click quote/);
      expect(err).not.toBeInstanceOf(SwapFundsMayHaveMoved);
      expect(await w.deposit()).toBe(0n);
    });
  });

  describe("two callers at once", () => {
    test("concurrent submit() calls for one epoch make one deposit and return the same ref", async () => {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const w = world();
      const [a, b] = await Promise.all([w.mk().submit(AMOUNT, w.key), w.mk().submit(AMOUNT, w.key)]);
      expect(a).toEqual(b);
      expect(w.row().phase).toBe("deposited");
      const depositAddress = w.row().depositAddress;
      expect(await balanceOf(new PublicKey(depositAddress))).toBe(AMOUNT);
      expect(before - (await balanceOf(keeper().publicKey))).toBe(AMOUNT);
    });

    test("a different amount asked for on resume does not start a second swap; the original runs", async () => {
      await fundKeeper(AMOUNT);
      const before = await balanceOf(keeper().publicKey);
      const w = world();
      await w.mk().submit(AMOUNT, w.key);
      expect(await w.mk().submit(AMOUNT + 500_000n, w.key)).toEqual({ ref: w.key });
      expect(w.fake.quoteRequests).toBe(1);
      await expectExactlyOneDeposit(w, before);
    });
  });

  test("a swap that provably ended with the ZEC back in the keeper account is never restarted by a later submit()", async () => {
    await fundKeeper(AMOUNT);
    const w = world();
    const adapter = await started(w);
    w.fake.script(w.fake.lastDepositAddress, { status: "REFUNDED", swapDetails: { refundedAmount: (AMOUNT - 715n).toString() } });
    await sendToKeeper(await fundedStranger(), AMOUNT - 715n);
    expect((await adapter.status(w.key)).status).toBe("returned");
    await expect(w.mk().submit(AMOUNT, w.key)).rejects.toThrow(/not starting another/);
    expect(w.fake.quoteRequests).toBe(1);
  });
});
