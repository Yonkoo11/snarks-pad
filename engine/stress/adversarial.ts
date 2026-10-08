#!/usr/bin/env bun
// Scenario 2 (audit/STRESS-REPORT.md): adversarial holders against a real coin on the local validator, with its own
// keeper key and DB (run it with PAD_DB_FILE, KEEPER_KEYPAIR_PATH, PAD_PAUSE_FILE and PAD_API_PORT set to fresh values).
// Attacks: a PDA (off-curve) owner, a ZEC account closed mid-epoch, one whose owner is reassigned mid-epoch, one the
// keeper paid rent for and that is closed afterwards, dust wallets, a sniper that buys after the window samples,
// an opt-out between planning and sending, malformed / duplicate / replayed opt-ins over HTTP.
// Every expectation is computed here from chain reads (pool state, token accounts, the recipients' Zcash accounts);
// the engine's DB is only compared against it.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  AuthorityType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createCloseAccountInstruction, createSetAuthorityInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { config } from "../src/config";
import * as db from "../src/db";
import { loadKeeperKeypair } from "../src/keeper";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx } from "../src/dbc/trade";
import { claimRemainingCoins, runEpoch } from "../src/epoch/engine";
import { takeSamplesNow } from "../src/epoch/snapshots";
import { selectSwapAdapter } from "../src/swap/select";
import { optinMessage, optoutMessage } from "../src/optin/message";
import { TREASURY_DIR } from "../src/zcash/regtest";
import {
  STRESS_DIR, ZEC, airdrop, direct, distributeTokens, fundSol, independentSplit, mintZecTo, send, sendV0,
  tokenBalancesByOwner, zecAtaBalances,
} from "./lib";
import { accountTotalZats, makeRecipientWallets, syncRecipientWallet } from "./zrecipients";

const API = `http://127.0.0.1:${config.api.port}/api`;
const PAUSE = config.paths.pauseFile;
const problems: string[] = [];
const facts: Record<string, unknown> = {};
const check = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const onCurve = (o: string) => PublicKey.isOnCurve(new PublicKey(o).toBytes());

// Policy constants written down from engine/README.md, not imported.
const DUST = 5_000n, NEW_MIN = 30_000n, SHIELDED_MIN = 100_000n, SWAP_MIN = 1_000_000n, TEAM_BPS = 2_500n;
const WITHDRAW = 32_000n, RESERVE_BPS = 100n, SPREAD_BPS = 25n, PER_TX = 350n;

async function trade(kp: Keypair, mint: string, side: "buy" | "sell", amount: bigint): Promise<void> {
  const { txBase64 } = await buildTradeTx({ wallet: kp.publicKey.toBase58(), mint, side, amount: amount.toString(), slippageBps: 3000 });
  await sendV0(txBase64, kp);
}

async function roundTrip(t: Keypair, mint: string): Promise<void> {
  await trade(t, mint, "buy", 30_000_000n);
  const b = (await tokenBalancesByOwner(new PublicKey(mint), TOKEN_2022_PROGRAM_ID)).get(t.publicKey.toBase58()) ?? 0n;
  if (b > 0n) await trade(t, mint, "sell", b);
}

async function claimableCurve(mint: string): Promise<bigint> {
  const dbc = DynamicBondingCurveClient.create(direct, "confirmed");
  const p = await dbc.state.getPoolByBaseMint(new PublicKey(mint));
  return BigInt((await dbc.state.getPoolFeeMetrics(p!.publicKey)).current.partnerQuoteFee.toString());
}

async function api(method: string, path: string, body?: unknown, raw?: string): Promise<{ status: number; json: any; text: string }> {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const sign = (kp: Keypair, msg: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));
async function nonce(w: Keypair): Promise<string> { return (await api("GET", `/optin/nonce?wallet=${w.publicKey.toBase58()}`)).json.nonce; }
async function optinBody(w: Keypair, ua: string) {
  const n = await nonce(w);
  return { wallet: w.publicKey.toBase58(), zcashAddress: ua, nonce: n, signature: sign(w, optinMessage(w.publicKey.toBase58(), ua, n)) };
}

interface Snap { weights: Map<string, bigint> }
async function snap(mint: string): Promise<Snap> {
  return { weights: await tokenBalancesByOwner(new PublicKey(mint), TOKEN_2022_PROGRAM_ID) };
}

/** My expectation for one epoch: per-wallet Solana pay / carry and shielded plan, from chain snapshots only. */
function expect1(snaps: Snap[], claimed: bigint, keeper: string, opted: Set<string>, carryIn: Map<string, bigint>, hadAta: Map<string, bigint | null>, unusable: Set<string>, keeperFundedClosed: Set<string>) {
  const team = (claimed * TEAM_BPS) / 10_000n;
  const owners = new Set(snaps.flatMap((s) => [...s.weights.keys()]));
  const weights: { id: string; w: bigint }[] = [];
  for (const o of owners) {
    if (o === keeper || !onCurve(o)) continue;
    const ws = snaps.map((s) => s.weights.get(o) ?? 0n);
    const min = ws.reduce((a, b) => (b < a ? b : a));
    if (min > 0n) weights.push({ id: o, w: min });
  }
  const share = independentSplit(claimed - team, weights);
  for (const [w, c] of carryIn) share.set(w, (share.get(w) ?? 0n) + c);
  const sol = new Map<string, bigint>(); const solCarry = new Map<string, bigint>(); const zPlan = new Map<string, bigint>(); const zCarry = new Map<string, bigint>();
  for (const [w, a] of share) {
    if (a === 0n) continue;
    if (opted.has(w)) { (a >= SHIELDED_MIN ? zPlan : zCarry).set(w, a); continue; }
    const ok = a >= DUST && !unusable.has(w) && !keeperFundedClosed.has(w) && (hadAta.get(w) != null || a > NEW_MIN);
    (ok ? sol : solCarry).set(w, a);
  }
  let zTotal = [...zPlan.values()].reduce((a, b) => a + b, 0n);
  if (zTotal < SWAP_MIN) { for (const [w, a] of zPlan) zCarry.set(w, a); zPlan.clear(); zTotal = 0n; }
  const n = BigInt(zPlan.size);
  const chunks = n === 0n ? 1n : (n + PER_TX - 1n) / PER_TX;
  let reserve = 0n, settled = 0n, paidTotal = 0n;
  let zPaid = new Map<string, bigint>();
  if (zTotal > 0n) {
    const est = WITHDRAW + 5000n * (n + chunks) + (zTotal * RESERVE_BPS + 9_999n) / 10_000n;
    reserve = est < team ? est : team;
    settled = ((zTotal + reserve) * (10_000n - SPREAD_BPS)) / 10_000n - WITHDRAW;
    const avail = settled - 5000n * (n + chunks);
    paidTotal = avail < zTotal ? avail : zTotal;
    zPaid = independentSplit(paidTotal, [...zPlan].map(([id, w]) => ({ id, w })));
  }
  return { team, share, sol, solCarry, zPlan, zCarry, zTotal, reserve, settled, paidTotal, zPaid, fee: 5000n * (n + chunks) * (zTotal > 0n ? 1n : 0n) };
}

async function hostileOptins(o1: Keypair, ua: string, other: Keypair): Promise<void> {
  const before = (db.getDb().query("SELECT COUNT(*) AS n FROM optins").get() as { n: number }).n;
  const w = o1.publicKey.toBase58();
  const goodN = await nonce(o1);
  const cases: [string, string, string, unknown, string?][] = [
    ["non-JSON body", "POST", "/optin", undefined, "{not json"],
    ["JSON array body", "POST", "/optin", [1, 2]],
    ["missing wallet", "POST", "/optin", { zcashAddress: ua, nonce: goodN, signature: "x" }],
    ["wallet not base58", "POST", "/optin", { wallet: "0OIl!!", zcashAddress: ua, nonce: goodN, signature: "x" }],
    ["zcashAddress is a number", "POST", "/optin", { wallet: w, zcashAddress: 12345, nonce: goodN, signature: "x" }],
    ["zcashAddress 3000 chars", "POST", "/optin", { wallet: w, zcashAddress: "u".repeat(3000), nonce: goodN, signature: "x" }],
    ["transparent address", "POST", "/optin", { wallet: w, zcashAddress: "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd", nonce: goodN, signature: sign(o1, optinMessage(w, "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd", goodN)) }],
    ["garbage unified address", "POST", "/optin", { wallet: w, zcashAddress: "u1" + "q".repeat(100), nonce: goodN, signature: sign(o1, optinMessage(w, "u1" + "q".repeat(100), goodN)) }],
    ["empty nonce", "POST", "/optin", { wallet: w, zcashAddress: ua, nonce: "", signature: "x" }],
    ["nonce with NUL and unicode", "POST", "/optin", { wallet: w, zcashAddress: ua, nonce: "a\u0000‮", signature: sign(o1, optinMessage(w, ua, "a\u0000‮")) }],
    ["garbage signature", "POST", "/optin", { wallet: w, zcashAddress: ua, nonce: goodN, signature: "xyz" }],
    ["signature by another key", "POST", "/optin", { wallet: w, zcashAddress: ua, nonce: goodN, signature: sign(other, optinMessage(w, ua, goodN)) }],
    ["opt-out message signed for opt-in", "POST", "/optin", { wallet: w, zcashAddress: ua, nonce: goodN, signature: sign(o1, optoutMessage(w, goodN)) }],
    ["body over 16 KiB", "POST", "/optin", undefined, JSON.stringify({ wallet: w, pad: "a".repeat(20_000) })],
    ["nonce for a bad wallet", "GET", "/optin/nonce?wallet=notakey", undefined],
    ["unsigned status read (no such route since v2.9)", "GET", "/optin/not-a-key", undefined],
    ["signed status read for a bad wallet", "POST", "/optin/status", { wallet: "not-a-key", nonce: goodN, signature: "x" }],
    ["opt-in message signed for a status read", "POST", "/optin/status", { wallet: w, nonce: goodN, signature: sign(o1, optinMessage(w, ua, goodN)) }],
    ["opt-out with a bad signature", "DELETE", "/optin", { wallet: w, nonce: goodN, signature: "1111" }],
  ];
  // A nonce issued to ANOTHER wallet, correctly signed by o1: must be stale_nonce.
  const otherN = await nonce(other);
  cases.push(["nonce of another wallet", "POST", "/optin", { wallet: w, zcashAddress: ua, nonce: otherN, signature: sign(o1, optinMessage(w, ua, otherN)) }]);
  const results: Record<string, string> = {};
  for (const [name, m, path, body, raw] of cases) {
    const r = await api(m, path, body, raw);
    results[name] = `${r.status} ${r.json?.error ?? r.text.slice(0, 40)}`;
    check(r.status >= 400 && r.status < 500 && typeof r.json?.error === "string" && r.json.error !== "internal_error", `hostile opt-in "${name}": ${r.status} ${r.text.slice(0, 80)}`);
    check(!r.text.includes(ua), `hostile opt-in "${name}" echoed the address`);
  }
  const after = (db.getDb().query("SELECT COUNT(*) AS n FROM optins").get() as { n: number }).n;
  check(after === before, `hostile opt-ins changed the optins table: ${before} -> ${after}`);
  facts.hostile = results;
}

async function main(): Promise<void> {
  if (existsSync(PAUSE)) rmSync(PAUSE);
  const keeper = loadKeeperKeypair();
  await airdrop(keeper.publicKey, 50);
  await ensureDbcConfig();
  const bank = Keypair.generate();
  await airdrop(bank.publicKey, 400);
  const creator = Keypair.generate();
  const honest = Array.from({ length: 30 }, () => Keypair.generate());
  const [O1, O2, O3, C1, R, ...rest] = honest as [Keypair, Keypair, Keypair, Keypair, Keypair, ...Keypair[]];
  const sniper = Keypair.generate();
  const dist = Keypair.generate();
  const traders = Array.from({ length: 12 }, () => Keypair.generate());
  // honest[0..14] buy on the curve (they own a ZEC account); honest[15..29] get tokens from `dist` and own NO ZEC account
  // (the keeper creates one only above the rent threshold); a PDA (off-curve) owner gets a large stack; 5 dust wallets
  // get 1-100 raw units.
  const buyers = honest.slice(0, 15);
  const receivers = honest.slice(15);
  const all = [creator, ...buyers, sniper, dist, ...traders];
  await fundSol(bank, [...all, ...receivers].map((k) => k.publicKey), 3);
  await mintZecTo(all.map((k) => k.publicKey), 10_000_000_000n); // 100 ZEC each (local test money)

  const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Stress Adv", symbol: "SADV", description: "stress", imageUrl: "", initialBuyZats: "20000000" });
  await confirmLaunch(await sendV0(txBase64, creator), mint);
  await waitForCoinWindow(mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  log("launched", mint);
  for (const [i, h] of buyers.entries()) await trade(h, mint, "buy", BigInt(i < 3 ? 50_000_000 : 10_000_000 + i * 500_000));
  await trade(dist, mint, "buy", 100_000_000n); // the curve migrates at 6.67 ZEC: everything here stays below it
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("stress-pda")], SystemProgram.programId);
  const dust = Array.from({ length: 5 }, () => Keypair.generate());
  const distBal = (await tokenBalancesByOwner(new PublicKey(mint), TOKEN_2022_PROGRAM_ID)).get(dist.publicKey.toBase58())!;
  await distributeTokens(dist, new PublicKey(mint), [
    { to: pda, raw: distBal / 4n },
    ...receivers.map((r, i) => ({ to: r.publicKey, raw: (distBal / 2n) * BigInt(10 + i) / 300n })),
    ...dust.map((d) => ({ to: d.publicKey, raw: BigInt(1 + Math.floor(Math.random() * 100)) })),
  ]);
  log("holders in place; pda", pda.toBase58());

  // Window samples: my own chain read right before each engine sample, no trade in between.
  const snaps: Snap[] = [];
  for (const off of [3000, 2000, 1000]) {
    snaps.push(await snap(mint));
    await takeSamplesNow(Date.now() - off);
  }
  // After the samples: the sniper buys a stack bigger than all the honest holders together; traders churn.
  await trade(sniper, mint, "buy", 150_000_000n);
  for (let r = 0; r < 4; r++) {
    for (const t of traders) await roundTrip(t, mint); // one at a time: the curve has little room left before migration
  }
  log("sniper + traders done");

  // Opt-ins over HTTP: O1, O2, O3 with real regtest addresses; then hostile, duplicate and replayed ones.
  const rec = makeRecipientWallets(join(STRESS_DIR, "zw-adv"), 3, 3);
  const bodies = [await optinBody(O1, rec[0]!.ua), await optinBody(O2, rec[1]!.ua), await optinBody(O3, rec[2]!.ua)];
  for (const b of bodies) check((await api("POST", "/optin", b)).status === 200, `opt-in ${b.wallet} refused`);
  await hostileOptins(O1, rec[0]!.ua, O2);
  const dup = await api("POST", "/optin", await optinBody(O1, rec[0]!.ua));
  const o1Rows = (db.getDb().query("SELECT COUNT(*) AS n, SUM(active) AS a FROM optins WHERE wallet = ?").get(O1.publicKey.toBase58()) as { n: number; a: number });
  check(dup.status === 200 && o1Rows.n === 1 && o1Rows.a === 1, `duplicate opt-in: ${dup.status}, rows ${o1Rows.n}, active ${o1Rows.a}`);
  const replay = await api("POST", "/optin", bodies[0]);
  check(replay.status === 400 && replay.json?.error === "stale_nonce", `replayed opt-in: ${replay.status} ${replay.text}`);
  facts.duplicate = { status: dup.status, rows: o1Rows.n }; facts.replay = `${replay.status} ${replay.json?.error}`;
  const opted = new Set([O1, O2, O3].map((k) => k.publicKey.toBase58()));
  const roles = new Map<string, string>([
    ...honest.map((k, i) => [k.publicKey.toBase58(), `honest${i}`] as [string, string]), ...traders.map((k, i) => [k.publicKey.toBase58(), `trader${i}`] as [string, string]),
    [sniper.publicKey.toBase58(), "sniper"], [dist.publicKey.toBase58(), "dist"], [creator.publicKey.toBase58(), "creator"], [pda.toBase58(), "pda"],
    ...dust.map((k, i) => [k.publicKey.toBase58(), `dust${i}`] as [string, string]),
  ]);
  roles.set(keeper.publicKey.toBase58(), "keeper");
  const role = (w: string) => roles.get(w) ?? w.slice(0, 8);

  // ---- epoch 1: plan, pause before money moves, attack, resume ----
  const preSnap = await snap(mint);
  const owners = [...preSnap.weights.keys(), pda.toBase58(), ...dust.map((d) => d.publicKey.toBase58())];
  const hadAta = await zecAtaBalances(owners);
  const zBefore = new Map<string, bigint>();
  syncRecipientWallet(rec[0]!.walletDir);
  for (const [i, k] of [O1, O2, O3].entries()) zBefore.set(k.publicKey.toBase58(), accountTotalZats(rec[i]!.walletDir, rec[i]!.account));
  const treasuryBefore = treasuryTotal();
  const claimBefore = await claimableCurve(mint);
  const keeperAta = getAssociatedTokenAddressSync(ZEC, keeper.publicKey, false, TOKEN_PROGRAM_ID);
  const keeperZecBefore = await direct.getTokenAccountBalance(keeperAta).then((b) => BigInt(b.value.amount)).catch(() => 0n);

  const swap = selectSwapAdapter();
  const r1 = await runEpoch(swap, async (id) => { await claimRemainingCoins(id); writeFileSync(PAUSE, "stress"); });
  check(!!r1.paused, `epoch run 1 was expected to stop at the pause, got ${JSON.stringify(r1).slice(0, 200)}`);
  const ep = db.listEpochs()[0]!; // newest first
  const planned = db.getPayouts(ep.id);
  check(planned.every((p) => !p.sentAt), "a payout was sent before the pause");
  log("epoch 1 planned", planned.length, "rows; attacking");
  // Attacks between planning and sending.
  const c1Ata = getAssociatedTokenAddressSync(ZEC, C1.publicKey, false, TOKEN_PROGRAM_ID);
  const rAta = getAssociatedTokenAddressSync(ZEC, R.publicKey, false, TOKEN_PROGRAM_ID);
  const thief = Keypair.generate();
  await moveAllZec(C1, thief.publicKey);
  await send(new Transaction().add(createCloseAccountInstruction(c1Ata, C1.publicKey, C1.publicKey, [], TOKEN_PROGRAM_ID)), [C1]);
  await moveAllZec(R, thief.publicKey);
  await send(new Transaction().add(createSetAuthorityInstruction(rAta, R.publicKey, AuthorityType.AccountOwner, thief.publicKey, [], TOKEN_PROGRAM_ID)), [R]);
  const on = await nonce(O3);
  const out = await api("DELETE", "/optin", { wallet: O3.publicKey.toBase58(), nonce: on, signature: sign(O3, optoutMessage(O3.publicKey.toBase58(), on)) });
  check(out.status === 200, `opt-out ${out.status} ${out.text}`);
  rmSync(PAUSE);
  const r2 = await runEpoch(swap);
  const e1 = db.getEpoch(ep.id)!;
  log("epoch 1 resumed:", e1.status, "attempts", e1.attempts);
  check(e1.status === "ok", `epoch 1 status ${e1.status}`);

  // Independent expectation. C1's own account was closed: it is a wallet with no account now (paid only above the rent
  // threshold, the keeper creating it). R's account belongs to someone else now: carried.
  const claimed1 = claimBefore - (await claimableCurve(mint));
  const hadNow = new Map(hadAta); hadNow.set(C1.publicKey.toBase58(), null);
  const x = expect1([...snaps, preSnap], claimed1, keeper.publicKey.toBase58(), opted, new Map(), hadNow, new Set([R.publicKey.toBase58()]), new Set());
  const after = await zecAtaBalances(owners);
  let solPaid = 0n;
  for (const o of owners) {
    if (opted.has(o) || o === keeper.publicKey.toBase58()) continue;
    const got = (after.get(o) ?? 0n)! - (o === C1.publicKey.toBase58() ? 0n : (hadAta.get(o) ?? 0n)!);
    const want = x.sol.get(o) ?? 0n;
    if (o === R.publicKey.toBase58()) { check((after.get(o) ?? 0n) === 0n, `reassigned account (emptied by the attack) now holds ${after.get(o)}`); continue; }
    check(got === want, `solana ${role(o)}: got ${got}, expected ${want}`);
    solPaid += got;
  }
  check(!x.share.has(pda.toBase58()) && (after.get(pda.toBase58()) ?? null) === null, "PDA owner was weighted or got a ZEC account");
  check(!x.share.has(sniper.publicKey.toBase58()) || x.share.get(sniper.publicKey.toBase58()) === 0n, "sniper has weight in my own model");
  check(!db.getPayouts(ep.id).some((p) => p.wallet === sniper.publicKey.toBase58()), "engine planned a payout for the sniper");
  for (const d of dust) {
    check((after.get(d.publicKey.toBase58()) ?? null) === null, `dust wallet ${d.publicKey.toBase58().slice(0, 8)} got a ZEC account (keeper rent)`);
    check((x.share.get(d.publicKey.toBase58()) ?? 0n) < DUST, "a dust wallet's share is not dust; pick smaller dust");
  }
  check(x.solCarry.has(R.publicKey.toBase58()), "R not carried in my model");
  check(db.getCarry(R.publicKey.toBase58(), "solana") === x.share.get(R.publicKey.toBase58()), `R carry in DB ${db.getCarry(R.publicKey.toBase58(), "solana")} != ${x.share.get(R.publicKey.toBase58())}`);
  syncRecipientWallet(rec[0]!.walletDir);
  let zPaid = 0n;
  for (const [i, k] of [O1, O2, O3].entries()) {
    const w = k.publicKey.toBase58();
    const got = accountTotalZats(rec[i]!.walletDir, rec[i]!.account) - zBefore.get(w)!;
    check(got === (x.zPaid.get(w) ?? 0n), `zcash ${w.slice(0, 8)}: got ${got}, expected ${x.zPaid.get(w) ?? 0n}`);
    zPaid += got;
  }
  // I1 and keeper conservation, I4 against the treasury wallet.
  const pot = claimed1 - x.team;
  const acc = solPaid + [...x.solCarry.values()].reduce((a, b) => a + b, 0n) + x.zTotal + [...x.zCarry.values()].reduce((a, b) => a + b, 0n);
  check(acc === pot, `I1 epoch 1: paid + carried + shielded ${acc} != holders' pot ${pot}`);
  const keeperZec1 = BigInt((await direct.getTokenAccountBalance(keeperAta)).value.amount);
  check(keeperZec1 === keeperZecBefore + claimed1 - solPaid - (x.zTotal > 0n ? x.zTotal + x.reserve : 0n), `keeper ZEC ${keeperZec1} != ${keeperZecBefore} + ${claimed1} - ${solPaid} - ${x.zTotal + x.reserve}`);
  const treasuryDelta = treasuryTotal() - treasuryBefore;
  check(treasuryDelta === x.settled - zPaid - x.fee, `treasury moved ${treasuryDelta}, expected ${x.settled - zPaid - x.fee}`);
  check(BigInt(e1.teamGrossZats ?? "-1") === x.team && BigInt(e1.deliveryReserveZats ?? "-1") === x.reserve && BigInt(e1.teamNativeZats ?? "-1") === treasuryDelta,
    `I4 epoch 1: engine team ${e1.teamGrossZats}/${e1.deliveryReserveZats}/${e1.teamNativeZats}, mine ${x.team}/${x.reserve}/${treasuryDelta}`);
  facts.epoch1 = { claimed: claimed1.toString(), holders: x.share.size, solanaPaid: x.sol.size, solanaCarried: x.solCarry.size, shieldedPaid: x.zPaid.size, zPaid: zPaid.toString(), r2: r2.epoch?.status };

  // ---- epoch 2: K (an account the keeper paid rent for in epoch 1) is emptied and closed; O3 is on Solana now ----
  const funded = owners.filter((o) => hadAta.get(o) == null && x.sol.has(o) && o !== C1.publicKey.toBase58());
  const K = honest.find((h) => funded.includes(h.publicKey.toBase58()));
  check(!!K, "no keeper-funded account to close in epoch 2");
  if (K) {
    await moveAllZec(K, thief.publicKey);
    await send(new Transaction().add(createCloseAccountInstruction(getAssociatedTokenAddressSync(ZEC, K.publicKey, false, TOKEN_PROGRAM_ID), K.publicKey, K.publicKey, [], TOKEN_PROGRAM_ID)), [K]);
  }
  for (const t of traders.slice(0, 6)) await roundTrip(t, mint);
  const pre2 = await snap(mint);
  const owners2 = [...new Set([...owners, ...pre2.weights.keys()])];
  const had2 = await zecAtaBalances(owners2);
  const claimB2 = await claimableCurve(mint);
  const kz2 = BigInt((await direct.getTokenAccountBalance(keeperAta)).value.amount);
  const o3z = accountTotalZats(rec[2]!.walletDir, rec[2]!.account);
  const r3 = await runEpoch(swap);
  const e2 = r3.epoch!;
  check(e2?.status === "ok", `epoch 2 status ${e2?.status}`);
  const claimed2 = claimB2 - (await claimableCurve(mint));
  const carryIn = new Map<string, bigint>([...x.solCarry, ...x.zCarry]);
  const opted2 = new Set([O1, O2].map((k) => k.publicKey.toBase58()));
  // No new samples in this window: the claim-time sample alone decides (PAD_SNAPSHOT_MIN_SAMPLES=0 locally).
  const y = expect1([pre2], claimed2, keeper.publicKey.toBase58(), opted2, carryIn, had2, new Set([R.publicKey.toBase58()]), new Set(K ? [K.publicKey.toBase58()] : []));
  const after2 = await zecAtaBalances(owners2);
  let sol2 = 0n;
  for (const o of owners2) {
    if (opted2.has(o) || o === R.publicKey.toBase58() || o === keeper.publicKey.toBase58()) continue; // the keeper is checked by conservation
    const got = (after2.get(o) ?? 0n)! - (had2.get(o) ?? 0n)!;
    check(got === (y.sol.get(o) ?? 0n), `epoch 2 solana ${role(o)}: got ${got}, expected ${y.sol.get(o) ?? 0n}`);
    sol2 += got;
  }
  if (K) {
    check((after2.get(K.publicKey.toBase58()) ?? null) === null, "keeper re-created (paid rent again for) the account K closed");
    check(db.getCarry(K.publicKey.toBase58(), "solana") === (y.share.get(K.publicKey.toBase58()) ?? 0n), "K's share not carried");
  }
  syncRecipientWallet(rec[0]!.walletDir);
  check(accountTotalZats(rec[2]!.walletDir, rec[2]!.account) === o3z, "O3 got a shielded payout after opting out");
  check((y.sol.get(O3.publicKey.toBase58()) ?? 0n) > 0n, "O3 has no Solana payout in epoch 2 in my model");
  const pot2 = claimed2 - y.team + [...carryIn.values()].reduce((a, b) => a + b, 0n);
  const acc2 = sol2 + [...y.solCarry.values()].reduce((a, b) => a + b, 0n) + y.zTotal + [...y.zCarry.values()].reduce((a, b) => a + b, 0n);
  check(acc2 === pot2, `I1 epoch 2: ${acc2} != ${pot2}`);
  const kz3 = BigInt((await direct.getTokenAccountBalance(keeperAta)).value.amount);
  check(kz3 === kz2 + claimed2 - sol2 - (y.zTotal > 0n ? y.zTotal + y.reserve : 0n), `keeper ZEC after epoch 2 ${kz3} != expected`);
  facts.epoch2 = { claimed: claimed2.toString(), solanaPaid: y.sol.size, carried: y.solCarry.size + y.zCarry.size, shieldedPlanned: y.zPlan.size, o3SolanaZats: (y.sol.get(O3.publicKey.toBase58()) ?? 0n).toString() };
  check(db.listEpochs().every((e) => e.status === "ok"), "an epoch is not ok");

  const result = { facts, problems };
  writeFileSync(join(STRESS_DIR, "adversarial-result.json"), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  console.log(problems.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${problems.length})`);
}

async function moveAllZec(owner: Keypair, to: PublicKey): Promise<void> {
  const ata = getAssociatedTokenAddressSync(ZEC, owner.publicKey, false, TOKEN_PROGRAM_ID);
  const bal = BigInt((await direct.getTokenAccountBalance(ata)).value.amount);
  if (bal === 0n) return;
  await mintZecTo([to], 0n);
  const dest = getAssociatedTokenAddressSync(ZEC, to, false, TOKEN_PROGRAM_ID);
  await send(new Transaction().add(createTransferCheckedInstruction(ata, ZEC, dest, owner.publicKey, bal, config.solana.dbc.quoteDecimals, [], TOKEN_PROGRAM_ID)), [owner]);
}

function treasuryTotal(): bigint {
  syncRecipientWallet(TREASURY_DIR);
  const p = Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "-w", TREASURY_DIR, "balance", "--json"], { env: { RUST_LOG: "warn", PATH: Bun.env.PATH ?? "" } });
  return BigInt((JSON.parse(new TextDecoder().decode(p.stdout)) as { total: number }).total);
}

main().then(() => process.exit(problems.length ? 1 : 0)).catch((e) => {
  console.error("adversarial run failed:", e);
  process.exit(2);
});
