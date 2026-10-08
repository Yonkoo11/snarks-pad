// Owner policy 2026-10-02 through the real runEpoch, the real local validator and the real regtest treasury: holders
// get 75% of each claim, the team 25%, and the team share first pays the cost of delivering opted-in holders'
// rewards shielded. Money paths get fault injection: a swap that fails, one that is refunded, a crash while the swap
// is out, a team transfer signed but never broadcast, one that already landed.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAccount,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import bs58 from "bs58";
import { epochSplit, handleRequest } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { claimRemainingCoins, runEpoch, type ClaimDeps } from "../src/epoch/engine";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import type { SwapAdapter, SwapSettlement } from "../src/swap/types";
import { getTreasuryView } from "../src/ledger";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

async function regtestUp(): Promise<boolean> {
  try {
    return (await fetch(config.zcash.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getblockcount", params: [] }) })).ok;
  } catch {
    return false;
  }
}

const LIVE = (await validatorUp()) && (await regtestUp());
const MINT = config.solana.dbc.quoteMint;
const COIN = Keypair.generate().publicKey.toBase58();
const team = config.epoch.team as { shareBps: number; wallet: string | null };
const saved = { shareBps: team.shareBps, wallet: team.wallet };

function deriveRegtestUA(mnemonic: string): string {
  const proc = Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "derive-address", "--mnemonic", mnemonic, "--network", "regtest"]);
  return /Unified Address:\s*(\S+)/.exec(new TextDecoder().decode(proc.stdout))![1]!;
}
// Derived only where the suites below will run: on a clone without the built zcash-devtool the spawn is ENOENT, and at module
// level that was an unhandled error instead of the skip the describe.if(LIVE) guards intend (fresh-clone run, 2026-10-04).
const UA_B = LIVE ? deriveRegtestUA("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about") : "";
const UA_C = LIVE ? deriveRegtestUA("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong") : "";

async function zecOf(owner: PublicKey | string): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(MINT, new PublicKey(owner), false, TOKEN_PROGRAM_ID);
    return (await getAccount(getConnection(), ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function fundKeeper(zats: bigint): Promise<void> {
  const k = loadKeeperKeypair();
  // On a fresh chain the keeper has no ZEC account yet: create it rather than depend on another test file having done so.
  const ata = (await getOrCreateAssociatedTokenAccount(getConnection(), k, MINT, k.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(getConnection(), k, MINT, ata, k, zats);
}

/** Test isolation: this file's epochs share a database with every other test's, so the team ledger starts empty. */
function resetShared(): void {
  (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0;
  db.getDb().query("DELETE FROM payouts WHERE kind = 'team'").run();
  db.getDb().query("UPDATE epochs SET teamGrossZats = '0', deliveryReserveZats = '0', deliveryCostZats = NULL, teamNativeZats = '0', teamSolanaZats = NULL").run();
  db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("DELETE FROM carry").run();
  db.getDb().query("DELETE FROM optins").run();
  db.getDb().query("UPDATE epochs SET status = 'ok' WHERE status IN ('partial','needs_attention')").run();
}

beforeAll(() => {
  if (!LIVE) return;
  db.upsertCoin({ mint: COIN, name: "Ledger", symbol: "LED", imageUrl: "", description: "", creator: Keypair.generate().publicKey.toBase58(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
  db.markCoinLaunched(COIN, Keypair.generate().publicKey.toBase58());
});

afterAll(() => {
  if (LIVE) db.upsertCoin({ ...db.getCoin(COIN)!, status: "pending" }); // later test files must not see a launched coin with no pool
});

afterEach(() => {
  team.shareBps = saved.shareBps;
  team.wallet = saved.wallet;
});

function holder(w: Keypair | string, weight: bigint) {
  return { wallet: typeof w === "string" ? w : w.publicKey.toBase58(), balance: weight };
}

/** A claim step that records `claimed` for COIN through the real claimRemainingCoins (so the real team split runs), with these holders. */
function claimOf(claimed: bigint, holders: ReturnType<typeof holder>[]) {
  const deps: ClaimDeps = {
    claimCoin: async (_e, coin) => (coin.mint === COIN ? claimed : 0n),
    currentHolders: async () => holders.map((h) => ({ wallet: h.wallet, balance: h.balance })),
  };
  return (epochId: string) => claimRemainingCoins(epochId, deps);
}

interface FakeSwap extends SwapAdapter {
  submits: bigint[];
}

/** A swap that keeps `keep` zats of what it is given and settles at once (or does whatever `behavior` says). */
function fakeSwap(behavior: { keep?: bigint; reject?: boolean; status?: SwapSettlement; failStatusOnce?: boolean }): FakeSwap {
  let statusCalls = 0;
  const swap: FakeSwap = {
    provider: "near-1click",
    submits: [],
    quote: async () => ({ outZats: 0n }),
    submit: async (amount) => {
      swap.submits.push(amount);
      if (behavior.reject) throw new Error("keeper balance too low");
      return { ref: `fake-${swap.submits.length}-${amount}` };
    },
    status: async () => {
      statusCalls++;
      if (behavior.failStatusOnce && statusCalls === 1) throw new Error("1Click unreachable (injected)");
      if (behavior.status) return behavior.status;
      return { status: "settled", amountOutZats: swap.submits[0]! - (behavior.keep ?? 0n) };
    },
  };
  return swap;
}

const shieldedAmount = (epochId: string, wallet: string): bigint => BigInt(db.getPayouts(epochId).find((p) => p.wallet === wallet && p.kind === "shielded")!.amountZats);

describe.if(LIVE)("the team share and the delivery cost, through runEpoch", () => {
  test("the reserve covers the cost: opted-in holders get their FULL share, Solana holders theirs on chain, the team keeps the rest", async () => {
    resetShared();
    const a = Keypair.generate();
    const b = Keypair.generate();
    const c = Keypair.generate();
    db.upsertOptin(b.publicKey.toBase58(), UA_B);
    db.upsertOptin(c.publicKey.toBase58(), UA_C);
    const CLAIMED = 4_500_000n; // team 1,125,000; holders 3,375,000; each of three equal holders 1,125,000
    await fundKeeper(CLAIMED);
    const swap = fakeSwap({ keep: 37_000n }); // the swap keeps 37,000 (withdraw fee and spread)

    const out = await runEpoch(swap, claimOf(CLAIMED, [holder(a, 100n), holder(b, 100n), holder(c, 100n)]));
    const epoch = out.epoch!;
    const e = db.getEpoch(epoch.id)!;

    expect(e.harvestedZats).toBe("4500000");
    expect(e.teamGrossZats).toBe("1125000");
    expect(e.deliveryReserveZats).toBe("69500"); // 32,000 withdraw + 5,000 x 3 Zcash + 1% of 2,250,000
    expect(swap.submits).toEqual([2_250_000n + 69_500n]); // the holders' shielded total plus the reserve, in ONE swap
    // Full share for the opted-in holders: the cost came out of the team's reserve, not out of them.
    expect(shieldedAmount(epoch.id, b.publicKey.toBase58())).toBe(1_125_000n);
    expect(shieldedAmount(epoch.id, c.publicKey.toBase58())).toBe(1_125_000n);
    expect(await zecOf(a.publicKey)).toBe(1_125_000n);
    // The ledger: cost 37,000 swap + 15,000 Zcash fee estimate = 52,000 of the 69,500 reserved; 17,500 is native ZEC left for the team.
    expect(e).toMatchObject({ deliveryCostZats: "52000", teamNativeZats: "17500", teamSolanaZats: "1055500", holderShortfallZats: "0", status: "ok" });
    expect(epochSplit(e)).toMatchObject({ holdersZats: "3375000", teamZats: "1125000", deliveryCostZats: "52000", teamNetZats: "1073000" });
    // Every zat of the claim is accounted for: holders + team net + delivery cost.
    expect(3_375_000n + 1_073_000n + 52_000n).toBe(CLAIMED);
  }, 300_000);

  test("CAP: when the team share is smaller than the delivery cost, the team pays all it has and the shielded holders bear the rest, pro rata", async () => {
    resetShared();
    team.shareBps = 100; // 1% to the team makes it smaller than the cost
    const a = Keypair.generate();
    const b = Keypair.generate();
    const c = Keypair.generate();
    db.upsertOptin(b.publicKey.toBase58(), UA_B);
    db.upsertOptin(c.publicKey.toBase58(), UA_C);
    const CLAIMED = 4_500_000n; // team 45,000; holders 4,455,000; each 1,485,000
    await fundKeeper(CLAIMED);
    const swap = fakeSwap({ keep: 37_000n });

    const epoch = (await runEpoch(swap, claimOf(CLAIMED, [holder(a, 100n), holder(b, 100n), holder(c, 100n)]))).epoch!;
    const e = db.getEpoch(epoch.id)!;

    expect(e.teamGrossZats).toBe("45000");
    expect(e.deliveryReserveZats).toBe("45000"); // the whole team share, never more
    expect(swap.submits).toEqual([2_970_000n + 45_000n]);
    // 37,000 swap + 15,000 Zcash fee = 52,000 of cost; the team covers 45,000; the 7,000 excess is split between B and C.
    expect(e).toMatchObject({ deliveryCostZats: "45000", teamNativeZats: "0", teamSolanaZats: "0", holderShortfallZats: "7000" });
    const paidB = shieldedAmount(epoch.id, b.publicKey.toBase58());
    const paidC = shieldedAmount(epoch.id, c.publicKey.toBase58());
    expect(paidB + paidC).toBe(2_970_000n - 7_000n);
    expect(paidB).toBe(1_481_500n); // equal weights, equal burden
    expect(paidC).toBe(1_481_500n);
    expect(await zecOf(a.publicKey)).toBe(1_485_000n); // the Solana holder never pays for the shielded rail
    expect(epochSplit(e).teamNetZats).toBe("0"); // the team went to zero, not below it
  }, 300_000);

  test("the swap is rejected before any deposit: the opted-in share carries to the next shielded round (nothing on the public rail), and the reserve returns to the team's Solana ZEC", async () => {
    resetShared();
    const b = Keypair.generate();
    const a = Keypair.generate();
    db.upsertOptin(b.publicKey.toBase58(), UA_B);
    const CLAIMED = 4_000_000n; // team 1,000,000; holders 3,000,000; A 1,500,000, B 1,500,000
    await fundKeeper(CLAIMED);
    const swap = fakeSwap({ reject: true });

    const epoch = (await runEpoch(swap, claimOf(CLAIMED, [holder(a, 50n), holder(b, 50n)]))).epoch!;
    const e = db.getEpoch(epoch.id)!;

    expect(e.swapState).toBe("failed_before_funds_moved");
    expect(e.status).toBe("ok");
    expect(await zecOf(b.publicKey)).toBe(0n); // never paid on Solana (audit S6, product decision 2)
    expect(db.getCarry(b.publicKey.toBase58(), "shielded")).toBe(1_500_000n); // carried in full
    expect(e).toMatchObject({ deliveryCostZats: "0", teamNativeZats: "0", teamSolanaZats: "1000000", holderShortfallZats: "0" });
    // A second run changes nothing: the delivery was resolved once.
    await runEpoch(swap, async () => {});
    expect(db.getEpoch(epoch.id)).toMatchObject({ teamSolanaZats: "1000000", deliveryCostZats: "0" });
    expect(await zecOf(b.publicKey)).toBe(0n); // still nothing on the public rail; the carry is planned by the next shielded round
    expect(db.getCarry(b.publicKey.toBase58(), "shielded")).toBe(1_500_000n);
  }, 300_000);

  test("a refund after the deposit ('returned') leaves the reserve unspent too, and carries the share once", async () => {
    resetShared();
    const a = Keypair.generate();
    const b = Keypair.generate();
    db.upsertOptin(b.publicKey.toBase58(), UA_B);
    const CLAIMED = 4_000_000n;
    await fundKeeper(CLAIMED);
    const swap = fakeSwap({ status: { status: "returned" } });

    const epoch = (await runEpoch(swap, claimOf(CLAIMED, [holder(a, 50n), holder(b, 50n)]))).epoch!;
    expect(db.getEpoch(epoch.id)).toMatchObject({ swapState: "returned_to_keeper", teamSolanaZats: "1000000", deliveryCostZats: "0" });
    expect(await zecOf(b.publicKey)).toBe(0n); // carried, not paid on Solana (audit S6, product decision 2)
    expect(db.getCarry(b.publicKey.toBase58(), "shielded")).toBe(1_500_000n);
    await runEpoch(swap, async () => {});
    expect(await zecOf(b.publicKey)).toBe(0n);
    expect(db.getCarry(b.publicKey.toBase58(), "shielded")).toBe(1_500_000n);
    expect(swap.submits.length).toBe(1);
  }, 300_000);

  test("a crash while the swap is out: the next run does not submit again, and the delivery is resolved exactly once", async () => {
    resetShared();
    const a = Keypair.generate();
    const b = Keypair.generate();
    db.upsertOptin(b.publicKey.toBase58(), UA_B);
    const CLAIMED = 4_000_000n; // team 1,000,000; holders 3,000,000
    await fundKeeper(CLAIMED);
    const swap = fakeSwap({ keep: 40_000n, failStatusOnce: true }); // the status call after submit throws (a crash/timeout)

    const first = await runEpoch(swap, claimOf(CLAIMED, [holder(a, 50n), holder(b, 50n)])).catch((e) => e as Error);
    const id = db.listEpochs()[0]!.id;
    expect(first).toBeInstanceOf(Error); // the crash surfaced
    let e = db.getEpoch(id)!;
    expect(e.swapState).toBe("submitted"); // durable before the crash
    expect(e.teamSolanaZats).toBeNull(); // the reserve is in the swap: not resolved, not the team's to send

    await runEpoch(swap, async () => {}); // resume
    e = db.getEpoch(id)!;
    expect(swap.submits.length).toBe(1); // never a second deposit
    expect(e.swapState).toBe("settled");
    expect(e.teamSolanaZats).not.toBeNull();
    const resolved = { cost: e.deliveryCostZats, native: e.teamNativeZats, solana: e.teamSolanaZats };
    await runEpoch(swap, async () => {});
    await runEpoch(swap, async () => {});
    expect({ cost: db.getEpoch(id)!.deliveryCostZats, native: db.getEpoch(id)!.teamNativeZats, solana: db.getEpoch(id)!.teamSolanaZats }).toEqual(resolved);
  }, 300_000);

  test("while the swap is pending nothing of the team's reserve is swept; once it settles the sweep includes exactly what is the team's", async () => {
    resetShared();
    const teamWallet = Keypair.generate().publicKey;
    team.wallet = teamWallet.toBase58();
    const a = Keypair.generate();
    const b = Keypair.generate();
    db.upsertOptin(b.publicKey.toBase58(), UA_B);
    const CLAIMED = 4_000_000n; // team 1,000,000; holders 3,000,000 (A 1,500,000, B 1,500,000)
    await fundKeeper(CLAIMED);
    const pending = fakeSwap({ status: { status: "pending", note: "waiting" } });

    const id = (await runEpoch(pending, claimOf(CLAIMED, [holder(a, 50n), holder(b, 50n)]))).epoch!.id;
    expect(db.getEpoch(id)).toMatchObject({ swapState: "submitted", teamSolanaZats: null });
    expect(db.getPayouts(id).filter((p) => p.kind === "team")).toEqual([]); // nothing planned while the reserve is out
    expect(await zecOf(teamWallet)).toBe(0n);

    const reserve = BigInt(db.getEpoch(id)!.deliveryReserveZats!);
    const settled = { ...fakeSwap({}), status: async (): Promise<SwapSettlement> => ({ status: "settled", amountOutZats: 1_500_000n + reserve - 40_000n }) };
    await runEpoch(settled, async () => {}); // the deposit was made by the first run; this one only polls
    const e = db.getEpoch(id)!;
    expect(e.teamSolanaZats).toBe((1_000_000n - reserve).toString());
    const row = db.getPayouts(id).find((p) => p.kind === "team")!;
    expect(row.amountZats).toBe(e.teamSolanaZats!); // swept: only the Solana part, never the reserve that was in the swap
    expect(await zecOf(teamWallet)).toBe(BigInt(e.teamSolanaZats!));
  }, 300_000);
});

describe.if(LIVE)("the team's Solana ZEC: held by default, swept to TEAM_WALLET when one is set", () => {
  test("no TEAM_WALLET: nothing is sent, the share stays in the keeper and the ledger says so", async () => {
    resetShared();
    team.wallet = null;
    const a = Keypair.generate();
    await fundKeeper(1_000_000n);
    const before = db.teamTotals();
    const id = (await runEpoch(fakeSwap({}), claimOf(1_000_000n, [holder(a, 1n)]))).epoch!.id;
    expect(db.getPayouts(id).map((p) => p.kind)).toEqual(["solana"]); // only the holder
    expect(await zecOf(a.publicKey)).toBe(750_000n);
    const after = db.teamTotals();
    expect(after.grossZats - before.grossZats).toBe(250_000n);
    expect(after.heldInKeeperZats - before.heldInKeeperZats).toBe(250_000n);
    expect(after.sweptZats).toBe(before.sweptZats);
    expect((await getTreasuryView()).team).toMatchObject({ wallet: null, heldInKeeperZats: after.heldInKeeperZats.toString() });
  }, 120_000);

  test("TEAM_WALLET set later: the next epoch sweeps the backlog plus its own share, once", async () => {
    resetShared();
    team.wallet = null;
    const a = Keypair.generate();
    await fundKeeper(2_000_000n);
    await runEpoch(fakeSwap({}), claimOf(1_000_000n, [holder(a, 1n)])); // 250,000 held
    const held = db.teamUnplannedZats();
    expect(held).toBeGreaterThanOrEqual(250_000n);

    const teamWallet = Keypair.generate().publicKey;
    team.wallet = teamWallet.toBase58();
    const id = (await runEpoch(fakeSwap({}), claimOf(1_000_000n, [holder(a, 1n)]))).epoch!.id;
    const row = db.getPayouts(id).find((p) => p.kind === "team")!;
    expect(BigInt(row.amountZats)).toBe(held + 250_000n); // the backlog and this epoch's share
    expect(await zecOf(teamWallet)).toBe(held + 250_000n);
    expect(db.teamUnplannedZats()).toBe(0n);
    await runEpoch(fakeSwap({}), async () => {}); // nothing left to send
    expect(await zecOf(teamWallet)).toBe(held + 250_000n);
  }, 300_000);

  async function signedTeamTransfer(teamWallet: PublicKey, amount: bigint) {
    const keeper = loadKeeperKeypair();
    const ata = getAssociatedTokenAddressSync(MINT, teamWallet, false, TOKEN_PROGRAM_ID);
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, teamWallet, MINT, TOKEN_PROGRAM_ID))
      .add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(MINT, keeper.publicKey, false, TOKEN_PROGRAM_ID), MINT, ata, keeper.publicKey, amount, 8, [], TOKEN_PROGRAM_ID));
    tx.feePayer = keeper.publicKey;
    const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(keeper);
    return { sig: bs58.encode(tx.signature!), raw: tx.serialize(), lastValidBlockHeight };
  }

  function resolvedEpochWithTeamRow(teamWallet: PublicKey, amount: bigint): string {
    const id = `epoch-team-${crypto.randomUUID()}`;
    db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: amount.toString(), feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
    db.setEpochTeamSplit(id, amount, 0n);
    db.planPayout({ epochId: id, wallet: teamWallet.toBase58(), kind: "team", amountZats: amount.toString(), flag: "team" });
    return id;
  }

  test("CRASH after signing, before broadcasting: the resume sends the SAME signed bytes once; a further run sends nothing", async () => {
    resetShared();
    const teamWallet = Keypair.generate().publicKey;
    team.wallet = teamWallet.toBase58();
    await fundKeeper(300_000n);
    const id = resolvedEpochWithTeamRow(teamWallet, 300_000n);
    const { sig, raw, lastValidBlockHeight } = await signedTeamTransfer(teamWallet, 300_000n);
    db.markPayoutPending(id, teamWallet.toBase58(), "team", sig, { rawTx: Buffer.from(raw).toString("base64"), lastValidBlockHeight });
    expect(await zecOf(teamWallet)).toBe(0n); // signed and recorded, never broadcast

    await runEpoch(fakeSwap({}), async () => {});
    expect(await zecOf(teamWallet)).toBe(300_000n);
    expect(db.getPayouts(id).find((p) => p.kind === "team")).toMatchObject({ sig });
    expect(db.getPayouts(id).find((p) => p.kind === "team")!.sentAt).not.toBeNull();
    await runEpoch(fakeSwap({}), async () => {});
    expect(await zecOf(teamWallet)).toBe(300_000n); // never twice
  }, 120_000);

  test("CRASH after the broadcast landed, before it was recorded sent: the resume marks it sent and moves nothing", async () => {
    resetShared();
    const teamWallet = Keypair.generate().publicKey;
    team.wallet = teamWallet.toBase58();
    await fundKeeper(300_000n);
    const id = resolvedEpochWithTeamRow(teamWallet, 300_000n);
    const { sig, raw, lastValidBlockHeight } = await signedTeamTransfer(teamWallet, 300_000n);
    db.markPayoutPending(id, teamWallet.toBase58(), "team", sig, { rawTx: Buffer.from(raw).toString("base64"), lastValidBlockHeight });
    await getConnection().sendRawTransaction(raw);
    await getConnection().confirmTransaction(sig, "confirmed");
    expect(await zecOf(teamWallet)).toBe(300_000n);

    await runEpoch(fakeSwap({}), async () => {});
    expect(await zecOf(teamWallet)).toBe(300_000n); // not 600,000
    expect(db.getPayouts(id).find((p) => p.kind === "team")!.sentAt).not.toBeNull();
  }, 120_000);

  test("an unsent team row keeps its epoch unfinished and counts as owed from the keeper (the isolation check sees it)", async () => {
    resetShared();
    const teamWallet = Keypair.generate().publicKey;
    const id = resolvedEpochWithTeamRow(teamWallet, 123_000n);
    expect(db.epochHasUnsentPayouts(id)).toBe(true);
    const owed = db.sumOwedFromKeeper();
    db.markPayoutSent(id, teamWallet.toBase58(), "team", "carried:test");
    expect(db.epochHasUnsentPayouts(id)).toBe(false);
    expect(db.sumOwedFromKeeper()).toBe(owed); // a row closed as carried is not committed: the same amount is now owed as held team ZEC, nothing vanishes
  });
});

describe.if(LIVE)("the API shows the split and never a per-recipient number", () => {
  test("GET /api/epochs carries split; GET /api/treasury carries the policy and the team ledger", async () => {
    const epochs = ((await (await handleRequest(new Request("http://x/api/epochs"))).json()) as { epochs: { id: string; split: Record<string, string | null> }[] }).epochs;
    const withTeam = epochs.find((e) => e.split.teamZats !== "0")!;
    expect(withTeam.split).toHaveProperty("holdersZats");
    expect(withTeam.split).toHaveProperty("deliveryCostZats");
    expect(withTeam.split).toHaveProperty("teamNetZats");
    const t = (await (await handleRequest(new Request("http://x/api/treasury"))).json()) as { policy: Record<string, number>; team: Record<string, string | null> };
    expect(t.policy).toEqual({ holdersShareOfClaimedBps: 7500, teamShareOfClaimedBps: 2500, meteoraShareOfFeeBps: 2000 });
    expect(Object.keys(t.team).sort()).toEqual(["deliveryCostZats", "grossZats", "heldInKeeperZats", "nativeZats", "sweptZats", "wallet"]);
  });
});
