#!/usr/bin/env bun
// Full local flow on the MAINNET Meteora binaries: up -> seed -> epoch 1 (curve
// fees) -> fill the curve -> epoch 2 (the keeper migrates the coin to DAMM v2
// and claims) -> a trade on the DAMM v2 pool -> epoch 3 (post-migration claim)
// -> epoch 4: a second coin whose DBC config names a SQUADS VAULT as fee
// claimer (the keeper proposes, the run stops and waits, the "owner" approves
// after reading the decoded receiver, the next run executes and pays)
// -> epoch 5: a coin on the 4% creator-fee tier launched through the API builder: the pad claims only the partner part and splits it
// 75/25 as at every tier, and the creator claims their own share by their own signature.
// Last, the API (a real server process) answers every contract v2.6 route (quote, pot, what is fixed, holders, trades and the live stream,
// rewards and the memo check, epochs.csv) and each answer is checked against the chain and the database (scripts/e2e-trader.ts).
// Every epoch asserts money moved exactly as planned on both chains, and that
// what was claimed equals what the pool said it had accrued. Writes
// engine/E2E-RESULT.txt (what ran, what passed, with numbers).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAccount,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import * as db from "../src/db";
import { payoutRail } from "../src/api";
import { getTreasuryView } from "../src/ledger";
import { fundTestWallet } from "../src/faucet";
import { readCoinView } from "../src/dbc/read";
import { buildTradeTx } from "../src/dbc/trade";
import { readCurveStage } from "../src/dbc/migrate";
import { createDbcConfig } from "../src/dbc/setup";
import { buildCreatorClaimTx } from "../src/dbc/creatorClaim";
import { tradeSplit } from "../src/dbc/tiers";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { SquadsVaultFeeClaimer, approveProposal, describeProposal, listActiveProposals } from "../src/dbc/squads";
import { createLocalMultisig } from "../test/helpers/squads-local";
import { enhanceWallet, getBalance, receivedMemos, receivedPools, rewardMemo, syncWallet } from "../src/zcash/devtool";
import { snapshotMemoText, snapshotSha256 } from "../src/epoch/snapshotFile";
import { arithmeticProblems, type Snapshot as VerifiedSnapshot } from "./verify-snapshot";
import { txPoolActions } from "../src/zcash/regtest";
import { traderApiChecks } from "./e2e-trader";

interface SeedWallets {
  mint: string;
  creator: string;
  defaultBuyers: string[];
  optinBuyers: { secretKey: string; walletDir: string }[];
  noAccountWallet: string;
}

interface CheckResult {
  label: string;
  pass: boolean;
  detail: string;
}

const QUOTE = config.solana.dbc.quoteMint;
const keyOf = (sk: string) => Keypair.fromSecretKey(bs58.decode(sk));

function runStep(script: string, env: Record<string, string> = {}, args: string[] = []): string {
  console.log(`\n=== ${script} ${args.join(" ")} ===`);
  const proc = Bun.spawnSync(["bun", "run", script, ...args], { cwd: config.paths.engineRoot, stdout: "pipe", stderr: "inherit", env: { ...process.env, ...env } });
  const out = proc.stdout.toString();
  process.stdout.write(out);
  if (proc.exitCode !== 0) throw new Error(`${script} exited with code ${proc.exitCode}`);
  return out;
}

async function solanaZecBalance(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(QUOTE, owner, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n; // ATA not created yet
  }
}

interface Balances {
  solana: Map<string, bigint>;
  shielded: Map<string, bigint>;
}

async function snapshotBalances(seed: SeedWallets, extraSolana: Keypair[]): Promise<Balances> {
  const solana = new Map<string, bigint>();
  for (const kp of [keyOf(seed.creator), ...seed.defaultBuyers.map(keyOf), keyOf(seed.noAccountWallet), ...extraSolana]) {
    solana.set(kp.publicKey.toBase58(), await solanaZecBalance(kp.publicKey));
  }
  const shielded = new Map<string, bigint>();
  for (const o of seed.optinBuyers) {
    syncWallet(o.walletDir);
    shielded.set(keyOf(o.secretKey).publicKey.toBase58(), getBalance(o.walletDir).totalZats);
  }
  return { solana, shielded };
}

function knownWallets(seed: SeedWallets, extra: Keypair[]): Set<string> {
  return new Set([seed.creator, ...seed.defaultBuyers, seed.noAccountWallet, ...seed.optinBuyers.map((o) => o.secretKey), ...extra.map((k) => bs58.encode(k.secretKey))].map((sk) => keyOf(sk).publicKey.toBase58()));
}

/** Money that actually moved on `rail` for a payout row must show up as exactly that balance change. */
function checkPayoutDeltas(rail: "solana" | "shielded", pre: Map<string, bigint>, post: Map<string, bigint>, epochId: string): CheckResult[] {
  return db.getPayouts(epochId).filter((p) => payoutRail(p) === rail).map((p) => {
    const delta = (post.get(p.wallet) ?? 0n) - (pre.get(p.wallet) ?? 0n);
    return {
      label: `epoch ${epochId.slice(-5)}: ${rail} payout to ${p.wallet.slice(0, 8)}…`,
      pass: delta === BigInt(p.amountZats),
      detail: `expected +${p.amountZats} zats, observed +${delta} zats (sig/txid ${p.sig})`,
    };
  });
}

/** Shielded payouts must land in the Ironwood pool (mainnet accepts no new Orchard outputs since NU6.3). */
async function checkIronwoodPayouts(seed: SeedWallets, epochId: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const payouts = db.getPayouts(epochId).filter((p) => payoutRail(p) === "shielded");
  for (const txid of new Set(payouts.map((p) => p.sig!))) {
    const actions = await txPoolActions(txid);
    results.push({
      label: `shielded batch ${txid.slice(0, 10)}… is an Ironwood tx (no Orchard actions)`,
      pass: actions.ironwood > 0 && actions.orchard === 0,
      detail: `ironwood actions=${actions.ironwood} orchard actions=${actions.orchard}`,
    });
  }
  for (const o of seed.optinBuyers) {
    const payout = payouts.find((p) => p.wallet === keyOf(o.secretKey).publicKey.toBase58());
    if (!payout?.sig) continue;
    const pools = receivedPools(o.walletDir, payout.sig);
    results.push({
      label: `${payout.wallet.slice(0, 8)}… own wallet received its payout as an Ironwood note`,
      pass: pools.length > 0 && pools.every((x) => x === "Ironwood"),
      detail: `received output pools: ${pools.join(",") || "none"}`,
    });
  }
  return results;
}

async function unclaimedPartnerQuoteFee(poolId: string): Promise<bigint> {
  return BigInt((await getDbcClient().state.getPoolFeeMetrics(poolId)).current.partnerQuoteFee.toString());
}

async function fundedTrader(): Promise<Keypair> {
  const conn = getConnection();
  const keeper = loadKeeperKeypair();
  const kp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5e9), "confirmed");
  const ata = (await getOrCreateAssociatedTokenAccount(conn, keeper, QUOTE, kp.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(conn, keeper, QUOTE, ata, keeper, 1_000_000_000n); // 10 ZEC, enough to fill the 6.67 ZEC curve
  return kp;
}

/** Buys with partial fills until the curve is full (the last buy takes only what fits). */
async function fillCurve(poolId: string, whale: Keypair): Promise<number> {
  const conn = getConnection();
  let buys = 0;
  while ((await readCurveStage(poolId)) === "open" && buys < 8) {
    const tx = await getDbcClient().pool.swap2({
      owner: whale.publicKey, pool: new PublicKey(poolId), swapMode: SwapMode.PartialFill, amountIn: new BN(400_000_000),
      minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null,
    });
    await sendAndConfirmTransaction(conn, tx, [whale], { commitment: "confirmed" });
    buys++;
  }
  return buys;
}

async function buyThroughApiBuilder(whale: Keypair, mint: string, zats: bigint): Promise<string> {
  const conn = getConnection();
  const { txBase64 } = await buildTradeTx({ wallet: whale.publicKey.toBase58(), mint, side: "buy", amount: zats.toString(), slippageBps: 100 });
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([whale]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

function newestEpoch(): db.EpochRow {
  const epoch = db.listEpochs()[0];
  if (!epoch) throw new Error("no epoch record found after running scripts/epoch.ts");
  return epoch;
}

function epochChecks(label: string, epoch: db.EpochRow, known: Set<string>): CheckResult[] {
  const rows = db.getPayouts(epoch.id);
  const strangers = rows.filter((p) => !known.has(p.wallet));
  return [
    { label: `${label}: status ok (no fallback needed)`, pass: epoch.status === "ok", detail: `status=${epoch.status}` },
    { label: `${label}: every payout went to a wallet this run created (no pool vault or program account was paid)`, pass: strangers.length === 0, detail: `unknown recipients=${strangers.map((p) => p.wallet).join(",") || "none"}` },
  ];
}

/**
 * Owner policy 2026-10-02: the team keeps 25% of each claim, holders split the rest to the zat; when the epoch ran a
 * shielded leg the team's reserve covered the delivery (nothing taken from the shielded holders) and the ledger closed.
 */
function splitChecks(label: string, e: db.EpochRow): CheckResult[] {
  const harvests = db.listEpochCoinHarvests(e.id);
  const claimed = harvests.reduce((a, h) => a + BigInt(h.soldForZatsQuote), 0n);
  const team = harvests.reduce((a, h) => a + BigInt(h.teamZats), 0n);
  const shares = db.listEpochCoinShares(e.id).reduce((a, r) => a + BigInt(r.amountZats), 0n);
  const shielded = db.getPayouts(e.id).some((p) => payoutRail(p) === "shielded");
  const fresh = db.getEpoch(e.id)!;
  const out: CheckResult[] = [
    { label: `${label}: the team kept exactly 25% of the claim (rounded down) and holders' shares + team == claimed to the zat`, pass: claimed > 0n && team === (claimed * 2500n) / 10_000n && shares + team === claimed, detail: `claimed=${claimed} team=${team} holders' shares=${shares}` },
    { label: `${label}: the team ledger closed (delivery resolved)`, pass: fresh.teamSolanaZats != null && BigInt(fresh.teamGrossZats ?? "0") === team, detail: `teamGross=${fresh.teamGrossZats} teamSolana=${fresh.teamSolanaZats} cost=${fresh.deliveryCostZats} native=${fresh.teamNativeZats}` },
  ];
  if (shielded) {
    out.push({ label: `${label}: the shielded leg's delivery cost (swap fee, spread, Zcash fee) was paid from the team's reserve, nothing taken from the shielded holders`, pass: fresh.holderShortfallZats === "0" && BigInt(fresh.deliveryCostZats ?? "0") >= config.epoch.team.withdrawFeeZats && BigInt(fresh.deliveryCostZats ?? "0") <= BigInt(fresh.deliveryReserveZats ?? "0"), detail: `reserve=${fresh.deliveryReserveZats} cost=${fresh.deliveryCostZats} native left for the team=${fresh.teamNativeZats} shortfall=${fresh.holderShortfallZats}` });
  }
  return out;
}

/** Each opted-in holder's own wallet shows the receipt memo on the note it received. */
function memoChecks(seed: SeedWallets, e: db.EpochRow): CheckResult[] {
  const rows = db.getPayouts(e.id).filter((p) => payoutRail(p) === "shielded");
  const out: CheckResult[] = [];
  for (const o of seed.optinBuyers) {
    const row = rows.find((p) => p.wallet === keyOf(o.secretKey).publicKey.toBase58());
    if (!row?.sig) continue;
    syncWallet(o.walletDir);
    enhanceWallet(o.walletDir); // a light wallet reads a memo from the full transaction
    const memos = receivedMemos(o.walletDir, row.sig);
    out.push({ label: `epoch ${e.id.slice(-5)}: ${row.wallet.slice(0, 8)}… sees "${rewardMemo(e.id)}" on its shielded note`, pass: memos.includes(rewardMemo(e.id)), detail: `memos seen=${JSON.stringify(memos)}` });
  }
  return out;
}

/** The snapshot's sha256 is in a Solana memo the keeper signed, the file served matches it, and its arithmetic holds. */
async function snapshotChecks(label: string, e: db.EpochRow): Promise<CheckResult[]> {
  const snap = db.getEpochSnapshot(e.id);
  if (!snap) return [{ label: `${label}: the epoch has a published snapshot`, pass: false, detail: "no snapshot row" }];
  const tx = snap.memoSig ? await getConnection().getParsedTransaction(snap.memoSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }) : null;
  const memoIx = tx?.transaction.message.instructions.find((i) => "program" in i && i.program === "spl-memo") as { parsed?: unknown } | undefined;
  const parsed = JSON.parse(snap.json) as VerifiedSnapshot;
  return [
    { label: `${label}: the snapshot's sha256 is written in a Solana memo the keeper signed`, pass: snap.sha256 === snapshotSha256(snap.json) && memoIx?.parsed === snapshotMemoText(e.id, snap.sha256) && tx?.transaction.message.accountKeys[0]?.pubkey.toBase58() === loadKeeperKeypair().publicKey.toBase58(), detail: `memo tx=${snap.memoSig} sha256=${snap.sha256.slice(0, 16)}…` },
    { label: `${label}: the snapshot's arithmetic checks out and no shielded wallet or amount is in the file`, pass: arithmeticProblems(parsed).length === 0 && !db.listActiveOptins().some((o) => snap.json.includes(o.wallet)), detail: `${parsed.coins.length} coin(s), problems=${arithmeticProblems(parsed).join(" | ") || "none"}` },
  ];
}

async function main(): Promise<void> {
  const lines: string[] = [`snarks-engine e2e run, ${new Date().toISOString()}`, `PAD_MODE=${config.mode}`, ""];
  const checks: CheckResult[] = [];

  // A clean chain every run: local-up starts a fresh validator (and resets the DB that pointed at the old one) when none is up.
  Bun.spawnSync(["pkill", "-f", "solana-test-validator"]);
  await Bun.sleep(3000);
  runStep("scripts/local-up.ts");
  runStep("scripts/seed.ts");
  const seed: SeedWallets = JSON.parse(readFileSync(join(config.paths.dataDir, "seed-wallets.json"), "utf8"));
  const coin = db.getCoin(seed.mint)!;
  const creator = keyOf(seed.creator).publicKey.toBase58();
  const small = keyOf(seed.optinBuyers[3]!.secretKey).publicKey.toBase58();
  const noAccount = keyOf(seed.noAccountWallet).publicKey;
  const whale = await fundedTrader();
  const known = knownWallets(seed, [whale]);

  // ---- epoch 1: fees accrued on the DBC curve ----
  const expected1 = await unclaimedPartnerQuoteFee(coin.poolId!);
  const pre1 = await snapshotBalances(seed, [whale]);
  runStep("scripts/epoch.ts");
  const post1 = await snapshotBalances(seed, [whale]);
  const e1 = newestEpoch();
  checks.push(...checkPayoutDeltas("solana", pre1.solana, post1.solana, e1.id), ...checkPayoutDeltas("shielded", pre1.shielded, post1.shielded, e1.id));
  checks.push(...(await checkIronwoodPayouts(seed, e1.id)), ...epochChecks("epoch 1", e1, known));
  checks.push(...splitChecks("epoch 1", e1), ...memoChecks(seed, e1), ...(await snapshotChecks("epoch 1", e1)));
  const rows1 = db.getPayouts(e1.id);
  const treasury = await getTreasuryView();
  checks.push({ label: "epoch 1: claimed ZEC equals the fee the pool had accrued for the partner", pass: BigInt(e1.harvestedZats) === expected1 && expected1 > 0n, detail: `claimed=${e1.harvestedZats} pool partnerQuoteFee=${expected1}` });
  checks.push({ label: "epoch 1: creator is paid like any holder and flagged", pass: rows1.some((p) => p.wallet === creator && payoutRail(p) === "solana" && p.flag === "creator"), detail: `creator row=${JSON.stringify(rows1.find((p) => p.wallet === creator))}` });
  checks.push({ label: "epoch 1: creator + 2 default holders paid Solana ZEC", pass: rows1.filter((p) => payoutRail(p) === "solana").length === 3, detail: `count=${rows1.filter((p) => payoutRail(p) === "solana").length}` });
  checks.push({ label: "epoch 1: 3 opted-in holders paid shielded", pass: rows1.filter((p) => payoutRail(p) === "shielded").length === 3, detail: `count=${rows1.filter((p) => payoutRail(p) === "shielded").length}` });
  const noAcctRow = rows1.find((p) => p.wallet === noAccount.toBase58());
  checks.push({
    label: "epoch 1: a wallet with no ZEC account and a share under the account rent is carried, and no account is created for it",
    pass: noAcctRow?.sig === "carried:new_account_below_rent" && db.getCarry(noAccount.toBase58(), "solana") === BigInt(noAcctRow.amountZats) && (await solanaZecBalance(noAccount)) === 0n,
    detail: `row=${noAcctRow?.sig} carry=${db.getCarry(noAccount.toBase58(), "solana")} balance=${await solanaZecBalance(noAccount)}`,
  });
  const smallCarry = db.getCarry(small, "shielded");
  checks.push({
    label: "epoch 1: a shielded share under 100,000 zats is held, not sent",
    pass: smallCarry >= config.epoch.dustFloorZats && smallCarry < config.epoch.shieldedMinPerHolderZats && !rows1.some((p) => p.wallet === small),
    detail: `carry=${smallCarry}`,
  });
  checks.push({ label: "epoch 1: treasury covers owed", pass: treasury.covered, detail: `treasuryZats=${treasury.treasuryZats} owedZats=${treasury.owedZats}` });
  checks.push({ label: "epoch 1: records the shielded batch's real network fee (> 0)", pass: BigInt(e1.feeZats) > 0n, detail: `feeZats=${e1.feeZats}` });

  // ---- fill the curve, then epoch 2: the keeper migrates and claims ----
  const buys = await fillCurve(coin.poolId!, whale);
  checks.push({ label: "curve filled by partial-fill buys", pass: (await readCurveStage(coin.poolId!)) === "complete", detail: `buys=${buys}` });
  const expected2 = await unclaimedPartnerQuoteFee(coin.poolId!);
  const pre2 = await snapshotBalances(seed, [whale]);
  runStep("scripts/epoch.ts");
  const post2 = await snapshotBalances(seed, [whale]);
  const e2 = newestEpoch();
  const migrated = db.getCoin(seed.mint)!;
  const view = await readCoinView(migrated);
  const surplus = BigInt(db.getClaimProgress(e2.id, seed.mint, "surplus")?.amountZats ?? "0");
  checks.push({ label: "epoch 2: the keeper migrated the coin to DAMM v2 and recorded the pool and the partner position", pass: !!migrated.dammPool && !!migrated.positionNft && !!migrated.migratedAt, detail: `dammPool=${migrated.dammPool} positionNft=${migrated.positionNft}` });
  checks.push({ label: "epoch 2: the coin reads as graduated on venue meteora-damm-v2", pass: view?.stage === "graduated" && view.venue === "meteora-damm-v2", detail: `stage=${view?.stage} venue=${view?.venue} priceZec=${view?.priceZec}` });
  checks.push({ label: "epoch 2: claimed ZEC equals the accrued curve fee plus the partner surplus", pass: BigInt(e2.harvestedZats) === expected2 + surplus && expected2 > 0n, detail: `claimed=${e2.harvestedZats} pool partnerQuoteFee=${expected2} surplus=${surplus}` });
  checks.push(...checkPayoutDeltas("solana", pre2.solana, post2.solana, e2.id), ...checkPayoutDeltas("shielded", pre2.shielded, post2.shielded, e2.id));
  checks.push(...(await checkIronwoodPayouts(seed, e2.id)), ...epochChecks("epoch 2", e2, known));
  checks.push(...splitChecks("epoch 2", e2), ...memoChecks(seed, e2), ...(await snapshotChecks("epoch 2", e2)));
  checks.push({ label: "epoch 2: the whale holding graduated tokens is paid, pool vaults are not", pass: db.getPayouts(e2.id).some((p) => p.wallet === whale.publicKey.toBase58()), detail: "whale in payout rows" });

  // ---- a trade on the graduated pool, then epoch 3: post-migration claim ----
  const dammBuyZats = 50_000_000n;
  await buyThroughApiBuilder(whale, seed.mint, dammBuyZats);
  const pre3 = await snapshotBalances(seed, [whale]);
  const teamWallet = Keypair.generate().publicKey; // from epoch 3 on a team wallet is configured: it is swept the whole backlog
  const heldBefore3 = db.teamTotals().heldInKeeperZats;
  runStep("scripts/epoch.ts", { TEAM_WALLET: teamWallet.toBase58() });
  const post3 = await snapshotBalances(seed, [whale]);
  const e3 = newestEpoch();
  const positionClaim = db.getClaimProgress(e3.id, seed.mint, "damm_position");
  const expectedPosition = (dammBuyZats * BigInt(config.solana.dbc.feeBps) * 8n) / (10_000n * 10n); // 80% of the 1% pool fee
  const claimedPosition = BigInt(positionClaim?.amountZats ?? "0");
  checks.push({ label: "epoch 3: the post-migration DAMM v2 position fee was claimed and equals 80% of the pool fee (within 2 zats)", pass: positionClaim?.status === "confirmed" && (claimedPosition > expectedPosition ? claimedPosition - expectedPosition : expectedPosition - claimedPosition) <= 2n, detail: `claimed=${claimedPosition} expected~${expectedPosition} epochClaimed=${e3.harvestedZats}` });
  checks.push(...checkPayoutDeltas("solana", pre3.solana, post3.solana, e3.id), ...checkPayoutDeltas("shielded", pre3.shielded, post3.shielded, e3.id));
  checks.push(...(await checkIronwoodPayouts(seed, e3.id)), ...epochChecks("epoch 3", e3, new Set([...known, teamWallet.toBase58()])));
  checks.push(...splitChecks("epoch 3", e3), ...memoChecks(seed, e3), ...(await snapshotChecks("epoch 3", e3)));
  const teamRow = db.getPayouts(e3.id).find((p) => p.kind === "team");
  const e3Fresh = db.getEpoch(e3.id)!;
  checks.push({ label: "epoch 3: TEAM_WALLET was set, so the team's Solana ZEC from epochs 1 to 3 (the backlog held in the keeper plus this epoch's) went to it in one transfer, exactly once", pass: !!teamRow?.sentAt && BigInt(teamRow.amountZats) === heldBefore3 + BigInt(e3Fresh.teamSolanaZats ?? "0") && (await solanaZecBalance(teamWallet)) === BigInt(teamRow.amountZats) && db.teamTotals().heldInKeeperZats === 0n, detail: `held before=${heldBefore3} row=${teamRow?.amountZats} on chain=${await solanaZecBalance(teamWallet)} held after=${db.teamTotals().heldInKeeperZats}` });

  // ---- epoch 4: a coin whose fee claimer is a Squads vault ----
  const keeper = loadKeeperKeypair();
  const ms = await createLocalMultisig(keeper); // owner (stands in for the phone wallet) + backup + the keeper with Initiate+Vote+Execute, threshold 2
  const vaultConfig = await createDbcConfig(ms.vault);
  const creator2 = Keypair.generate();
  await fundTestWallet(creator2.publicKey, 2, keeper);
  const launch2 = await buildLaunchTx({ creator: creator2.publicKey.toBase58(), name: "VAULT", symbol: "VLT", description: "fee claimer is a Squads vault", imageUrl: "", initialBuyZats: "20000000" });
  const launchTx = VersionedTransaction.deserialize(Buffer.from(launch2.txBase64, "base64"));
  launchTx.sign([creator2]);
  const launchSig = await getConnection().sendRawTransaction(launchTx.serialize());
  await getConnection().confirmTransaction(launchSig, "confirmed");
  await confirmLaunch(launchSig, launch2.mint);
  await waitForCoinWindow(launch2.mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  const coin2 = db.getCoin(launch2.mint)!;
  await buyThroughApiBuilder(whale, launch2.mint, 30_000_000n);
  await fundTestWallet(ms.owner.publicKey, 1, keeper);
  await buyThroughApiBuilder(ms.owner, launch2.mint, 10_000_000n); // a multisig member holds the coin: it must not be paid
  const mint2Key = new PublicKey(launch2.mint);
  const vaultAta = getAssociatedTokenAddressSync(mint2Key, ms.vault, true, TOKEN_2022_PROGRAM_ID); // and so does the vault itself
  const creatorAta2 = getAssociatedTokenAddressSync(mint2Key, creator2.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const creatorHeld = (await getAccount(getConnection(), creatorAta2, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  await sendAndConfirmTransaction(getConnection(), new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(creator2.publicKey, vaultAta, ms.vault, mint2Key, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(creatorAta2, mint2Key, vaultAta, creator2.publicKey, creatorHeld / 10n, config.solana.dbc.baseDecimals, [], TOKEN_2022_PROGRAM_ID),
  ), [creator2], { commitment: "confirmed" });
  checks.push({ label: "epoch 4: the second coin's DBC config names the Squads vault as fee claimer (read back and verified field by field)", pass: vaultConfig.feeClaimer === ms.vault.toBase58() && coin2.configId === vaultConfig.configId, detail: `fee claimer=${vaultConfig.feeClaimer} config=${vaultConfig.configId}` });

  const expected4 = await unclaimedPartnerQuoteFee(coin2.poolId!);
  const epochsBefore = db.listEpochs().length;
  const lamportsBefore = await getConnection().getBalance(keeper.publicKey);
  const waiting = runStep("scripts/epoch.ts", { SQUADS_MULTISIG: ms.multisigPda.toBase58(), TEAM_WALLET: teamWallet.toBase58() });
  const claimRow = db.getClaimProgress(db.findDraftEpoch()!.id, coin2.mint, "trading");
  checks.push({ label: "epoch 4: the keeper proposed the claim and the run STOPPED: nothing finalized, nothing paid, no epoch recorded", pass: /epoch waiting/.test(waiting) && db.listEpochs().length === epochsBefore && claimRow?.phase === "await" && db.getPayouts(db.findDraftEpoch()!.id).length === 0, detail: `phase=${claimRow?.phase} epochs=${db.listEpochs().length}` });
  const proposals = await listActiveProposals(getConnection(), ms.multisigPda);
  const proposal = proposals.find((p) => p.index === BigInt(JSON.parse(claimRow!.ref!).txIndex))!;
  const described = await describeProposal(getConnection(), ms.multisigPda, proposal.index);
  console.log("\nWhat the owner reads before approving:\n" + described.text);
  lines.push("owner's view of the proposal:", ...described.text.split("\n"), "");
  checks.push({ label: "epoch 4: the proposal, decoded from the STORED message, pays only token accounts owned by the keeper; the keeper alone has approved (1 of 2)", pass: described.receivers.length > 0 && described.receivers.every((r) => r.owner === keeper.publicKey.toBase58()) && described.approvals.length === 1 && described.unknownInstructions.length === 0, detail: described.text.replace(/\n/g, " | ") });
  checks.push({ label: "epoch 4: before approval no ZEC left the pool (the keeper could not claim alone)", pass: (await unclaimedPartnerQuoteFee(coin2.poolId!)) === expected4, detail: `pool partnerQuoteFee=${expected4}` });
  await approveProposal(getConnection(), ms.multisigPda, proposal.index, ms.owner); // the owner's approval
  const pre4 = await snapshotBalances(seed, [whale, creator2]);
  runStep("scripts/epoch.ts", { SQUADS_MULTISIG: ms.multisigPda.toBase58(), TEAM_WALLET: teamWallet.toBase58() });
  const post4 = await snapshotBalances(seed, [whale, creator2]);
  const e4 = newestEpoch();
  const rows4 = db.getPayouts(e4.id);
  const notPaid = new Set([ms.owner.publicKey.toBase58(), ms.backup.publicKey.toBase58(), ms.vault.toBase58(), keeper.publicKey.toBase58()]);
  checks.push(...checkPayoutDeltas("solana", pre4.solana, post4.solana, e4.id), ...epochChecks("epoch 4", e4, new Set([...knownWallets(seed, [whale, creator2]), teamWallet.toBase58()])));
  checks.push(...splitChecks("epoch 4", e4), ...(await snapshotChecks("epoch 4", e4)));
  checks.push({ label: "epoch 4: claimed ZEC equals the fee the pool had accrued for the partner (executed by the keeper after the owner approved)", pass: BigInt(e4.harvestedZats) === expected4 && expected4 > 0n && e4.id !== e3.id, detail: `claimed=${e4.harvestedZats} pool partnerQuoteFee=${expected4}` });
  checks.push({ label: "epoch 4: the multisig's owner and backup (members), the vault and the keeper were not paid although the owner and the vault hold the coin", pass: rows4.length > 0 && !rows4.some((p) => notPaid.has(p.wallet)) && rows4.some((p) => p.wallet === creator2.publicKey.toBase58()) && rows4.some((p) => p.wallet === whale.publicKey.toBase58()), detail: `paid=${rows4.map((p) => p.wallet.slice(0, 6)).join(",")}` });
  const spent = lamportsBefore - (await getConnection().getBalance(keeper.publicKey));
  checks.push({ label: "epoch 4: the keeper's net SOL cost of the whole vault claim is small (proposal rent is refunded to it; at local rent a new base-token account is 2,074,080 lamports)", pass: spent < 2_600_000, detail: `keeper spent ${spent} lamports incl. payouts' new accounts` });
  const squadsMembers: string[] = JSON.parse(db.getMeta("squads_members") ?? "[]");
  checks.push({ label: "epoch 4: the multisig's members were recorded for the holder exclusion", pass: squadsMembers.includes(ms.owner.publicKey.toBase58()) && squadsMembers.includes(ms.backup.publicKey.toBase58()), detail: `members=${squadsMembers.length}` });

  // ---- epoch 5: a coin on the 4% creator-fee tier ----
  const tier5 = 400;
  const tierConfig = await createDbcConfig(keeper.publicKey, tier5); // the keeper claims this one (a local keypair claimer): the epoch needs no approval
  const creator5 = Keypair.generate();
  await fundTestWallet(creator5.publicKey, 2, keeper);
  const launch5 = await buildLaunchTx({ creator: creator5.publicKey.toBase58(), name: "TIER4", symbol: "TR4", description: "a 4% creator-fee coin", imageUrl: "", initialBuyZats: "100000000", feeTier: tier5 });
  const launchTx5 = VersionedTransaction.deserialize(Buffer.from(launch5.txBase64, "base64"));
  launchTx5.sign([creator5]);
  const launchSig5 = await getConnection().sendRawTransaction(launchTx5.serialize());
  await getConnection().confirmTransaction(launchSig5, "confirmed");
  await confirmLaunch(launchSig5, launch5.mint);
  await waitForCoinWindow(launch5.mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  const coin5 = db.getCoin(launch5.mint)!;
  await buyThroughApiBuilder(whale, launch5.mint, 250_000_000n);
  const poolState5 = (await getDbcClient().state.getPool(coin5.poolId!))!.poolState;
  const owed5 = { partner: BigInt(poolState5.partnerQuoteFee.toString()), creator: BigInt(poolState5.creatorQuoteFee.toString()) };
  const model5 = [tradeSplit(100_000_000n, tier5), tradeSplit(250_000_000n, tier5)];
  checks.push({ label: "epoch 5: the 4% coin is on its own tier config, read back and verified field by field (fee 4%, creator 75%, DAMM v2 4% pool, LP 25/75)", pass: coin5.configId === tierConfig.configId && coin5.feeBps === tier5 && tierConfig.feeBps === tier5, detail: `config=${tierConfig.configId} coin fee=${coin5.feeBps}` });
  checks.push({ label: "epoch 5: the pool accrued exactly the modelled split of the two buys: creator 75%, the pad 25% of what Meteora leaves (to the zat)", pass: owed5.partner === model5[0]!.partner + model5[1]!.partner && owed5.creator === model5[0]!.creator + model5[1]!.creator && owed5.creator > 0n, detail: `partner=${owed5.partner} creator=${owed5.creator}` });

  const pre5 = await snapshotBalances(seed, [whale, creator2, creator5]);
  runStep("scripts/epoch.ts", { SQUADS_MULTISIG: ms.multisigPda.toBase58(), TEAM_WALLET: teamWallet.toBase58() });
  const post5 = await snapshotBalances(seed, [whale, creator2, creator5]);
  const e5 = newestEpoch();
  checks.push(...checkPayoutDeltas("solana", pre5.solana, post5.solana, e5.id), ...epochChecks("epoch 5", e5, new Set([...knownWallets(seed, [whale, creator2, creator5]), teamWallet.toBase58()])));
  checks.push(...splitChecks("epoch 5", e5), ...(await snapshotChecks("epoch 5", e5)));
  const after5 = (await getDbcClient().state.getPool(coin5.poolId!))!.poolState;
  checks.push({ label: "epoch 5: the epoch claimed exactly the partner part of the 4% coin's fee, and left the creator's share untouched in the pool", pass: BigInt(e5.harvestedZats) === owed5.partner && BigInt(after5.partnerQuoteFee.toString()) === 0n && BigInt(after5.creatorQuoteFee.toString()) === owed5.creator, detail: `claimed=${e5.harvestedZats} partner owed=${owed5.partner} creator in pool=${after5.creatorQuoteFee.toString()}` });

  const creatorZecBefore = await solanaZecBalance(creator5.publicKey);
  const claim5 = await buildCreatorClaimTx(launch5.mint, creator5.publicKey.toBase58());
  const claimTx5 = VersionedTransaction.deserialize(Buffer.from(claim5.txBase64, "base64"));
  claimTx5.sign([creator5]);
  await getConnection().confirmTransaction(await getConnection().sendRawTransaction(claimTx5.serialize()), "confirmed");
  const creatorGot = (await solanaZecBalance(creator5.publicKey)) - creatorZecBefore;
  checks.push({ label: "epoch 5: the creator claimed their own share with their own signature: it landed in their wallet and nowhere else, and nothing was left in the pool", pass: creatorGot === owed5.creator && BigInt((await getDbcClient().state.getPool(coin5.poolId!))!.poolState.creatorQuoteFee.toString()) === 0n, detail: `creator received=${creatorGot} owed=${owed5.creator}` });
  const stranger5 = await buildCreatorClaimTx(launch5.mint, whale.publicKey.toBase58()).then(() => "built", (e: { code?: string }) => e.code);
  checks.push({ label: "epoch 5: another wallet cannot get a claim transaction for the creator's fees", pass: stranger5 === "not_creator", detail: `answer=${stranger5}` });

  // ---- operations: the kill switch and the keeper loop (plan sections 4 and 4b) ----
  const epochsBeforeOps = db.listEpochs().length;
  const pausedOut = runStep("scripts/epoch.ts", { PAYOUTS_PAUSED: "1" });
  checks.push({ label: "ops: PAYOUTS_PAUSED=1 stops an epoch run before any claim or payout (no epoch recorded, no draft)", pass: /payouts are paused/.test(pausedOut) && db.listEpochs().length === epochsBeforeOps && !db.findDraftEpoch(), detail: pausedOut.trim().slice(0, 120) });
  process.env.PAYOUTS_PAUSED = "1";
  const pausedView = await getTreasuryView();
  delete process.env.PAYOUTS_PAUSED;
  checks.push({ label: "ops: GET /treasury says paused: true while the switch is on, false after", pass: pausedView.paused === true && (await getTreasuryView()).paused === false, detail: `paused=${pausedView.paused}` });
  const healthLog = join(config.paths.dataDir, "e2e-keeper-health.log");
  const keeperOut = runStep("scripts/keeper.ts", { PAD_KEEPER_HEALTH_LOG: healthLog }, ["--once"]);
  const cycleStart = Date.parse(db.listEpochs()[0]!.at);
  const nextDue = new Date(cycleStart + config.scheduler.epochEveryMs).toISOString();
  const lastHealth = existsSync(healthLog) ? readFileSync(healthLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  checks.push({ label: "ops: the keeper loop (one tick) runs no epoch before its cadence is due, publishes the next due time (48 h after the last epoch) on /treasury and writes a health line", pass: db.listEpochs().length === epochsBeforeOps && (await getTreasuryView()).nextEpochAt === nextDue && lastHealth.some((h) => h.nextEpochAt === nextDue), detail: `nextEpochAt=${(await getTreasuryView()).nextEpochAt} expected=${nextDue} health lines=${lastHealth.length} ${keeperOut.trim().slice(0, 60)}` });

  // ---- the verify script, run the way anyone would: against the API, with the Solana RPC for the memo ----
  const apiProc = Bun.spawn(["bun", "run", "scripts/api.ts"], { cwd: config.paths.engineRoot, stdout: "ignore", stderr: "ignore", env: { ...process.env, TEAM_WALLET: teamWallet.toBase58() } });
  try {
    for (let i = 0; i < 40; i++) {
      if ((await fetch(`http://localhost:${config.api.port}/api/treasury`).catch(() => null))?.ok) break;
      await Bun.sleep(500);
    }
    const apiTreasury = (await (await fetch(`http://localhost:${config.api.port}/api/treasury`)).json()) as { policy: Record<string, number>; team: Record<string, string | null> };
    checks.push({ label: "api: GET /treasury publishes the policy (holders 75%, team 25% of what is claimed) and the team ledger", pass: apiTreasury.policy.holdersShareOfClaimedBps === 7500 && apiTreasury.policy.teamShareOfClaimedBps === 2500 && apiTreasury.team.wallet === teamWallet.toBase58() && apiTreasury.team.heldInKeeperZats === "0" && BigInt(apiTreasury.team.grossZats!) === BigInt(apiTreasury.team.sweptZats!) + BigInt(apiTreasury.team.deliveryCostZats!) + BigInt(apiTreasury.team.nativeZats!), detail: JSON.stringify(apiTreasury.team) }); // gross = swept to the team wallet + delivery cost + native ZEC left in the treasury, to the zat
    const apiEpochs = ((await (await fetch(`http://localhost:${config.api.port}/api/epochs`)).json()) as { epochs: { id: string; split: Record<string, string | null>; snapshot: { sha256: string; memoSig: string | null } | null }[] }).epochs;
    const apiE1 = apiEpochs.find((e) => e.id === e1.id)!;
    checks.push({ label: "api: GET /epochs shows holders, team and delivery cost per epoch, and the snapshot hash with its memo signature", pass: BigInt(apiE1.split.holdersZats!) + BigInt(apiE1.split.teamZats!) === BigInt(e1.harvestedZats) && apiE1.split.deliveryCostZats !== null && apiE1.snapshot?.memoSig === db.getEpochSnapshot(e1.id)!.memoSig, detail: JSON.stringify(apiE1.split) });
    const tiersBody = (await (await fetch(`http://localhost:${config.api.port}/api/tiers`)).json()) as { tiers: { feeBps: number; available: boolean; creatorShareBps: number; holderShareBps: number; teamShareBps: number; meteoraShareBps: number }[] };
    const t4 = tiersBody.tiers.find((t) => t.feeBps === tier5);
    checks.push({ label: "api: GET /tiers lists the five tiers; the 4% one is available (its config exists) and splits the fee Meteora 20 / creator 60 / holders 15 / team 5 percent", pass: tiersBody.tiers.length === 5 && !!t4 && t4.available && t4.meteoraShareBps === 2000 && t4.creatorShareBps === 6000 && t4.holderShareBps === 1500 && t4.teamShareBps === 500 && tiersBody.tiers.find((t) => t.feeBps === 1000)?.available === false, detail: JSON.stringify(tiersBody.tiers.map((t) => [t.feeBps, t.available])) });
    const coinBody = (await (await fetch(`http://localhost:${config.api.port}/api/coins/${launch5.mint}`)).json()) as { feeBps: number; creatorShareBps: number; holderShareBps: number; claimedShareBps: number; postGraduationFeeBps: number };
    checks.push({ label: "api: the 4% coin reports its tier and who gets what of the fee (claimed 2000, holders 1500, creator 6000)", pass: coinBody.feeBps === 400 && coinBody.creatorShareBps === 6000 && coinBody.holderShareBps === 1500 && coinBody.claimedShareBps === 2000 && coinBody.postGraduationFeeBps === 400, detail: JSON.stringify(coinBody) });
    const hostileLaunch = await fetch(`http://localhost:${config.api.port}/api/coins/launch-tx`, { method: "POST", body: JSON.stringify({ creator: creator5.publicKey.toBase58(), name: "X", symbol: "XX", feeTier: 250 }) });
    const hostileClaim = await fetch(`http://localhost:${config.api.port}/api/coins/${launch5.mint}/creator-claim-tx`, { method: "POST", body: JSON.stringify({ wallet: whale.publicKey.toBase58() }) });
    checks.push({ label: "api: a launch on a fee that is not a tier is refused (400 bad_request feeTier); a creator-claim for a wallet that is not the creator is refused (403 not_creator)", pass: hostileLaunch.status === 400 && ((await hostileLaunch.json()) as { field?: string }).field === "feeTier" && hostileClaim.status === 403, detail: `launch=${hostileLaunch.status} claim=${hostileClaim.status}` });
    // ---- contract v2.5 (explore): the numbers on real pools equal what the database says, worked out here without the engine's own code ----
    const apiBase = `http://localhost:${config.api.port}/api`;
    type Listed = { mint: string; stage: string; graduatedAt: string | null; volume24hZats: string; trades24h: number; priceChange24hBps: number | null; holders: number | null };
    const board = (await (await fetch(`${apiBase}/coins?sort=volume`)).json()) as { coins: Listed[]; total: number };
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const recorded = (mint: string) => db.listTradesForMint(mint, 100_000).filter((t) => t.at >= dayAgo);
    const volumeOf = (mint: string) => recorded(mint).reduce((a, t) => a + BigInt(t.amountZec), 0n);
    const expectedVolume = board.coins.map((c) => volumeOf(c.mint));
    checks.push({
      label: "api: GET /coins gives every coin its 24-hour volume and trade count from the recorded trades, newest-window only, and sort=volume puts the biggest first",
      pass: board.total === board.coins.length && board.coins.length === db.listCoins().filter((c) => c.status === "launched").length
        && board.coins.every((c, i) => c.volume24hZats === expectedVolume[i]!.toString() && c.trades24h === recorded(c.mint).length)
        && expectedVolume.every((v, i) => i === 0 || expectedVolume[i - 1]! >= v) && expectedVolume[0]! > 0n,
      detail: board.coins.map((c) => `${c.mint.slice(0, 6)} vol=${c.volume24hZats} n=${c.trades24h}`).join("; "),
    });
    const seedCoin = board.coins.find((c) => c.mint === seed.mint)!;
    const seedRow = db.getCoin(seed.mint)!;
    checks.push({
      label: "api: the migrated coin reads graduated with the graduation time the keeper recorded; a coin on the curve has none and no price change without a trade",
      pass: seedCoin.stage === "graduated" && seedCoin.graduatedAt === seedRow.migratedAt && seedCoin.graduatedAt !== null
        && board.coins.filter((c) => c.stage === "curve").every((c) => c.graduatedAt === null && (c.trades24h > 0 || c.priceChange24hBps === null)),
      detail: `graduatedAt=${seedCoin.graduatedAt} recorded=${seedRow.migratedAt}`,
    });
    const graduated = (await (await fetch(`${apiBase}/coins?stage=graduated`)).json()) as { coins: Listed[]; total: number };
    const curveOnly = (await (await fetch(`${apiBase}/coins?stage=curve&sort=progress&limit=1&offset=1`)).json()) as { coins: Listed[]; total: number };
    checks.push({ label: "api: stage, limit and offset: stage=graduated lists only the migrated coin; stage=curve with limit=1&offset=1 is one coin and total counts them all", pass: graduated.total === 1 && graduated.coins[0]?.mint === seed.mint && curveOnly.coins.length === 1 && curveOnly.total === board.total - 1, detail: `graduated=${graduated.total} curve total=${curveOnly.total}` });
    const stats = (await (await fetch(`${apiBase}/stats`)).json()) as { coins: number; graduated: number; volume24hZats: string; paidSolanaZats: string; paidShieldedZats: string; optIns: number };
    const railTotals = ((await (await fetch(`${apiBase}/epochs`)).json()) as { epochs: { solanaPayouts: { totalZats: string }; shielded: { totalZats: string } }[] }).epochs;
    const sumEpochs = (rail: "solanaPayouts" | "shielded") => railTotals.reduce((a, e) => a + BigInt(e[rail].totalZats), 0n).toString();
    checks.push({
      label: "api: GET /stats equals the database: launched and graduated coins, the board's 24-hour volume, what GET /epochs adds up per rail, and the active opt-ins",
      pass: stats.coins === board.total && stats.graduated === db.listCoins().filter((c) => c.status === "launched" && !!c.dammPool).length
        && stats.volume24hZats === expectedVolume.reduce((a, v) => a + v, 0n).toString()
        && stats.paidSolanaZats === sumEpochs("solanaPayouts") && stats.paidShieldedZats === sumEpochs("shielded")
        && stats.optIns === db.listActiveOptins().length && BigInt(stats.paidSolanaZats) > 0n && BigInt(stats.paidShieldedZats) > 0n,
      detail: JSON.stringify(stats),
    });
    const badSort = await fetch(`${apiBase}/coins?sort=bogus`);
    const badLimit = await fetch(`${apiBase}/coins?limit=101`);
    checks.push({ label: "api: a bad list parameter is refused with 400 bad_request and its field (sort, limit)", pass: badSort.status === 400 && badLimit.status === 400 && JSON.stringify(await badSort.json()) === '{"error":"bad_request","field":"sort"}' && JSON.stringify(await badLimit.json()) === '{"error":"bad_request","field":"limit"}', detail: `sort=${badSort.status} limit=${badLimit.status}` });
    // ---- contract v2.6 (the trader panel, live trades, rewards and ledgers): every route, on these coins, against the chain ----
    checks.push(...(await traderApiChecks({
      apiBase, graduated: seed.mint, vaultCoin: { mint: launch2.mint, multisig: ms.multisigPda },
      tierCoin: { mint: launch5.mint, bps: tier5, symbol: "TR4", creator: creator5 }, whale, known,
      optinBuyers: seed.optinBuyers.map((o) => ({ keypair: keyOf(o.secretKey), walletDir: o.walletDir })),
      solanaHolder: keyOf(seed.defaultBuyers[0]!).publicKey.toBase58(),
      rounds: { first: e1, graduated: e3, vault: e4, tier: e5 },
      buy: buyThroughApiBuilder,
    })));
    for (const e of [e1, e4, e5]) {
      const run = Bun.spawnSync(["bun", "scripts/verify-snapshot.ts", "--api", `http://localhost:${config.api.port}/api`, "--epoch", e.id, "--rpc", config.solana.rpc], { cwd: config.paths.engineRoot });
      const text = run.stdout.toString();
      checks.push({ label: `verify script: bun scripts/verify-snapshot.ts on ${e.id.slice(-5)} prints VERIFIED (file hash, Solana memo, arithmetic)`, pass: run.exitCode === 0 && text.includes("VERIFIED") && text.includes("the Solana memo"), detail: text.trim().replace(/\n/g, " | ") });
    }
  } finally {
    apiProc.kill();
  }

  for (const e of [e1, e2, e3, e4, e5]) lines.push(`epoch: ${e.id}  status=${e.status}  claimedZats=${e.harvestedZats}  feeZats=${e.feeZats}`);
  lines.push("");
  for (const c of checks) lines.push(`[${c.pass ? "PASS" : "FAIL"}] ${c.label} — ${c.detail}`);
  const allPass = checks.every((c) => c.pass);
  lines.push("", allPass ? `RESULT: PASS (${checks.length} checks)` : `RESULT: FAIL (${checks.filter((c) => !c.pass).length}/${checks.length} checks failed)`);

  const out = lines.join("\n") + "\n";
  writeFileSync(join(config.paths.engineRoot, "E2E-RESULT.txt"), out);
  console.log("\n" + out);
  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error("e2e failed:", err);
  writeFileSync(join(config.paths.engineRoot, "E2E-RESULT.txt"), `e2e FAILED: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
