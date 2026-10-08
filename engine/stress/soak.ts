#!/usr/bin/env bun
// Scenario 4 (audit/STRESS-REPORT.md): the real keeper loop (`bun scripts/keeper.ts`) for SOAK_MINUTES (default 125) on
// the local chain with continuous random trades, 3 SIGKILLs at random moments (restarted 5 s later), a sample of the
// keeper's RSS / open files / log and DB sizes every minute, then a reconciliation from chain reads against the DB:
//  - the keeper's ZEC moved by exactly (sum of claims that landed) - (sum of payouts marked sent);
//  - every non-trading holder's ZEC moved by exactly the sum of the payouts the DB says it was sent;
//  - every epoch finished, none parked, no row left unsent.
// Epochs are Solana-only here (PAD_SHIELDED_EVERY_DAYS=999): the Zcash treasury is shared with the chaos run, whose
// checks read its balance. Run from engine/ with the soak environment (see the report for the exact variables).
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { STRESS_DIR, ZEC, direct, zecAtaBalances } from "./lib";

const MIN = 60_000;
const total = Number(Bun.env.SOAK_MINUTES ?? 125) * MIN;
const WALLETS = join(STRESS_DIR, "soak-wallets.json");
const W = JSON.parse(readFileSync(WALLETS, "utf8")) as { keeper: string; holders: string[] };
const DB = process.env.PAD_DB_FILE!;
const OUT = join(STRESS_DIR, "soak-samples.jsonl");
const KLOG = join(STRESS_DIR, "soak-keeper.log");
const HLOG = process.env.PAD_KEEPER_HEALTH_LOG!;
const t0 = Date.now();
const log = (...a: unknown[]) => {
  const line = `[${Math.round((Date.now() - t0) / 1000)}s] ${a.map(String).join(" ")}`;
  console.log(line);
  appendFileSync(join(STRESS_DIR, "soak.log"), line + "\n");
};
const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
const keeperAta = getAssociatedTokenAddressSync(ZEC, new PublicKey(W.keeper), false, TOKEN_PROGRAM_ID);
const keeperZec = async () => BigInt((await direct.getTokenAccountBalance(keeperAta).catch(() => ({ value: { amount: "0" } }))).value.amount);

function startKeeper() {
  const p = Bun.spawn(["sh", "-c", `exec bun scripts/keeper.ts >> '${KLOG}' 2>&1`]);
  log("keeper started pid", p.pid);
  return p;
}

function sample(pid: number, segment: number): void {
  const ps = new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout).trim();
  const fds = new TextDecoder().decode(Bun.spawnSync(["lsof", "-p", String(pid)]).stdout).split("\n").filter(Boolean).length - 1;
  const rec = { tMin: +((Date.now() - t0) / MIN).toFixed(1), segment, pid, rssKb: Number(ps || 0), fds, keeperLogBytes: size(KLOG) + size(HLOG), dbBytes: size(DB) + size(DB + "-wal") };
  appendFileSync(OUT, JSON.stringify(rec) + "\n");
}

const RECONCILE_ONLY = process.argv[2] === "reconcile"; // re-run only the reconciliation; every start balance was 0 (soak.log)
const zecStart = RECONCILE_ONLY ? 0n : await keeperZec();
const holdersStart = RECONCILE_ONLY ? new Map<string, bigint | null>() : await zecAtaBalances(W.holders);
log("start: keeper ZEC", zecStart, "holders", W.holders.length);
if (!RECONCILE_ONLY) await soakLoop();
async function soakLoop(): Promise<void> {
const trades = Bun.spawn(["bun", "stress/trade-burst.ts", WALLETS, "0", "30", "4"], { env: { ...process.env, SOAK_UNTIL: String(t0 + total - 10 * MIN) }, stdout: "pipe", stderr: "pipe" });
const kills = [0, 1, 2].map((i) => Math.round((15 + i * 15 + Math.random() * 12) * MIN)); // three kills between ~15 and ~57 min
log("kill plan (min):", kills.map((k) => (k / MIN).toFixed(1)).join(", "));
let keeper = startKeeper();
let segment = 0;
while (Date.now() - t0 < total) {
  sample(keeper.pid, segment);
  const next = kills.find((k) => k <= Date.now() - t0); // due (a loop pass can take longer than a minute)
  if (next !== undefined) {
    kills.splice(kills.indexOf(next), 1);
    keeper.kill("SIGKILL");
    await keeper.exited;
    log("SIGKILL keeper at", ((Date.now() - t0) / MIN).toFixed(1), "min");
    await Bun.sleep(5000);
    keeper = startKeeper();
    segment++;
  }
  await Bun.sleep(MIN);
}
log("soak time over; stopping trades and the keeper");
await trades.exited;
log("trades:", (await new Response(trades.stdout).text()).trim());
keeper.kill("SIGTERM");
await keeper.exited;
// Finish whatever is in flight with plain runs (the same runEpoch), then reconcile.
for (let i = 0; i < 20; i++) {
  const d = new Database(DB, { readonly: true });
  const left = (d.query("SELECT (SELECT COUNT(*) FROM payouts WHERE sentAt IS NULL) + (SELECT COUNT(*) FROM epochs WHERE status IN ('harvesting','needs_attention')) AS n").get() as { n: number }).n;
  d.close();
  if (left === 0) break;
  const r = Bun.spawn(["bun", "stress/epoch-runner.ts"], { stdout: "pipe", stderr: "pipe" });
  await r.exited;
  log("finishing run:", (await new Response(r.stdout).text()).trim().split("\n").at(-1));
  await Bun.sleep(5000);
}

}
const d = new Database(DB, { readonly: true });
const claimed = (d.query("SELECT amountZats FROM claim_progress WHERE amountZats IS NOT NULL").all() as { amountZats: string }[]).reduce((a, r) => a + BigInt(r.amountZats), 0n);
const sent = d.query("SELECT wallet, kind, amountZats, sig FROM payouts WHERE sentAt IS NOT NULL").all() as { wallet: string; kind: string; amountZats: string; sig: string }[];
const epochs = d.query("SELECT id, status, attempts FROM epochs").all() as { id: string; status: string; attempts: number }[];
const unsent = (d.query("SELECT COUNT(*) AS n FROM payouts WHERE sentAt IS NULL").get() as { n: number }).n;
const problems: string[] = [];
const onSolana = sent.filter((p) => p.kind !== "shielded" || p.sig.startsWith("fallback_solana:"));
const paidOut = onSolana.reduce((a, p) => a + BigInt(p.amountZats), 0n);
// A shielded epoch moves its swap input out of the keeper (the first epoch is shielded: none happened before it).
const swapped = (d.query("SELECT amountInZats FROM swap_progress").all() as { amountInZats: string }[]).reduce((a, r) => a + BigInt(r.amountInZats), 0n);
const zecEnd = await keeperZec();
if (zecEnd - zecStart !== claimed - paidOut - swapped) problems.push(`keeper ZEC moved ${zecEnd - zecStart}, DB says claimed ${claimed} - sent ${paidOut} - swapped ${swapped} = ${claimed - paidOut - swapped}`);
const perHolder = new Map<string, bigint>();
for (const p of onSolana) perHolder.set(p.wallet, (perHolder.get(p.wallet) ?? 0n) + BigInt(p.amountZats));
const holdersEnd = await zecAtaBalances(W.holders);
let checked = 0;
for (const h of W.holders) {
  const got = (holdersEnd.get(h) ?? 0n)! - (holdersStart.get(h) ?? 0n)!;
  const want = perHolder.get(h) ?? 0n;
  checked++;
  if (got !== want) problems.push(`holder ${h.slice(0, 8)}: chain moved ${got}, DB sent ${want}`);
}
if (unsent) problems.push(`${unsent} payout rows unsent`);
for (const e of epochs) if (e.status !== "ok" && e.status !== "fallback_solana") problems.push(`epoch ${e.id} status ${e.status}`);
const samples = readFileSync(OUT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tMin: number; segment: number; rssKb: number; fds: number; keeperLogBytes: number; dbBytes: number });
const report = {
  minutes: +((Date.now() - t0) / MIN).toFixed(1), epochs: epochs.length, payoutsSent: sent.length, claimedZats: claimed.toString(), paidZats: paidOut.toString(),
  holdersChecked: checked, maxAttempts: Math.max(0, ...epochs.map((e) => e.attempts ?? 0)), samples: samples.length, problems,
};
writeFileSync(join(STRESS_DIR, "soak-result.json"), JSON.stringify(report, null, 1));
log(JSON.stringify(report));
log(problems.length === 0 ? "RESULT: reconciliation PASS" : `RESULT: reconciliation FAIL (${problems.length})`);
process.exit(0);
