// Thin wrapper around the zcash-devtool CLI (librustzcash light wallet), the
// same binary and command shapes proven in probe/zcash-batch/run.sh. Local mode
// drives it against our own regtest zebrad+zainod; test/main modes would point
// --server at a real lightwalletd (see zcash/regtest.ts for local process mgmt).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { config } from "../config";

/** Masks every Zcash unified/shielded address in `text` (audit S2-06): devtool output and errors can echo the payment URI, and a full u1 must never reach a log. */
export function redactZcashAddresses(text: string): string {
  return text.replace(/\b(u(?:test|regtest)?1|zs1|ztestsapling1)[0-9a-z]{8,}/gi, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
}

let verified: { path: string; size: number; mtimeMs: number } | null = null;
let warnedUnpinned = false;

/**
 * The devtool binary holds the treasury's spending key (audit/S2-SUPPLY-CHAIN.md), so before it runs, its sha256 must
 * equal ZCASH_DEVTOOL_SHA256 when that is set (scripts/build-devtool.sh prints it). Re-checked whenever the file
 * changes (size or mtime). Outside local mode an unset pin only warns, once.
 */
export function verifyDevtoolBinary(): void {
  const path = config.paths.zcashDevtoolBin;
  const expected = config.zcash.devtoolSha256;
  if (!expected) {
    if (!config.isLocal && !warnedUnpinned) {
      warnedUnpinned = true;
      console.error("ZCASH_DEVTOOL_SHA256 is not set: the zcash-devtool binary that holds the treasury key is not pinned to a checksum (scripts/build-devtool.sh)");
    }
    return;
  }
  const st = statSync(path);
  if (verified && verified.path === path && verified.size === st.size && verified.mtimeMs === st.mtimeMs) return;
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw new Error(`zcash-devtool at ${path} has sha256 ${actual}, which does not match ZCASH_DEVTOOL_SHA256 ${expected}; refusing to run it`);
  verified = { path, size: st.size, mtimeMs: st.mtimeMs };
}

function devtoolEnv(): Record<string, string> {
  // Only what the binary needs (audit S2-14): it holds the treasury key, and must not also see the keeper's env secrets.
  const env: Record<string, string> = { RUST_LOG: "warn" };
  for (const k of ["PATH", "HOME", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** Same as run(), without blocking the event loop: for the API process, which must keep answering while devtool works. */
async function runAsync(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  verifyDevtoolBinary();
  const proc = Bun.spawn([config.paths.zcashDevtoolBin, ...args], { env: devtoolEnv(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  verifyDevtoolBinary();
  const env = devtoolEnv();
  const proc = Bun.spawnSync([config.paths.zcashDevtoolBin, ...args], { env });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function server(): string {
  return config.zcash.lightwalletdServer;
}

export function walletExists(walletDir: string): boolean {
  return existsSync(`${walletDir}/data.sqlite`);
}

/**
 * Idempotent: no-ops if the wallet directory already has a database. Retries:
 * zainod lags zebrad by a few seconds right after a fresh chain starts, so
 * `init` can fail with "Height out of range" until it catches up (same retry
 * probe/zcash-batch/run.sh uses).
 */
export function initWallet(walletDir: string, name: string, identityFile: string, attempts = 10): void {
  if (walletExists(walletDir)) return;
  for (let i = 0; i < attempts; i++) {
    // --activation-heights is required for regtest and rejected for test/main (devtool help).
    const heights = config.zcash.network === "regtest" ? ["--activation-heights", config.paths.activationHeights] : [];
    const r = run(["wallet", "-w", walletDir, "init", "--name", name, "-i", identityFile, "-n", config.zcash.network, ...heights, "-s", server()]);
    if (r.exitCode === 0 && walletExists(walletDir)) return;
    if (i === attempts - 1) throw new Error(`zcash-devtool wallet init failed for ${walletDir} after ${attempts} attempts: ${redactZcashAddresses(r.stderr || r.stdout)}`);
    Bun.sleepSync(3000);
  }
}

export function syncWallet(walletDir: string): void {
  const r = run(["wallet", "-w", walletDir, "sync", "-s", server()]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool sync failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
}

/** Fetches the full data of every transaction the wallet knows (compact blocks carry no memos), so list-tx can show them. */
export function enhanceWallet(walletDir: string): void {
  const r = run(["wallet", "-w", walletDir, "enhance", "-s", server()]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool enhance failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
}

export interface WalletBalance {
  /** Ironwood-pool spendable: where every payout and swap payout lands since NU6.3. */
  ironwoodSpendableZats: bigint;
  /** Old (sealed, withdraw-only) Orchard pool spendable. Expected 0 for this pad. */
  orchardSpendableZats: bigint;
  /** Everything the wallet can spend now: Ironwood + Orchard. */
  spendableZats: bigint;
  /** Total including notes not yet spendable (<10 confs). */
  totalZats: bigint;
  height: number;
}

function parseZecAmount(text: string): bigint {
  return BigInt(Math.round(Number.parseFloat(text) * 1e8));
}

export function getBalance(walletDir: string): WalletBalance {
  const r = run(["wallet", "-w", walletDir, "balance"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool balance failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  return parseBalance(r.stdout);
}

/** getBalance without blocking the event loop (the API's GET /treasury, stress run D6). */
export async function getBalanceAsync(walletDir: string): Promise<WalletBalance> {
  const r = await runAsync(["wallet", "-w", walletDir, "balance"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool balance failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  return parseBalance(r.stdout);
}

function parseBalance(stdout: string): WalletBalance {
  // The CLI prints a verbose WalletSummary debug dump, then a readable summary
  // ("Balance: X REG" / "Ironwood Spendable: X REG" / "Height: N") — parse that
  // tail. "Balance" is the total including unspendable (<10 confs) change; a
  // note received in the last epoch's payout shows here immediately, before
  // it counts as spendable.
  const amountAfter = (label: string): bigint => {
    const m = new RegExp(`${label}:\\s*([0-9.]+)`).exec(stdout)?.[1];
    return m ? parseZecAmount(m) : 0n;
  };
  const ironwoodSpendableZats = amountAfter("Ironwood Spendable");
  const orchardSpendableZats = amountAfter("Orchard Spendable");
  const total = /^\s*Balance:\s*([0-9.]+)/m.exec(stdout)?.[1];
  const height = /^\s*Height:\s*(\d+)/m.exec(stdout)?.[1];
  return {
    ironwoodSpendableZats,
    orchardSpendableZats,
    spendableZats: ironwoodSpendableZats + orchardSpendableZats,
    totalZats: total ? parseZecAmount(total) : ironwoodSpendableZats + orchardSpendableZats,
    height: height ? Number(height) : 0,
  };
}

/**
 * Pools of the outputs this wallet received in `txid`, from `list-tx`
 * ("Output n (Ironwood)" ... "Received by account"). Empty if the wallet
 * has not seen the tx. Sync the wallet first.
 */
export function receivedPools(walletDir: string, txid: string): string[] {
  const r = run(["wallet", "-w", walletDir, "list-tx"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool list-tx failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  const after = r.stdout.split(txid)[1];
  if (!after) return [];
  const body = after.split(/\n[0-9a-f]{64}\n/)[0] ?? "";
  return [...body.matchAll(/Output \d+ \((\w+)\)\s*\n\s*Value:[^\n]*\n\s*Received by account/g)].map((m) => m[1]!);
}

/** "0.00375000" -> 375000n, exactly (no float). */
function parseZatsExact(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!m) throw new Error(`cannot parse a ZEC amount from ${JSON.stringify(text)}`);
  return BigInt(m[1]!) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

export interface ReceivedInTx {
  /** Sum of the outputs of `txid` this wallet received (change excluded). */
  zats: bigint;
  /** Block height it was mined at, null while unmined. */
  minedHeight: number | null;
}

/**
 * What a `list-tx` listing says this wallet received in `txid`: "Output n (Pool)" / "Value: x UNIT" / "Received by
 * account" (format read from the real mainnet wallet, PORT-ASSUMPTIONS N8; the unit is ZEC on mainnet, TAZ on testnet,
 * REG on regtest). null if the listing has no such tx.
 */
export function parseReceivedInTx(listTx: string, txid: string): ReceivedInTx | null {
  const after = listTx.split(txid)[1];
  if (after === undefined) return null;
  const body = after.split(/\n[0-9a-f]{64}\n/)[0] ?? "";
  const mined = /Mined:\s*(\d+)/.exec(body)?.[1];
  let zats = 0n;
  for (const m of body.matchAll(/Output \d+ \(\w+\)\s*\n\s*Value:\s*([0-9.]+) [A-Z]+\s*\n\s*Received by account/g)) zats += parseZatsExact(m[1]!);
  return { zats, minedHeight: mined ? Number(mined) : null };
}

/** The network fee of `txid` from a `list-tx` listing ("Fee paid: x UNIT", present on the sender's side); null if absent. */
export function parseTxFeeZats(listTx: string, txid: string): bigint | null {
  const after = listTx.split(txid)[1];
  if (after === undefined) return null;
  const body = after.split(/\n[0-9a-f]{64}\n/)[0] ?? "";
  const fee = /Fee paid:\s*([0-9.]+) [A-Z]+/.exec(body)?.[1];
  return fee === undefined ? null : parseZatsExact(fee);
}

/** The network fee this wallet paid for a transaction it sent; throws if the wallet has no fee recorded for it. */
export function txFeeZats(walletDir: string, txid: string): bigint {
  const r = run(["wallet", "-w", walletDir, "list-tx"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool list-tx failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  const fee = parseTxFeeZats(r.stdout, txid);
  if (fee === null) throw new Error(`the wallet ${walletDir} has no fee recorded for ${txid}`);
  return fee;
}

/**
 * Memos of the outputs this wallet received in `txid`, as `list-tx` prints them (`Memo: Memo::Text("...")`). Only text
 * memos are returned. A light wallet learns a memo only after `wallet enhance` fetched the full transaction (a compact
 * block carries none): call enhanceWallet first.
 */
export function receivedMemos(walletDir: string, txid: string): string[] {
  const r = run(["wallet", "-w", walletDir, "list-tx"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool list-tx failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  const after = r.stdout.split(txid)[1];
  if (after === undefined) return [];
  const body = after.split(/\n[0-9a-f]{64}\n/)[0] ?? "";
  return [...body.matchAll(/Output \d+ \(\w+\)\s*\n\s*Value:[^\n]*\n\s*Received by account[^\n]*\n(?:(?!\s*Output )[^\n]*\n)*?\s*Memo: Memo::Text\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1]!);
}

/**
 * The txid of a transaction this wallet SENT (mined or not) with an output of exactly `zats` to `address` carrying the
 * text memo `memo`, from a `list-tx` listing ("Value:", "Sent from account:", "To:", "Memo:"; format read from the
 * regtest treasury, the same devtool build as mainnet). null if there is none. Audit O-4.
 */
export function parseSentPayment(listTx: string, address: string, zats: bigint, memo: string): string | null {
  const blocks = listTx.split(/^(?=[0-9a-f]{64}\s*$)/m);
  for (const block of blocks) {
    const txid = /^([0-9a-f]{64})\s*$/m.exec(block)?.[1];
    if (!txid) continue;
    for (const m of block.matchAll(/Value:\s*([0-9.]+) [A-Z]+\s*\n\s*Sent from account:[^\n]*\n\s*To:\s*(\S+)\s*\n\s*Memo: Memo::Text\("((?:[^"\\]|\\.)*)"\)/g)) {
      if (m[2] === address && m[3] === memo && parseZatsExact(m[1]!) === zats) return txid;
    }
  }
  return null;
}

/** parseSentPayment over the wallet's own `list-tx` (no network: what the wallet itself built and stored). */
export function findSentPayment(walletDir: string, address: string, zats: bigint, memo: string): string | null {
  const r = run(["wallet", "-w", walletDir, "list-tx"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool list-tx failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  return parseSentPayment(r.stdout, address, zats, memo);
}

/** True while a `zcash-devtool wallet -w <walletDir> ... pay` process runs on this host (a dead keeper's orphan may still broadcast). */
export function payRunningFor(walletDir: string): boolean {
  const ps = Bun.spawnSync(["ps", "-Ao", "args"]);
  return new TextDecoder().decode(ps.stdout).split("\n").some((l) => l.includes("zcash-devtool") && l.includes(` ${walletDir} `) && / pay /.test(l));
}

export type SentTxStatus = "mined" | "mempool" | "unknown" | "expired";

/**
 * What a `list-tx` listing says about a transaction this wallet built: "mined" once its block has a "Mined:" line,
 * "mempool" while the wallet lists it "Unmined (expiry height: H)", "expired" once it lists it "Expired (expiry height: H)"
 * (the wallet has synced past H without seeing it mined, so by ZIP 203 no block can include it now: the pinned devtool's
 * list_tx.rs prints one or the other for an unmined tx), "unknown" when the listing has no such transaction (audit S6-B1:
 * how a payout row left pending with a txid is resolved outside regtest).
 */
export function parseSentTxStatus(listTx: string, txid: string): SentTxStatus {
  const after = listTx.split(txid)[1];
  if (after === undefined) return "unknown";
  const rec = parseReceivedInTx(listTx, txid)!;
  if (rec.minedHeight !== null) return "mined";
  const body = after.split(/\n[0-9a-f]{64}\n/)[0] ?? "";
  return /^\s*Expired \(expiry height:/m.test(body) ? "expired" : "mempool";
}

/** parseSentTxStatus over the wallet's own `list-tx` (sync the wallet first so a transaction mined elsewhere is seen as mined). */
export function sentTxStatus(walletDir: string, txid: string): SentTxStatus {
  const r = run(["wallet", "-w", walletDir, "list-tx"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool list-tx failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  return parseSentTxStatus(r.stdout, txid);
}

/** What this wallet received in `txid`; null if the wallet has not seen the tx (sync first). */
export function receivedInTx(walletDir: string, txid: string): ReceivedInTx | null {
  const r = run(["wallet", "-w", walletDir, "list-tx"]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool list-tx failed for ${walletDir}: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  return parseReceivedInTx(r.stdout, txid);
}

/** True iff `address` is printed by the wallet's `list-addresses`, i.e. this wallet can spend what is sent to it. */
export function walletOwnsAddress(walletDir: string, address: string): boolean {
  const r = run(["wallet", "-w", walletDir, "list-addresses"]);
  return r.exitCode === 0 && r.stdout.includes(address);
}

export function defaultUnifiedAddress(walletDir: string): string {
  const r = run(["wallet", "-w", walletDir, "list-addresses"]);
  const ua = /Default Address:\s*(\S+)/.exec(r.stdout)?.[1];
  if (!ua) throw new Error(`no default address for ${walletDir}: ${r.stdout}`);
  return ua;
}

function formatZecAmount(zats: bigint): string {
  const whole = zats / 100_000_000n;
  const frac = (zats % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface Payment {
  address: string;
  zats: bigint;
  /** Text the recipient's wallet shows with the note (a shielded recipient only). */
  memo?: string;
}

/** ZIP 321: a memo is at most 512 bytes. */
export const MAX_MEMO_BYTES = 512;

/**
 * ZIP-321 `memo.N` value: the memo's bytes, base64url without padding (zip321 0.9.0 `memo_to_base64`:
 * BASE64_URL_SAFE_NO_PAD; `memo_from_base64` rejects more than 512 bytes). The first payment's parameters carry no
 * index, the others `.N`, the same as address and amount.
 */
export function encodeMemo(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_MEMO_BYTES) throw new Error(`a memo is at most ${MAX_MEMO_BYTES} bytes, got ${bytes.length}`);
  return bytes.toString("base64url");
}

export function buildZip321Uri(payments: Payment[]): string {
  const parts = payments.map((p, i) => {
    const suffix = i === 0 ? "" : `.${i}`;
    const memo = p.memo === undefined ? "" : `&memo${suffix}=${encodeMemo(p.memo)}`;
    return `address${suffix}=${p.address}&amount${suffix}=${formatZecAmount(p.zats)}${memo}`;
  });
  return `zcash:?${parts.join("&")}`;
}

/** The memo on every shielded reward note: says what the note is, so it does not look like dust from a stranger. */
export function rewardMemo(epochId: string): string {
  return `SNARKS pad reward, epoch ${epochId}`;
}

/** One transaction paying every entry in `payments` from `walletDir`'s shielded (Ironwood) balance. Returns the txid. */
export function payBatch(walletDir: string, identityFile: string, payments: Payment[]): string {
  if (payments.length === 0) throw new Error("payBatch called with no payments");
  const uri = buildZip321Uri(payments);
  const r = run([
    "wallet", "-w", walletDir, "pay", "-i", identityFile,
    "--payment-uri", uri, "--target-note-count", "1", "--disable-confirmation", "-s", server(),
  ]);
  if (r.exitCode !== 0) throw new Error(`zcash-devtool pay failed: ${redactZcashAddresses(r.stderr || r.stdout)}`);
  const lines = r.stdout.trim().split("\n");
  const txid = lines[lines.length - 1]?.trim();
  if (!txid || !/^[0-9a-f]{64}$/.test(txid)) throw new Error(`pay did not return a txid: ${redactZcashAddresses(r.stdout)}`);
  return txid;
}

export function chainTipHeight(walletDir: string): number {
  const r = run(["wallet", "-w", walletDir, "get-info", "-s", server()]);
  const parsed = JSON.parse(r.stdout || "{}") as { chain_tip_height?: number };
  return parsed.chain_tip_height ?? 0;
}
