// Audit O-2: a stuck epoch must not block every later epoch forever. After a bounded number of runs (or an
// age) it is parked (needs_attention): its rows stay unsent and owed, it is still progressed on every run, an
// alert is raised, and a later epoch starts only if the parked money is provably separate from it.
// Real runEpoch against the local validator (skipped without one); the swap is a stub that stays pending.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { config } from "../src/config";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import type { IsolationDeps } from "../src/epoch/stuck";
import { getTreasuryView } from "../src/ledger";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import type { SwapAdapter, SwapSettlement } from "../src/swap/types";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const MINT = config.solana.dbc.quoteMint;
const conn = getConnection();
const ataOf = (owner: Keypair["publicKey"]) => getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM_ID);
const zecOf = async (owner: Keypair["publicKey"]) => {
  try {
    return (await getAccount(conn, ataOf(owner), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};
async function fundKeeper(zats: bigint): Promise<void> {
  const k = loadKeeperKeypair();
  await mintTo(conn, k, MINT, ataOf(k.publicKey), k, zats);
}

let swapStatus: SwapSettlement = { status: "pending", note: "1Click is down" };
const stubSwap: SwapAdapter = {
  provider: "simulated",
  quote: async () => ({ outZats: 0n }),
  submit: async () => {
    throw new Error("the stuck epoch's swap was already submitted");
  },
  status: async () => swapStatus,
};
const noClaims = async () => {};
const isolated: IsolationDeps = { keeperZecBalance: async () => 10n ** 15n, treasurySpendableZats: async () => 10n ** 15n };
const SHIELDED = 1_000_000n;
const ADDRESS = "u1" + "q".repeat(60);

const original = { attempts: config.epoch.stuckMaxAttempts, age: config.epoch.stuckMaxAgeMs };
const setBounds = (attempts: number, ageMs: number) => {
  (config.epoch as { stuckMaxAttempts: number }).stuckMaxAttempts = attempts;
  (config.epoch as { stuckMaxAgeMs: number }).stuckMaxAgeMs = ageMs;
};

/** Sets every other unfinished epoch of the shared test DB aside, then returns an epoch owing shielded rows with the given swap state. */
function stuckEpoch(swapState: "submitted" | "settled", wallets = [Keypair.generate().publicKey.toBase58()]): { id: string; wallets: string[] } {
  db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("UPDATE epochs SET status = 'ok' WHERE status = 'needs_attention'").run();
  db.getDb().query("DELETE FROM carry").run();
  const id = `epoch-stuck-${crypto.randomUUID()}`;
  db.upsertEpoch({
    id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: SHIELDED.toString(), feeZats: "0", status: "ok", swapProvider: "simulated",
    swapRef: "ref-" + id, swapState, swapAmountOutZats: swapState === "settled" ? SHIELDED.toString() : null, zcashTxids: "[]",
  });
  for (const w of wallets) db.planPayout({ epochId: id, wallet: w, kind: "shielded", amountZats: SHIELDED.toString(), zcashAddress: ADDRESS });
  return { id, wallets };
}

beforeEach(() => {
  swapStatus = { status: "pending", note: "1Click is down" };
  db.getDb().query("DELETE FROM alerts").run(); // the tests below read the whole open list: other files (the carry rule's swap_refused) leave alerts in the shared database
  db.setMeta("shielded_carried_rounds", "0"); // and the carried-round count, which three refunds in earlier files would otherwise turn into a standing alert here
});
afterEach(() => {
  setBounds(original.attempts, original.age);
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("UPDATE epochs SET status = 'ok', parkedAt = NULL WHERE status = 'needs_attention'").run();
  db.getDb().query("DELETE FROM alerts").run();
});

describe.if(await validatorUp())("a stuck epoch is parked and stops blocking (audit O-2)", () => {
  test("before: an unfinished epoch is the only thing every run does; after the bound it is parked, its rows stay owed, an alert is raised", async () => {
    setBounds(3, 10 * 24 * 3_600_000);
    const { id } = stuckEpoch("submitted");
    const owedBefore = (await getTreasuryView()).owedZats;
    for (let run = 1; run <= 2; run++) {
      const out = await runEpoch(stubSwap, noClaims, { isolation: isolated });
      expect(out.epoch?.id).toBe(id);
      expect(out.epoch?.status).toBe("partial");
      expect(db.getEpoch(id)!.attempts).toBe(run);
    }
    const third = await runEpoch(stubSwap, noClaims, { isolation: isolated });
    expect(third.epoch?.status).toBe("needs_attention");
    const parked = db.getEpoch(id)!;
    expect(parked.status).toBe("needs_attention");
    expect(parked.attentionReason).toMatch(/unfinished after 3 runs/);
    expect(db.getUnsentPayouts(id, "shielded").length).toBe(1); // still owed
    expect((await getTreasuryView()).owedZats).toBe(owedBefore); // still accounted
    expect((await getTreasuryView()).epochsNeedingAttention).toBe(1);
    expect(db.listOpenAlerts().map((a) => [a.kind, a.epochId])).toEqual([["epoch_parked", id]]);
    expect(db.findResumableSentEpoch()).toBeNull(); // it no longer blocks
  }, 60_000);

  test("an epoch older than the age bound is parked on its first unfinished run", async () => {
    setBounds(1000, 3_600_000);
    const { id } = stuckEpoch("submitted");
    const out = await runEpoch(stubSwap, noClaims, { isolation: isolated, nowMs: () => Date.now() + 2 * 3_600_000 });
    expect(out.epoch?.status).toBe("needs_attention");
    expect(db.getEpoch(id)!.attentionReason).toMatch(/unfinished for 2 hours/);
  });

  test("with the parked money provably separate, the next run starts and pays a NEW epoch while the parked one stays owed", async () => {
    setBounds(1, 10 * 24 * 3_600_000);
    const { id } = stuckEpoch("submitted");
    await runEpoch(stubSwap, noClaims, { isolation: isolated }); // parked at once
    expect(db.getEpoch(id)!.status).toBe("needs_attention");

    await fundKeeper(2_000_000n);
    const holder = Keypair.generate().publicKey;
    let claimCalls = 0;
    const claimStep = async (epochId: string) => {
      claimCalls++;
      db.recordEpochCoinHarvest(epochId, "NewCoin1111111111111111111111111111111111111", 1_000_000n, [{ wallet: holder.toBase58(), amount: 1_000_000n }]);
    };
    const out = await runEpoch(stubSwap, claimStep, { isolation: isolated });
    expect(claimCalls).toBe(1);
    expect(out.halted).toBeUndefined();
    expect(out.epoch?.id).not.toBe(id);
    expect(await zecOf(holder)).toBe(1_000_000n);
    // the parked epoch is untouched: still unsent, still parked
    expect(db.getUnsentPayouts(id, "shielded").length).toBe(1);
    expect(db.getEpoch(id)!.status).toBe("needs_attention");
  }, 60_000);

  test("if the parked money cannot be told apart from new fees, no new epoch starts and an alert says why", async () => {
    setBounds(1, 10 * 24 * 3_600_000);
    const { id } = stuckEpoch("submitted", [Keypair.generate().publicKey.toBase58()]);
    // a Solana-rail row owed from the keeper whose batch has no stored bytes (an older DB): it can never be
    // proven landed or dead, so it waits for a human, and its 700,000 zats must stay in the keeper's account
    const stranded = Keypair.generate().publicKey.toBase58();
    db.planPayout({ epochId: id, wallet: stranded, kind: "solana", amountZats: "700000" });
    db.markPayoutPending(id, stranded, "solana", "1".repeat(64));
    await runEpoch(stubSwap, noClaims, { isolation: isolated }); // parks at once
    expect(db.getEpoch(id)!.status).toBe("needs_attention");
    let claimCalls = 0;
    const claimStep = async () => {
      claimCalls++;
    };
    const broke: IsolationDeps = { keeperZecBalance: async () => 100n, treasurySpendableZats: async () => 10n ** 15n };
    const out = await runEpoch(stubSwap, claimStep, { isolation: broke });
    expect(out.halted?.[0]).toMatch(/keeper holds 100 zats/);
    expect(claimCalls).toBe(0);
    expect(db.listOpenAlerts().some((a) => a.kind === "epochs_halted")).toBe(true);
  }, 60_000);

  test("owed from the treasury wallet for a settled swap: an unreadable or too small wallet halts, a sufficient one proceeds", async () => {
    setBounds(1, 10 * 24 * 3_600_000);
    stuckEpoch("settled");
    db.getDb().query("UPDATE epochs SET status = 'needs_attention' WHERE swapState = 'settled' AND status = 'ok' AND id LIKE 'epoch-stuck-%' AND at > $t").run({ $t: new Date(Date.now() - 60_000).toISOString() });
    const claim = async () => {};
    const unreadable: IsolationDeps = { keeperZecBalance: async () => 10n ** 15n, treasurySpendableZats: async () => null };
    const small: IsolationDeps = { keeperZecBalance: async () => 10n ** 15n, treasurySpendableZats: async () => SHIELDED - 1n };
    expect((await runEpoch(stubSwap, claim, { isolation: unreadable })).halted?.[0]).toMatch(/could not be read/);
    expect((await runEpoch(stubSwap, claim, { isolation: small })).halted?.[0]).toMatch(/treasury wallet holds/);
  }, 60_000);

  test("a parked epoch is progressed on every run: once its swap is refunded it finishes and the alert clears", async () => {
    setBounds(1, 10 * 24 * 3_600_000);
    const wallet = Keypair.generate().publicKey;
    const { id } = stuckEpoch("submitted", [wallet.toBase58()]);
    await runEpoch(stubSwap, noClaims, { isolation: isolated });
    expect(db.getEpoch(id)!.status).toBe("needs_attention");
    expect(db.listOpenAlerts().length).toBe(1);

    await fundKeeper(2_000_000n);
    swapStatus = { status: "returned" }; // 1Click refunded: the keeper holds the ZEC again and the share carries to the next shielded round
    await runEpoch(stubSwap, noClaims, { isolation: isolated });
    expect(db.getEpoch(id)!.status).toBe("ok");
    expect(db.getEpoch(id)!.parkedAt).toBeNull();
    expect(db.getUnsentPayouts(id, "shielded").length).toBe(0);
    expect(await zecOf(wallet)).toBe(0n); // never paid on the public rail (audit S6, product decision 2)
    expect(db.getCarry(wallet.toBase58(), "shielded")).toBe(SHIELDED);
    db.resolveAlerts("swap_refused", id); // the refund's own alert, raised on purpose; the parked alert is what this test is about
    expect(db.listOpenAlerts().length).toBe(0);
    expect((await getTreasuryView()).epochsNeedingAttention).toBe(0);
  }, 60_000);

  test("an error that repeats counts as a run, and parks the epoch instead of failing every run for good", async () => {
    setBounds(2, 10 * 24 * 3_600_000);
    const { id } = stuckEpoch("submitted");
    const broken: SwapAdapter = { ...stubSwap, status: async () => { throw new Error("lightwalletd unreachable"); } };
    await expect(runEpoch(broken, noClaims, { isolation: isolated })).rejects.toThrow(/lightwalletd/);
    const out = await runEpoch(broken, noClaims, { isolation: isolated });
    expect(out.epoch?.status).toBe("needs_attention");
    expect(db.getEpoch(id)!.attentionReason).toMatch(/lightwalletd unreachable/);
  }, 60_000);
});
