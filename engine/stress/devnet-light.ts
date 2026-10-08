#!/usr/bin/env bun
// Scenario 6 (audit/STRESS-REPORT.md): one real epoch on Solana devnet + Zcash testnet with >=50 holders and 5 opted-in
// testnet wallets, checked against my own expectation from chain reads. Devnet only (refuses any other mode); test money
// only (the stand-in ZEC mint, test SOL, testnet TAZ). Its own DB (PAD_DB_FILE) with the existing devnet config
// (DBC_CONFIG_ID, a Squads vault as fee claimer: the stand-in owner key approves each claim, as scripts/devnet-epoch.ts).
// Devnet airdrops were failing (HTTP 500), so SOL is lent by the pad's devnet faucet key and returned at cleanup
// (token accounts are closed and their rent sent back).
//   PAD_DB_FILE=data/stress/devnet-light.sqlite scripts/devnet.sh bun stress/devnet-light.ts <setup|pre|epoch|post|cleanup|all>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createMintToCheckedInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { config } from "../src/config";
import * as db from "../src/db";
import { getConnection, getDbcClient } from "../src/solana";
import { loadFaucetKeypair } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx } from "../src/dbc/trade";
import { approveProposal, listActiveProposals } from "../src/dbc/squads";
import { optinMessage } from "../src/optin/message";
import { issueNonce, registerOptin } from "../src/optin/registry";
import { defaultUnifiedAddress, getBalance, initWallet, syncWallet } from "../src/zcash/devtool";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");
const conn = getConnection();
const ZEC = config.solana.dbc.quoteMint;
const STATE = join(config.paths.dataDir, "stress", "devnet-light.json");
const ZDIR = join(config.paths.dataDir, "stress", "zw-testnet");
const N_HOLDERS = 50, N_OPT = 5, N_WITH_ZEC = 15;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const kp = (s: string) => Keypair.fromSecretKey(bs58.decode(s));
const sk = (k: Keypair) => bs58.encode(k.secretKey);
const problems: string[] = [];

interface State {
  creator: string; dist: string; holders: string[]; opted: { key: string; dir: string; id: string; ua: string }[];
  mint?: string; pre?: { weights: Record<string, string>; zec: Record<string, string | null>; claimable: string; zcash: Record<string, string>; keeperZec: string; treasury: string };
  lent?: number;
}
const load = (): State => JSON.parse(readFileSync(STATE, "utf8"));
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 1), { mode: 0o600 });

async function sendTx(tx: Transaction | VersionedTransaction, signers: Keypair[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      let raw: Uint8Array;
      let sig: string;
      if (tx instanceof Transaction) {
        tx.feePayer = tx.feePayer ?? signers[0]!.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
        tx.signatures = [];
        tx.sign(...signers);
        raw = tx.serialize();
        sig = bs58.encode(tx.signature!);
      } else {
        tx.sign(signers);
        raw = tx.serialize();
        sig = bs58.encode(tx.signatures[0]!);
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await conn.sendRawTransaction(raw, { skipPreflight: attempt > 0, maxRetries: 0 }).catch((e) => { if (attempt === 0 && !/already been processed/.test(String(e))) throw e; });
        await Bun.sleep(2000);
        const st = (await conn.getSignatureStatuses([sig])).value[0];
        if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
      }
      throw new Error(`tx ${sig} did not land`);
    } catch (e) {
      if (attempt >= 3 || /failed:/.test(String(e)) || tx instanceof VersionedTransaction) throw e;
      log("retrying a transaction:", String(e).slice(0, 120));
    }
  }
}

async function trade(k: Keypair, mint: string, side: "buy" | "sell", amount: bigint): Promise<void> {
  const { txBase64 } = await buildTradeTx({ wallet: k.publicKey.toBase58(), mint, side, amount: amount.toString(), slippageBps: 1000 });
  await sendTx(VersionedTransaction.deserialize(Buffer.from(txBase64, "base64")), [k]);
}

async function tokenBalances(mint: PublicKey, program: PublicKey): Promise<Map<string, bigint>> {
  const accts = await conn.getProgramAccounts(program, { filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }] });
  const out = new Map<string, bigint>();
  for (const { pubkey, account } of accts) {
    const a = unpackAccount(pubkey, account, program);
    out.set(a.owner.toBase58(), (out.get(a.owner.toBase58()) ?? 0n) + a.amount);
  }
  return out;
}
async function zecBalances(owners: string[]): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  for (let i = 0; i < owners.length; i += 100) {
    const slice = owners.slice(i, i + 100);
    const atas = slice.map((o) => getAssociatedTokenAddressSync(ZEC, new PublicKey(o), true, TOKEN_PROGRAM_ID));
    const infos = await conn.getMultipleAccountsInfo(atas, "confirmed");
    slice.forEach((o, j) => out.set(o, infos[j] ? unpackAccount(atas[j]!, infos[j]!, TOKEN_PROGRAM_ID).amount : null));
  }
  return out;
}
async function claimable(mint: string): Promise<bigint> {
  const p = await getDbcClient().state.getPoolByBaseMint(new PublicKey(mint));
  return BigInt((await getDbcClient().state.getPoolFeeMetrics(p!.publicKey)).current.partnerQuoteFee.toString());
}
const zcashTotal = (dir: string) => { syncWallet(dir); return getBalance(dir).totalZats; };

async function setup(): Promise<void> {
  if (!existsSync(STATE)) {
    save({ creator: sk(Keypair.generate()), dist: sk(Keypair.generate()), holders: Array.from({ length: N_HOLDERS }, () => sk(Keypair.generate())), opted: [] });
  }
  const s = load();
  const faucet = loadFaucetKeypair();
  const creator = kp(s.creator), dist = kp(s.dist);
  await ensureDbcConfig();
  if (!s.lent) {
    // SOL lent by the faucet key (returned at cleanup): launch + first buy, 55 base-token accounts, 40 ZEC accounts.
    // The creator's SOL comes from the owner's test wallet (~/.config/solana/id.json, allowed for test-network fees).
    const testWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
    await sendTx(new Transaction().add(SystemProgram.transfer({ fromPubkey: testWallet.publicKey, toPubkey: creator.publicKey, lamports: 25_000_000 })), [testWallet]);
    await sendTx(new Transaction().add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: dist.publicKey, lamports: 150_000_000 })), [faucet]);
    s.lent = 0.175;
    save(s);
    const mintTx = new Transaction();
    for (const [k, zats] of [[creator, 30_000_000n], [dist, 1_200_000_000n]] as [Keypair, bigint][]) {
      const ata = getAssociatedTokenAddressSync(ZEC, k.publicKey, false, TOKEN_PROGRAM_ID);
      mintTx.add(createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, ata, k.publicKey, ZEC, TOKEN_PROGRAM_ID));
      mintTx.add(createMintToCheckedInstruction(ZEC, ata, faucet.publicKey, zats, config.solana.dbc.quoteDecimals, [], TOKEN_PROGRAM_ID));
    }
    await sendTx(mintTx, [faucet]);
    log("lent 0.15 SOL from the faucet key and 0.025 from the test wallet; minted stand-in ZEC");
  }
  if (!s.mint) {
    const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Stress Devnet", symbol: "SDEV", description: "stress test, devnet", imageUrl: "", initialBuyZats: "20000000" });
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
    await confirmLaunch(await sendTx(tx, [creator]), mint);
    await waitForCoinWindow(mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
    s.mint = mint;
    save(s);
    log("launched", mint);
    // The distributor buys 4.5 stand-in ZEC (the curve migrates at 6.67), then 8 round trips of 1 ZEC for fees.
    await trade(dist, mint, "buy", 450_000_000n);
    for (let i = 0; i < 8; i++) {
      const before = (await tokenBalances(new PublicKey(mint), TOKEN_2022_PROGRAM_ID)).get(dist.publicKey.toBase58()) ?? 0n;
      await trade(dist, mint, "buy", 100_000_000n);
      const after = (await tokenBalances(new PublicKey(mint), TOKEN_2022_PROGRAM_ID)).get(dist.publicKey.toBase58()) ?? 0n;
      await trade(dist, mint, "sell", after - before);
    }
    log("trades done");
  }
  const mint = new PublicKey(s.mint);
  // 5 fresh Zcash testnet wallets (birthday at the tip), opted in with a real signature each.
  mkdirSync(ZDIR, { recursive: true, mode: 0o700 });
  for (let i = s.opted.length; i < N_OPT; i++) {
    const dir = join(ZDIR, `o${i}`), id = join(ZDIR, `o${i}.age`);
    initWallet(dir, `o${i}`, id);
    s.opted.push({ key: sk(Keypair.generate()), dir, id, ua: defaultUnifiedAddress(dir) });
    save(s);
  }
  for (const o of s.opted) {
    const k = kp(o.key), w = k.publicKey.toBase58();
    if (db.getOptin(w)?.active) continue;
    const { nonce } = issueNonce(w);
    const r = registerOptin(w, o.ua, nonce, bs58.encode(nacl.sign.detached(new TextEncoder().encode(optinMessage(w, o.ua, nonce)), k.secretKey)));
    if (!r.ok) throw new Error(`opt-in ${r.error}`);
  }
  // Tokens to 50 holders (random weights) and the 5 opted-in (larger); the first 40 holders also get an empty ZEC account.
  const have = await tokenBalances(mint, TOKEN_2022_PROGRAM_ID);
  const holders = s.holders.map(kp);
  const opted = s.opted.map((o) => kp(o.key));
  const todo = [...holders.map((h) => ({ k: h, units: 1 + Math.random() * 3 })), ...opted.map((k) => ({ k, units: 12 }))].filter((x) => !have.get(x.k.publicKey.toBase58()));
  if (todo.length) {
    const distBal = have.get(dist.publicKey.toBase58())!;
    const units = todo.reduce((a, x) => a + x.units, 0);
    const unit = (distBal * 7n) / 10n / BigInt(Math.ceil(units)); // 70% of what is left goes out; the distributor keeps the rest
    const src = getAssociatedTokenAddressSync(mint, dist.publicKey, false, TOKEN_2022_PROGRAM_ID);
    for (let i = 0; i < todo.length; i += 6) {
      const tx = new Transaction();
      for (const x of todo.slice(i, i + 6)) {
        const dest = getAssociatedTokenAddressSync(mint, x.k.publicKey, false, TOKEN_2022_PROGRAM_ID);
        tx.add(createAssociatedTokenAccountIdempotentInstruction(dist.publicKey, dest, x.k.publicKey, mint, TOKEN_2022_PROGRAM_ID));
        tx.add(createTransferCheckedInstruction(src, mint, dest, dist.publicKey, BigInt(Math.floor(Number(unit) * x.units)), config.solana.dbc.baseDecimals, [], TOKEN_2022_PROGRAM_ID));
      }
      await sendTx(tx, [dist]);
    }
  }
  const zec = await zecBalances(s.holders.slice(0, N_WITH_ZEC).map((h) => kp(h).publicKey.toBase58()));
  const need = holders.slice(0, N_WITH_ZEC).filter((h) => zec.get(h.publicKey.toBase58()) == null);
  for (let i = 0; i < need.length; i += 10) {
    const tx = new Transaction();
    for (const h of need.slice(i, i + 10)) tx.add(createAssociatedTokenAccountIdempotentInstruction(dist.publicKey, getAssociatedTokenAddressSync(ZEC, h.publicKey, false, TOKEN_PROGRAM_ID), h.publicKey, ZEC, TOKEN_PROGRAM_ID));
    await sendTx(tx, [dist]);
  }
  log("setup done:", N_HOLDERS, "holders,", N_OPT, "opted in,", N_WITH_ZEC, "with a ZEC account");
}

async function pre(): Promise<void> {
  const s = load();
  const w = await tokenBalances(new PublicKey(s.mint!), TOKEN_2022_PROGRAM_ID);
  const zec = await zecBalances([...w.keys()]);
  const zcash: Record<string, string> = {};
  for (const o of s.opted) zcash[kp(o.key).publicKey.toBase58()] = zcashTotal(o.dir).toString();
  const keeperAta = getAssociatedTokenAddressSync(ZEC, loadKeeperKeypair().publicKey, false, TOKEN_PROGRAM_ID);
  s.pre = {
    weights: Object.fromEntries([...w].map(([o, b]) => [o, b.toString()])), zec: Object.fromEntries([...zec].map(([o, b]) => [o, b === null ? null : b.toString()])),
    claimable: (await claimable(s.mint!)).toString(), zcash,
    keeperZec: (await conn.getTokenAccountBalance(keeperAta).catch(() => ({ value: { amount: "0" } }))).value.amount,
    treasury: zcashTotal(process.env.TREASURY_WALLET_DIR!).toString(),
  };
  save(s);
  log("pre: owners", w.size, "claimable", s.pre.claimable, "keeper ZEC", s.pre.keeperZec);
}

async function epoch(): Promise<void> {
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEVNET_OWNER_KEYPAIR!, "utf8"))));
  for (let i = 1; i <= 60; i++) {
    const r = Bun.spawnSync(["bun", "scripts/epoch.ts"], { env: process.env });
    const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    const line = out.split("\n").find((l) => /^(epoch |no fees|epoch waiting|paused|no new epoch|epoch run failed)/.test(l)) ?? "";
    log(`run ${i}:`, line.slice(0, 200));
    if (/^epoch \S+ status ok/m.test(out)) return;
    if (/epoch waiting/.test(out)) {
      for (const p of await listActiveProposals(conn, config.solana.dbc.squadsMultisig!)) {
        await approveProposal(conn, config.solana.dbc.squadsMultisig!, p.index, owner).then(() => log("approved proposal", p.index)).catch((e) => log("approve failed", String(e).slice(0, 120)));
      }
      continue;
    }
    await Bun.sleep(60_000);
  }
  throw new Error("epoch not ok after 60 runs");
}

async function post(): Promise<void> {
  const s = load();
  const P = s.pre!;
  const keeper = loadKeeperKeypair().publicKey.toBase58();
  const exclude = new Set([keeper, ...(JSON.parse(db.getMeta("squads_members") ?? "[]") as string[])]);
  const claimed = BigInt(P.claimable) - (await claimable(s.mint!));
  const team = (claimed * 2500n) / 10_000n;
  const ws = Object.entries(P.weights).filter(([o, b]) => BigInt(b) > 0n && !exclude.has(o) && PublicKey.isOnCurve(new PublicKey(o).toBytes())).map(([id, b]) => ({ id, w: BigInt(b) }));
  const sum = ws.reduce((a, x) => a + x.w, 0n);
  const pot = claimed - team;
  const parts = ws.map((x, idx) => ({ id: x.id, idx, base: (pot * x.w) / sum, rem: (pot * x.w) % sum }));
  let left = pot - parts.reduce((a, p) => a + p.base, 0n);
  const share = new Map(parts.map((p) => [p.id, p.base]));
  for (const p of [...parts].sort((a, b) => (a.rem === b.rem ? a.idx - b.idx : a.rem > b.rem ? -1 : 1))) { if (left === 0n) break; share.set(p.id, share.get(p.id)! + 1n); left--; }
  const opted = new Set(s.opted.map((o) => kp(o.key).publicKey.toBase58()));
  // ZCASH_ONLY=1: a re-check of the testnet notes after they were mined, once cleanup has emptied the Solana accounts
  // (the Solana receipts and the keeper conservation were checked by the first post run, before cleanup).
  const zOnly = Bun.env.ZCASH_ONLY === "1";
  const after = await zecBalances([...share.keys()]);
  let solPaid = 0n, paidN = 0, carriedN = 0;
  for (const [w, a] of share) {
    if (opted.has(w) || zOnly) continue;
    const had = P.zec[w] ?? null;
    const want = a >= 5_000n && (had !== null || a > 30_000n) ? a : 0n;
    const got = (after.get(w) ?? 0n)! - BigInt(had ?? "0");
    if (got !== want) problems.push(`devnet ${w.slice(0, 8)}: got ${got}, expected ${want}`);
    solPaid += got;
    want > 0n ? paidN++ : carriedN++;
  }
  // Shielded: per-holder >= 100k, total >= 1M, reserve, the simulated testnet swap (25 bps + 32,000), one tx (5 outputs).
  const send = [...opted].map((w) => ({ id: w, w: share.get(w) ?? 0n })).filter((x) => x.w >= 100_000n);
  const total = send.reduce((a, x) => a + x.w, 0n);
  const n = BigInt(send.length);
  const expectZ = new Map<string, bigint>();
  let reserve = 0n, settled = 0n;
  if (total >= 1_000_000n) {
    const est = 32_000n + 5000n * (n + 1n) + (total * 100n + 9_999n) / 10_000n;
    reserve = est < team ? est : team;
    settled = ((total + reserve) * 9_975n) / 10_000n - 32_000n;
    const avail = settled - 5000n * (n + 1n);
    const paid = avail < total ? avail : total;
    const tot = send.reduce((a, x) => a + x.w, 0n);
    const ps = send.map((x, idx) => ({ id: x.id, idx, base: (paid * x.w) / tot, rem: (paid * x.w) % tot }));
    let l = paid - ps.reduce((a, p) => a + p.base, 0n);
    for (const p of ps) expectZ.set(p.id, p.base);
    for (const p of [...ps].sort((a, b) => (a.rem === b.rem ? a.idx - b.idx : a.rem > b.rem ? -1 : 1))) { if (l === 0n) break; expectZ.set(p.id, expectZ.get(p.id)! + 1n); l--; }
  }
  const notes: string[] = [];
  for (const o of s.opted) {
    const w = kp(o.key).publicKey.toBase58();
    const got = zcashTotal(o.dir) - BigInt(P.zcash[w]!);
    if (got !== (expectZ.get(w) ?? 0n)) problems.push(`testnet wallet ${w.slice(0, 8)}: got ${got}, expected ${expectZ.get(w) ?? 0n}`);
    notes.push(`${got}`);
  }
  const keeperAta = getAssociatedTokenAddressSync(ZEC, new PublicKey(keeper), false, TOKEN_PROGRAM_ID);
  const kz = BigInt((await conn.getTokenAccountBalance(keeperAta)).value.amount);
  const kWant = BigInt(P.keeperZec) + claimed - solPaid - (total >= 1_000_000n ? total + reserve : 0n);
  if (kz !== kWant && !zOnly) problems.push(`keeper stand-in ZEC ${kz} != ${kWant}`);
  const e = db.listEpochs()[0]!;
  if (e.status !== "ok") problems.push(`epoch status ${e.status}`);
  const result = { epoch: e.id, zcashTxids: e.zcashTxids, claimed: claimed.toString(), holdersWithShare: share.size, solanaPaid: paidN, solanaCarried: carriedN, shieldedNotes: notes, problems };
  writeFileSync(join(config.paths.dataDir, "stress", zOnly ? "devnet-light-zcash-result.json" : "devnet-light-result.json"), JSON.stringify(result, null, 1));
  log(JSON.stringify(result));
  log(problems.length ? `RESULT: FAIL (${problems.length})` : "RESULT: PASS");
}

/** Returns the lent SOL: holders' base-token and ZEC accounts are emptied into the distributor and closed, rent to the faucet key. */
async function cleanup(): Promise<void> {
  const s = load();
  const faucet = loadFaucetKeypair();
  const mint = new PublicKey(s.mint!);
  const dist = kp(s.dist);
  const distBase = getAssociatedTokenAddressSync(mint, dist.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const distZec = getAssociatedTokenAddressSync(ZEC, dist.publicKey, false, TOKEN_PROGRAM_ID);
  const keeper = loadKeeperKeypair().publicKey;
  const distFunded = new Set(s.holders.slice(0, N_WITH_ZEC));
  for (const k of [...s.holders.map(kp), ...s.opted.map((o) => kp(o.key))]) {
    const zecRentTo = distFunded.has(sk(k)) ? faucet.publicKey : keeper; // the keeper paid the rent of accounts it created
    const tx = new Transaction();
    const base = getAssociatedTokenAddressSync(mint, k.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const zec = getAssociatedTokenAddressSync(ZEC, k.publicKey, false, TOKEN_PROGRAM_ID);
    const [bi, zi] = await conn.getMultipleAccountsInfo([base, zec]);
    if (bi) {
      const amt = unpackAccount(base, bi, TOKEN_2022_PROGRAM_ID).amount;
      if (amt > 0n) tx.add(createTransferCheckedInstruction(base, mint, distBase, k.publicKey, amt, config.solana.dbc.baseDecimals, [], TOKEN_2022_PROGRAM_ID));
      tx.add(createCloseAccountInstruction(base, faucet.publicKey, k.publicKey, [], TOKEN_2022_PROGRAM_ID));
    }
    if (zi) {
      const amt = unpackAccount(zec, zi, TOKEN_PROGRAM_ID).amount;
      if (amt > 0n) tx.add(createTransferCheckedInstruction(zec, ZEC, distZec, k.publicKey, amt, config.solana.dbc.quoteDecimals, [], TOKEN_PROGRAM_ID));
      tx.add(createCloseAccountInstruction(zec, zecRentTo, k.publicKey, [], TOKEN_PROGRAM_ID));
    }
    if (tx.instructions.length) {
      tx.feePayer = dist.publicKey;
      await sendTx(tx, [dist, k]);
    }
  }
  const testWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")))).publicKey;
  for (const [k, to] of [[dist, faucet.publicKey], [kp(s.creator), testWallet]] as [Keypair, PublicKey][]) {
    const bal = await conn.getBalance(k.publicKey);
    if (bal > 10_000) await sendTx(new Transaction().add(SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: to, lamports: bal - 5000 })), [k]);
  }
  log("cleanup done; faucet balance", (await conn.getBalance(faucet.publicKey)) / 1e9, "SOL");
}

const phase = process.argv[2] ?? "all";
const phases: Record<string, () => Promise<void>> = { setup, pre, epoch, post, cleanup };
for (const p of phase === "all" ? ["setup", "pre", "epoch", "post", "cleanup"] : [phase]) {
  log("=== phase", p);
  await phases[p]!();
}
process.exit(problems.length ? 1 : 0);
