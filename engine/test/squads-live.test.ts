// The Squads v4 vault as DBC fee_claimer (custody Option B, F-037) on the local
// validator running the MAINNET DBC, DAMM v2 and Squads binaries. Proves what
// F-037 proved on devnet, through the engine's own claimer: the keeper alone
// cannot claim, a claim waits for the owner and shows who is paid, the approved
// message cannot be redirected, a rejected or foreign-executed proposal is
// handled, and the post-migration DAMM v2 position fee comes out of the vault.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import * as sqds from "@sqds/multisig";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { createDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { buildTradeTx } from "../src/dbc/trade";
import { ClaimPending, dammPositionFeeBuilder, runClaim, tradingFeeBuilder } from "../src/dbc/claim";
import { readCurveStage, reconcileMigration } from "../src/dbc/migrate";
import {
  SquadsVaultFeeClaimer, approveProposal, decodeClaimReceivers, describeProposal, listActiveProposals, resolveInstructions, resolveReceivers,
} from "../src/dbc/squads";
import * as db from "../src/db";
import { createLocalMultisig, makeProposalsStale, rejectProposal, type LocalMultisig } from "./helpers/squads-local";
import { waitForCoinWindow } from "../src/dbc/windowWait";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal && !!(await getConnection().getAccountInfo(sqds.PROGRAM_ID));
  } catch {
    return false;
  }
}

const QUOTE = config.solana.dbc.quoteMint;
const keeper = loadKeeperKeypair();
const keeperAta = getAssociatedTokenAddressSync(QUOTE, keeper.publicKey, false, TOKEN_PROGRAM_ID);
const keeperZec = async () => (await getAccount(getConnection(), keeperAta, "confirmed", TOKEN_PROGRAM_ID).catch(() => ({ amount: 0n }))).amount;
const accrued = async (poolId: string) => BigInt((await getDbcClient().state.getPoolFeeMetrics(poolId)).current.partnerQuoteFee.toString());
const epochId = () => `epoch-squads-${crypto.randomUUID()}`;

async function send(txBase64: string, signer: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await getConnection().sendRawTransaction(tx.serialize());
  await getConnection().confirmTransaction(sig, "confirmed");
  return sig;
}

describe.if(await validatorUp())("Squads vault as fee claimer (live validator)", () => {
  let ms: LocalMultisig;
  let configId: string;
  let claimer: SquadsVaultFeeClaimer;

  beforeAll(async () => {
    ms = await createLocalMultisig(keeper);
    configId = (await createDbcConfig(ms.vault)).configId; // verifies every field, incl. fee claimer = the vault
    claimer = await SquadsVaultFeeClaimer.create({ multisigPda: ms.multisigPda, keeper });
  }, 60_000);

  afterAll(() => {
    // The vault config must not stay the "newest" config for the test files that run after this one.
    db.getDb().query("DELETE FROM dbc_configs WHERE configId = $id").run({ $id: configId });
  });

  async function launchVaultCoin(): Promise<{ coin: db.CoinRow; creator: Keypair }> {
    const creator = Keypair.generate();
    await fundTestWallet(creator.publicKey, 2, keeper);
    const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Vault", symbol: "VLT", description: "", imageUrl: "", initialBuyZats: "20000000" });
    await confirmLaunch(await send(txBase64, creator), mint);
    await waitForCoinWindow(mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
    const coin = db.getCoin(mint)!;
    expect(coin.configId).toBe(configId);
    return { coin, creator };
  }

  /** The keeper-paid account creations a claim needs first (a real claim sends these before proposing). */
  const sendSetup = (setupIxs: Transaction["instructions"]) =>
    setupIxs.length ? sendAndConfirmTransaction(getConnection(), new Transaction().add(...setupIxs), [keeper], { commitment: "confirmed" }) : Promise.resolve("");

  const claim = (epoch: string, coin: db.CoinRow) => runClaim(epoch, coin.mint, "trading", tradingFeeBuilder(coin, claimer), claimer);

  test("the multisig: keeper has Initiate+Vote+Execute, threshold 2, the vault is off-curve and holds no SOL", async () => {
    const m = await sqds.accounts.Multisig.fromAccountAddress(getConnection(), ms.multisigPda);
    expect(m.threshold).toBe(2);
    expect(m.members.find((x) => x.key.equals(keeper.publicKey))?.permissions.mask).toBe(7);
    expect(PublicKey.isOnCurve(ms.vault.toBytes())).toBe(false);
    expect(await getConnection().getBalance(ms.vault)).toBe(0);
    expect(JSON.parse(db.getMeta("squads_members")!)).toContain(ms.owner.publicKey.toBase58()); // members are kept out of the holder snapshot
  });

  test("the claim decodes to the keeper's own token accounts for both programs' claim instructions", async () => {
    const { coin } = await launchVaultCoin();
    const { setupIxs, claimIxs } = await tradingFeeBuilder(coin, claimer)();
    await sendSetup(setupIxs);
    const { receivers, unknown } = decodeClaimReceivers(resolveInstructions(claimIxs));
    expect(unknown).toEqual([]);
    const resolved = await resolveReceivers(getConnection(), receivers);
    expect(resolved.length).toBe(2); // base and quote account
    expect(resolved.every((r) => r.owner === keeper.publicKey.toBase58())).toBe(true);
    expect(resolved.some((r) => r.tokenAccount === keeperAta.toBase58())).toBe(true);
  }, 60_000);

  test("a claim waits for the owner: the keeper alone cannot claim, the proposal shows the receiver, the approved message cannot be redirected, then the keeper executes", async () => {
    const { coin } = await launchVaultCoin();
    const expected = await accrued(coin.poolId!);
    const epoch = epochId();
    const lamportsBefore = await getConnection().getBalance(keeper.publicKey);

    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending); // proposed + keeper vote, waiting for a second approval
    const row = db.getClaimProgress(epoch, coin.mint, "trading")!;
    expect(row.phase).toBe("await");
    const index = BigInt(JSON.parse(row.ref!).txIndex);
    const before = await describeProposal(getConnection(), ms.multisigPda, index);
    expect(before.status).toBe("Active");
    expect(before.approvals).toEqual([keeper.publicKey.toBase58()]);
    expect(before.text).toContain(keeper.publicKey.toBase58()); // the owner reads the receiver here before approving
    expect(before.receivers.every((r) => r.owner === keeper.publicKey.toBase58())).toBe(true);
    expect((await listActiveProposals(getConnection(), ms.multisigPda)).map((p) => p.index)).toContain(index);

    const zecBefore = await keeperZec();
    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending); // still one approval of two
    expect(await accrued(coin.poolId!)).toBe(expected); // nothing moved
    expect(await keeperZec()).toBe(zecBefore);
    const executeAlone = await sqds.instructions.vaultTransactionExecute({ connection: getConnection(), multisigPda: ms.multisigPda, transactionIndex: index, member: keeper.publicKey });
    await expect(sendAndConfirmTransaction(getConnection(), new Transaction().add(executeAlone.instruction), [keeper], { commitment: "confirmed" })).rejects.toThrow(); // InvalidProposalStatus

    await approveProposal(getConnection(), ms.multisigPda, index, ms.owner); // the owner's phone

    // An execute with the receiver swapped for an attacker's account is refused by the program (F-037 4b).
    const attacker = getAssociatedTokenAddressSync(QUOTE, Keypair.generate().publicKey, false, TOKEN_PROGRAM_ID);
    const swapped = await sqds.instructions.vaultTransactionExecute({ connection: getConnection(), multisigPda: ms.multisigPda, transactionIndex: index, member: keeper.publicKey });
    swapped.instruction.keys = swapped.instruction.keys.map((k) => (k.pubkey.equals(keeperAta) ? { ...k, pubkey: attacker } : k));
    await expect(sendAndConfirmTransaction(getConnection(), new Transaction().add(swapped.instruction), [keeper], { commitment: "confirmed" })).rejects.toThrow();
    expect(await accrued(coin.poolId!)).toBe(expected);

    expect(await claim(epoch, coin)).toBe(expected); // the keeper executes; the amount is the keeper account's change inside that tx
    expect((await keeperZec()) - zecBefore).toBe(expected);
    expect(await getConnection().getBalance(ms.vault)).toBe(0); // the vault never needed SOL
    // The keeper fronted ~8.4M lamports of proposal rent at local rent (F-037: 6.16M at devnet's) and got it
    // back when the finished proposal was closed: what is left is the new base-token account (2,074,080) and fees.
    const spent = lamportsBefore - (await getConnection().getBalance(keeper.publicKey));
    expect(spent).toBeGreaterThan(2_074_080 - 1);
    expect(spent).toBeLessThan(2_074_080 + 100_000);
    expect((await getConnection().getAccountInfo(sqds.getTransactionPda({ multisigPda: ms.multisigPda, index })[0]))).toBeNull(); // the vault transaction account is closed
    expect(await getConnection().getAccountInfo(sqds.getProposalPda({ multisigPda: ms.multisigPda, transactionIndex: index })[0])).toBeNull(); // and so is the proposal (it was Executed)
    expect(db.getClaimProgress(epoch, coin.mint, "trading")).toMatchObject({ status: "confirmed", amountZats: expected.toString() });
    expect(await claim(epoch, coin)).toBe(expected); // replaying a finished claim sends nothing
    expect(await keeperZec()).toBe(zecBefore + expected);
  }, 120_000);

  test("with the second member's key as co-signer (the test network): a claim completes with no owner action, and the co-signer refuses a message that is not a claim paying the keeper", async () => {
    const auto = await SquadsVaultFeeClaimer.create({ multisigPda: ms.multisigPda, keeper, coSigner: ms.owner });
    await expect(SquadsVaultFeeClaimer.create({ multisigPda: ms.multisigPda, keeper, coSigner: Keypair.generate() })).rejects.toThrow(/not a member/);
    await expect(SquadsVaultFeeClaimer.create({ multisigPda: ms.multisigPda, keeper, coSigner: keeper })).rejects.toThrow(/the keeper itself/);
    const { coin } = await launchVaultCoin();
    const expected = await accrued(coin.poolId!);
    const epoch = epochId();
    const zecBefore = await keeperZec();
    const autoClaim = () => runClaim(epoch, coin.mint, "trading", tradingFeeBuilder(coin, auto), auto);
    expect(await autoClaim()).toBe(expected); // propose, keeper vote, co-sign after the decode, execute: one call, nobody asked
    expect((await keeperZec()) - zecBefore).toBe(expected);
    const executed = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "trading")!.ref!).txIndex);
    expect(await getConnection().getAccountInfo(sqds.getProposalPda({ multisigPda: ms.multisigPda, transactionIndex: executed })[0])).toBeNull(); // executed and closed

    // a vault transaction that is NOT a claim (a SOL transfer out of the vault), filed under a claim row: the co-signer must leave it at the keeper's vote alone
    const msAcct = await sqds.accounts.Multisig.fromAccountAddress(getConnection(), ms.multisigPda);
    const index = BigInt(msAcct.transactionIndex.toString()) + 1n;
    const drain = new TransactionMessage({
      payerKey: ms.vault, recentBlockhash: (await getConnection().getLatestBlockhash("confirmed")).blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: ms.vault, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    });
    await sendAndConfirmTransaction(getConnection(), new Transaction().add(
      sqds.instructions.vaultTransactionCreate({ multisigPda: ms.multisigPda, transactionIndex: index, creator: keeper.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: drain, memo: "not a claim" }),
      sqds.instructions.proposalCreate({ multisigPda: ms.multisigPda, transactionIndex: index, creator: keeper.publicKey }),
    ), [keeper], { commitment: "confirmed" });
    const foreign = epochId();
    db.getDb().query("INSERT INTO claim_progress (epochId,mint,kind,sig,rawTx,lastValidBlockHeight,status,amountZats,at,phase,ref) VALUES ($e,$m,'trading',$s,'',0,'signed',NULL,$at,'await',$r)")
      .run({ $e: foreign, $m: coin.mint, $s: "1".repeat(64), $at: new Date().toISOString(), $r: JSON.stringify({ txIndex: index.toString(), fingerprint: "0".repeat(64) }) });
    await expect(runClaim(foreign, coin.mint, "trading", tradingFeeBuilder(coin, auto), auto)).rejects.toBeInstanceOf(ClaimPending);
    const after = await describeProposal(getConnection(), ms.multisigPda, index);
    expect(after.status).toBe("Active");
    expect(after.approvals).toEqual([keeper.publicKey.toBase58()]); // the keeper's own vote, never the co-signer's
    expect(after.unknownInstructions.length).toBeGreaterThan(0);
  }, 180_000);

  test("an approved proposal whose message is not the one the keeper wrote is never executed", async () => {
    const { coin } = await launchVaultCoin();
    const epoch = epochId();
    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending);
    const row = db.getClaimProgress(epoch, coin.mint, "trading")!;
    await approveProposal(getConnection(), ms.multisigPda, BigInt(JSON.parse(row.ref!).txIndex), ms.owner);
    const tampered = { ...JSON.parse(row.ref!), fingerprint: "0".repeat(64) }; // what the keeper remembers differs from what is stored
    db.getDb().query("UPDATE claim_progress SET ref = $r WHERE epochId = $e AND mint = $m").run({ $r: JSON.stringify(tampered), $e: epoch, $m: coin.mint });
    const zecBefore = await keeperZec();
    await expect(claim(epoch, coin)).rejects.toThrow(/refusing to execute/);
    expect(await keeperZec()).toBe(zecBefore);
  }, 120_000);

  test("a rejected proposal is forgotten and re-proposed; the fee is claimed exactly once", async () => {
    const { coin } = await launchVaultCoin();
    const expected = await accrued(coin.poolId!);
    const epoch = epochId();
    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending);
    const first = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "trading")!.ref!).txIndex);
    await rejectProposal(ms.multisigPda, first, [ms.owner, ms.backup]);
    await expect(claim(epoch, coin)).rejects.toThrow(/was rejected/); // cleared; no ZEC moved
    expect(db.getClaimProgress(epoch, coin.mint, "trading")).toBeNull();
    expect(await accrued(coin.poolId!)).toBe(expected);

    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending); // a new proposal
    const second = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "trading")!.ref!).txIndex);
    expect(second).toBeGreaterThan(first);
    await approveProposal(getConnection(), ms.multisigPda, second, ms.owner);
    expect(await claim(epoch, coin)).toBe(expected);
  }, 120_000);

  test("a member change makes a pending proposal stale: it is forgotten, a new one is made, and the fee is claimed once", async () => {
    const { coin } = await launchVaultCoin();
    const expected = await accrued(coin.poolId!);
    const epoch = epochId();
    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending);
    const first = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "trading")!.ref!).txIndex);
    await approveProposal(getConnection(), ms.multisigPda, first, ms.owner); // approved, but the multisig changes before it executes
    await makeProposalsStale(ms);
    await expect(claim(epoch, coin)).rejects.toThrow(/went stale/);
    expect(db.getClaimProgress(epoch, coin.mint, "trading")).toBeNull();
    expect(await accrued(coin.poolId!)).toBe(expected); // nothing moved

    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending);
    const second = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "trading")!.ref!).txIndex);
    expect(second).toBeGreaterThan(first);
    await approveProposal(getConnection(), ms.multisigPda, second, ms.owner);
    expect(await claim(epoch, coin)).toBe(expected);
  }, 120_000);

  test("if another member executes the approved proposal, the keeper finds that transaction and measures its own ZEC change", async () => {
    const { coin } = await launchVaultCoin();
    const expected = await accrued(coin.poolId!);
    const epoch = epochId();
    await expect(claim(epoch, coin)).rejects.toBeInstanceOf(ClaimPending);
    const index = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "trading")!.ref!).txIndex);
    await approveProposal(getConnection(), ms.multisigPda, index, ms.owner);
    const exec = await sqds.instructions.vaultTransactionExecute({ connection: getConnection(), multisigPda: ms.multisigPda, transactionIndex: index, member: ms.owner.publicKey });
    await sendAndConfirmTransaction(getConnection(), new Transaction().add(exec.instruction), [ms.owner], { commitment: "confirmed" });
    expect(await claim(epoch, coin)).toBe(expected);
  }, 120_000);

  test("after migration the DAMM v2 position fee comes out of the vault the same way, and the claim decodes to the keeper account", async () => {
    const { coin, creator } = await launchVaultCoin();
    await fundTestWallet(creator.publicKey, 1, keeper);
    await fundTestWallet(creator.publicKey, 1, keeper);
    const pool = new PublicKey(coin.poolId!);
    for (let i = 0; i < 6 && (await readCurveStage(coin.poolId!)) === "open"; i++) {
      const tx = await getDbcClient().pool.swap2({ owner: creator.publicKey, pool, swapMode: SwapMode.PartialFill, amountIn: new BN(400_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null });
      await sendAndConfirmTransaction(getConnection(), tx, [creator], { commitment: "confirmed" });
    }
    const migrated = await reconcileMigration(coin, claimer.publicKey);
    expect(migrated.dammPool && migrated.positionNft).toBeTruthy(); // the position NFT is owned by the vault
    const { txBase64 } = await buildTradeTx({ wallet: creator.publicKey.toBase58(), mint: coin.mint, side: "buy", amount: "50000000", slippageBps: 100 });
    await send(txBase64, creator);

    const parts = await dammPositionFeeBuilder(migrated, claimer)();
    await sendSetup(parts.setupIxs);
    const decoded = decodeClaimReceivers(resolveInstructions(parts.claimIxs));
    expect(decoded.unknown).toEqual([]);
    expect((await resolveReceivers(getConnection(), decoded.receivers)).every((r) => r.owner === keeper.publicKey.toBase58())).toBe(true);

    const epoch = epochId();
    const run = () => runClaim(epoch, coin.mint, "damm_position", dammPositionFeeBuilder(migrated, claimer), claimer);
    await expect(run()).rejects.toBeInstanceOf(ClaimPending);
    const index = BigInt(JSON.parse(db.getClaimProgress(epoch, coin.mint, "damm_position")!.ref!).txIndex);
    await approveProposal(getConnection(), ms.multisigPda, index, ms.owner);
    const amount = await run();
    expect(amount).toBeGreaterThanOrEqual(399_998n);
    expect(amount).toBeLessThanOrEqual(400_000n);
  }, 240_000);
});

// audit/CONFIG-REVIEW.md S1-M2: with threshold 2 and a keeper that holds Vote, keeper + owner can pass a
// CONFIG change (members, threshold, spending limits) without the offline backup. The owner's list must show it.
describe.if(await validatorUp())("Squads config changes need only keeper + owner (live validator)", () => {
  test("a keeper-made 'add member' proposal is listed as a CONFIG CHANGE, and keeper + owner alone can execute it", async () => {
    const ms = await createLocalMultisig(keeper);
    const conn = getConnection();
    const stranger = Keypair.generate().publicKey;
    const transactionIndex = 1n;
    const sendBy = (ixs: Transaction["instructions"], signer: Keypair) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
    await sendBy([
      sqds.instructions.configTransactionCreate({ multisigPda: ms.multisigPda, transactionIndex, creator: keeper.publicKey, actions: [{ __kind: "AddMember", newMember: { key: stranger, permissions: sqds.types.Permissions.all() } }] }),
      sqds.instructions.proposalCreate({ multisigPda: ms.multisigPda, transactionIndex, creator: keeper.publicKey }),
    ], keeper);

    const listed = await listActiveProposals(conn, ms.multisigPda);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.text).toContain("CONFIG CHANGE");
    expect(listed[0]!.text).toContain(stranger.toBase58());
    expect(listed[0]!.unknownInstructions.length).toBeGreaterThan(0); // never mistaken for a claim

    await approveProposal(conn, ms.multisigPda, transactionIndex, keeper);
    await approveProposal(conn, ms.multisigPda, transactionIndex, ms.owner); // the backup never signs
    await sendBy([sqds.instructions.configTransactionExecute({ multisigPda: ms.multisigPda, transactionIndex, member: keeper.publicKey, rentPayer: keeper.publicKey })], keeper);
    const after = await sqds.accounts.Multisig.fromAccountAddress(conn, ms.multisigPda);
    expect(after.members.some((m) => m.key.equals(stranger))).toBe(true);
  });
});
