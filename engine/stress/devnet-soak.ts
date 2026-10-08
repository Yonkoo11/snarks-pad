#!/usr/bin/env bun
// Scenario 4 (audit/STRESS-REPORT.md), redone on the server: the systemd keeper (snarks-keeper.service, epochs every
// 10 min through a drop-in) on Solana devnet + Zcash testnet, continuous random trades on two soak coins, the stand-in
// owner key approving each Squads claim (as scripts/devnet-epoch.ts), and a reconciliation from chain reads after
// every epoch that finishes. The keeper kills and the per-minute RSS/FD/log/DB samples come from
// stress/devnet-soak-driver.sh (root: systemctl kill). Devnet only, test money only. Run on the server as the service
// user through ops/svc-run.sh:
//   init                 makes 3 trader + 6 holder wallets (data/stress/devnet-soak-wallets.json, 0600), prints their keys' addresses
//   setup                (after the wallets hold SOL) mints test ZEC to them; each holder buys both soak coins once
//   run                  SOAK_MINUTES (default 125) of trades + approvals + per-epoch reconciliation, then finishes in-flight epochs
//   reconcile            the reconciliation alone
// Reconciliation (from chain, against the DB rows confirmed or sent after `run` started; stress/soak-ledger.ts):
//  - the keeper's stand-in ZEC moved by exactly claimed - payouts sent on Solana - simulated-swap input;
//  - every holder wallet (they never trade after setup) moved by exactly the Solana payouts the DB says it was sent;
//  - no payout row unsent and no epoch parked once nothing is in flight.
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { buildTradeTx } from "../src/dbc/trade";
import { listActiveProposals } from "../src/dbc/squads";
import { loadFaucetKeypair } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { isQuiet, ledgerSince, snapshotLedger, type LedgerBefore } from "./soak-ledger";

if (config.mode !== "devnet") throw new Error("devnet only");
const MIN = 60_000;
const DIR = join(config.paths.dataDir, "stress");
mkdirSync(DIR, { recursive: true, mode: 0o770 });
const WFILE = join(DIR, "devnet-soak-wallets.json");
const START = join(DIR, "devnet-soak-start.json");
const LOG = join(DIR, "devnet-soak.log");
const conn = getConnection();
const ZEC = config.solana.dbc.quoteMint;
const DB_FILE = process.env.PAD_DB_FILE!;
const t0 = Date.now();
const log = (...a: unknown[]) => {
  const line = `${new Date().toISOString()} ${a.map(String).join(" ")}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};
type Wallets = { traders: string[]; holders: string[]; coins: string[] };
const kp = (s: string) => Keypair.fromSecretKey(bs58.decode(s));
const W = (): Wallets => JSON.parse(readFileSync(WFILE, "utf8"));
let zecProgram: PublicKey | null = null;
async function zecAta(owner: PublicKey): Promise<PublicKey> {
  zecProgram ??= (await conn.getAccountInfo(ZEC))!.owner;
  return getAssociatedTokenAddressSync(ZEC, owner, true, zecProgram);
}
async function zecBalance(owner: PublicKey): Promise<bigint> {
  const r = await conn.getTokenAccountBalance(await zecAta(owner), "confirmed").catch(() => null);
  return BigInt(r?.value.amount ?? "0");
}
async function tokenBalance(owner: PublicKey, mint: string): Promise<bigint> {
  const r = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "confirmed");
  return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}
async function sendSigned(tx: VersionedTransaction | Transaction): Promise<string> {
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  const bh = await conn.getLatestBlockhash("confirmed");
  const r = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (r.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}
async function trade(w: Keypair, mint: string, side: "buy" | "sell", amount: bigint): Promise<string> {
  const { txBase64 } = await buildTradeTx({ wallet: w.publicKey.toBase58(), mint, side, amount: amount.toString(), slippageBps: 2000 });
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([w]);
  return sendSigned(tx);
}
async function mintZec(to: PublicKey, zats: bigint, payer: Keypair): Promise<void> {
  const faucet = loadFaucetKeypair(); // the stand-in mint's authority (test-only key)
  const ata = await zecAta(to);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, to, ZEC, zecProgram!),
    createMintToInstruction(ZEC, ata, faucet.publicKey, zats, [], zecProgram!),
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, faucet);
  await sendSigned(tx);
}

// ---- reconciliation
type Start = { at: string; keeperZec: string; holders: Record<string, string>; epochsBefore: string[] } & LedgerBefore;
async function reconcile(final: boolean): Promise<{ ok: boolean; epochs: number; problems: string[]; inFlight: boolean }> {
  const s = JSON.parse(readFileSync(START, "utf8")) as Start;
  const d = new Database(DB_FILE, { readonly: true });
  const before = new Set(s.epochsBefore);
  const epochs = (d.query("SELECT id, status, attempts, swapRef FROM epochs").all() as { id: string; status: string; attempts: number; swapRef: string | null }[]).filter((e) => !before.has(e.id));
  if (!s.claimsBefore) throw new Error("start snapshot without the ledger sets (made by an older harness)");
  const { claimed, sent, unsent, swapped } = ledgerSince(d, s);
  d.close();
  // An epoch is "ok" from planning on (finalizeHarvest), before its legs send: unsent rows mean it is still running.
  // Run 3 (2026-10-04) read epoch 5 mid-leg, 6 rows unsent, and logged FAIL; all 6 were sent 33 s later.
  const inFlight = unsent > 0 || epochs.some((e) => !["ok", "fallback_solana", "needs_attention"].includes(e.status));
  const problems: string[] = [];
  const onSolana = sent.filter((p) => p.kind !== "shielded" || p.sig.startsWith("fallback_solana:"));
  const paid = onSolana.reduce((a, p) => a + BigInt(p.amountZats), 0n);
  const keeperNow = await zecBalance(loadKeeperKeypair().publicKey);
  const moved = keeperNow - BigInt(s.keeperZec);
  if (moved !== claimed - paid - swapped) problems.push(`keeper ZEC moved ${moved}; DB: claimed ${claimed} - sent ${paid} - swapped ${swapped} = ${claimed - paid - swapped}`);
  const per = new Map<string, bigint>();
  for (const p of onSolana) per.set(p.wallet, (per.get(p.wallet) ?? 0n) + BigInt(p.amountZats));
  for (const h of Object.keys(s.holders)) {
    const got = (await zecBalance(new PublicKey(h))) - BigInt(s.holders[h]!);
    if (got !== (per.get(h) ?? 0n)) problems.push(`holder ${h.slice(0, 8)}: chain moved ${got}, DB sent ${per.get(h) ?? 0n}`);
  }
  if (unsent) problems.push(`${unsent} payout rows unsent`);
  for (const e of epochs) if (e.status === "needs_attention" || (final && !["ok", "fallback_solana"].includes(e.status))) problems.push(`epoch ${e.id} ${e.status}`);
  const rec = { at: new Date().toISOString(), final, epochs: epochs.length, statuses: epochs.map((e) => `${e.status}/${e.attempts}`), claimed: claimed.toString(), paidSolana: paid.toString(), swapped: swapped.toString(), payoutsSent: sent.length, problems };
  appendFileSync(join(DIR, "devnet-soak-reconcile.jsonl"), JSON.stringify(rec) + "\n");
  return { ok: problems.length === 0, epochs: epochs.length, problems, inFlight };
}

async function approveWaiting(): Promise<void> {
  for (const p of await listActiveProposals(conn, config.solana.dbc.squadsMultisig!)) {
    const r = Bun.spawnSync([process.execPath, "scripts/squads-proposals.ts", "approve", String(p.index), process.env.DEVNET_OWNER_KEYPAIR!], { cwd: config.paths.engineRoot, env: process.env });
    log(`approve proposal ${p.index}: exit ${r.exitCode}`, new TextDecoder().decode(r.stdout).trim().split("\n").slice(-2).join(" | "));
  }
}

const cmd = process.argv[2];
if (cmd === "init") {
  if (existsSync(WFILE)) throw new Error(`${WFILE} exists`);
  const make = (n: number) => Array.from({ length: n }, () => bs58.encode(Keypair.generate().secretKey));
  writeFileSync(WFILE, JSON.stringify({ traders: make(3), holders: make(6), coins: [] }), { mode: 0o600 });
  const w = W();
  console.log(JSON.stringify({ traders: w.traders.map((s) => kp(s).publicKey.toBase58()), holders: w.holders.map((s) => kp(s).publicKey.toBase58()) }));
} else if (cmd === "setup") {
  const w = W();
  const res = await fetch(`http://127.0.0.1:${config.api.port}/api/coins`).then((r) => r.json()) as { coins: { mint: string; symbol: string; stage: string; feeBps: number; curveProgress: number }[] };
  w.coins = res.coins.filter((c) => c.stage === "curve" && c.feeBps === 100 && c.symbol !== "SNARKS").sort((a, b) => a.curveProgress - b.curveProgress).slice(0, 2).map((c) => c.mint);
  writeFileSync(WFILE, JSON.stringify(w), { mode: 0o600 });
  log("soak coins", w.coins.join(","));
  for (const t of w.traders) await mintZec(kp(t).publicKey, 3_000_000_000n, kp(t));
  for (const h of w.holders) {
    await mintZec(kp(h).publicKey, 100_000_000n, kp(h));
    for (const m of w.coins) log("holder buy", kp(h).publicKey.toBase58().slice(0, 6), await trade(kp(h), m, "buy", 30_000_000n));
  }
  log("setup done");
} else if (cmd === "run") {
  const w = W();
  const total = Number(process.env.SOAK_MINUTES ?? 125) * MIN;
  if (!existsSync(START)) {
    // Snapshot only when nothing is in flight (a claim awaiting approval, an unsent payout, an unfinished epoch):
    // attempt 1 started next to a draft whose claims landed after the snapshot (stress/soak-ledger.ts).
    const quietBy = Date.now() + 20 * MIN;
    for (;;) {
      await approveWaiting().catch((e) => log("approve error", String((e as Error).message).slice(0, 200)));
      const d = new Database(DB_FILE, { readonly: true });
      const quiet = isQuiet(d);
      d.close();
      if (quiet) break;
      if (Date.now() > quietBy) throw new Error("keeper not quiet after 20 min; no start snapshot taken");
      log("waiting for the keeper to be quiet before the start snapshot");
      await Bun.sleep(30_000);
    }
    const d = new Database(DB_FILE, { readonly: true });
    const epochsBefore = (d.query("SELECT id FROM epochs").all() as { id: string }[]).map((r) => r.id);
    const ledger = snapshotLedger(d);
    d.close();
    const holders: Record<string, string> = {};
    for (const h of w.holders) holders[kp(h).publicKey.toBase58()] = (await zecBalance(kp(h).publicKey)).toString();
    writeFileSync(START, JSON.stringify({ at: new Date().toISOString(), keeperZec: (await zecBalance(loadKeeperKeypair().publicKey)).toString(), holders, epochsBefore, ...ledger } satisfies Start));
  }
  log("soak run start", total / MIN, "min; coins", w.coins.join(","));
  let landed = 0, failed = 0;
  const until = t0 + total - 10 * MIN; // trades stop 10 min before the end, like scenario 4
  const traders = w.traders.map((t) => (async () => {
    const k = kp(t);
    while (Date.now() < until) {
      const mint = w.coins[Math.floor(Math.random() * w.coins.length)]!;
      try {
        if ((await zecBalance(k.publicKey)) < 500_000_000n) await mintZec(k.publicKey, 2_000_000_000n, k);
        await trade(k, mint, "buy", BigInt(Math.floor(5e6 + Math.random() * 25e6)));
        landed++;
        await Bun.sleep(Math.random() * 20_000); // sometimes holds across a holder sample
        const b = await tokenBalance(k.publicKey, mint);
        if (b > 0n) { await trade(k, mint, "sell", b); landed++; }
      } catch (e) {
        failed++;
        if (failed % 10 === 1) log("trade error", String((e as Error).message).slice(0, 200));
      }
      await Bun.sleep(3_000 + Math.random() * 10_000);
    }
  })());
  let reconciledEpochs = -1;
  const loopEnd = t0 + total + 40 * MIN; // after the trades stop, up to 40 more minutes for in-flight epochs
  while (Date.now() < loopEnd) {
    await approveWaiting().catch((e) => log("approve error", String((e as Error).message).slice(0, 200)));
    const r = await reconcile(false).catch((e) => ({ ok: false, epochs: -1, problems: [String(e)], inFlight: true }));
    if (!r.inFlight && r.epochs !== reconciledEpochs) {
      reconciledEpochs = r.epochs;
      log(`reconcile after ${r.epochs} soak epochs: ${r.ok ? "PASS" : "FAIL " + r.problems.join("; ")}; trades landed ${landed} failed ${failed}`);
    }
    if (Date.now() > t0 + total && !r.inFlight) break;
    await Bun.sleep(30_000);
  }
  await Promise.all(traders);
  const fin = await reconcile(true);
  const out = { minutes: +((Date.now() - t0) / MIN).toFixed(1), tradesLanded: landed, tradesFailed: failed, ...fin };
  writeFileSync(join(DIR, "devnet-soak-result.json"), JSON.stringify(out, null, 1));
  log("RESULT", JSON.stringify(out));
  process.exit(0);
} else if (cmd === "reconcile") {
  console.log(JSON.stringify(await reconcile(true)));
  process.exit(0);
} else {
  console.error("usage: devnet-soak.ts init|setup|run|reconcile");
  process.exit(2);
}
