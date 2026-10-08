// Local-mode only: starts zebrad + zainod (regtest) and provisions the pad's
// Zcash treasury wallet + a "funding" wallet the simulated swap adapter uses to
// credit the treasury. Adapts probe/zcash-batch/run.sh's proven steps 1-2 into
// long-running, idempotent process management instead of a wipe-every-run script.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { initWallet, syncWallet, getBalance, defaultUnifiedAddress, walletExists } from "./devtool";

const BURN_ADDRESS =
  "uregtest1efxggx6lduhm2fx5lnrhxv7h7kpztlpa3ahf3n4w0q0zj5epj4av9xjq6ljsja3xk8z7rzd067kc7mgpy9448rdfzpfjz5gq389zdmpgnk6rp4ykk0xk6cmqw6zqcrnmsuaxv3yzsvcwsd4gagtalh0uzrdvy03nhmltjz2eu0232qlcs0zvxuqyut73yucd9gy5jaudnyt7yqhgpqv";
const FUND_BLOCKS_PER_WALLET = 20; // ~6.25 REG/block, far more than any test needs
const MATURITY_BLOCKS = 100;

export const TREASURY_DIR = join(config.paths.zcashWorkDir, "wallets", "treasury");
export const FUNDING_DIR = join(config.paths.zcashWorkDir, "wallets", "funding");
const TREASURY_IDENTITY = join(config.paths.zcashWorkDir, "wallets", "treasury.identity.age");
const FUNDING_IDENTITY = join(config.paths.zcashWorkDir, "wallets", "funding.identity.age");

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(config.zcash.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`zebrad RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function isPidAlive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  try {
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), 0);
    return true;
  } catch {
    return false;
  }
}

function spawnDetached(cmd: string[], logFile: string, pidFile: string): void {
  const log = Bun.file(logFile);
  const proc = Bun.spawn(cmd, { stdout: log, stderr: log, stdin: "ignore" });
  proc.unref();
  writeFileSync(pidFile, String(proc.pid));
}

async function zebradUp(): Promise<boolean> {
  return typeof (await rpc("getblockcount", [])) === "number";
}

async function ensureNodesRunning(): Promise<void> {
  mkdirSync(config.paths.zcashWorkDir, { recursive: true });
  if (isPidAlive(config.paths.zebradPid) && (await zebradUp().catch(() => false))) return; // already up, no-op

  mkdirSync(join(config.paths.zcashWorkDir, "wallets"), { recursive: true });
  spawnDetached(
    ["env", "-u", "RUST_LOG", config.paths.zebradBin, "-c", config.paths.zebradConfig, "start"],
    config.paths.zebradLog,
    config.paths.zebradPid,
  );
  await waitFor("zebrad RPC", zebradUp);

  spawnDetached(
    ["env", "-u", "RUST_LOG", config.paths.zainodBin, "start", "-c", config.paths.zainodConfig],
    config.paths.zainodLog,
    config.paths.zainodPid,
  );
  await waitFor("zainod ready", async () => readFileSync(config.paths.zainodLog, "utf8").includes("Zaino Indexer started successfully"));

  await rpc("generatetoaddress", [1, BURN_ADDRESS]); // wallets need chain height >= 1 to pick a birthday
}

async function tip(): Promise<number> {
  return Number(await rpc("getblockcount", []));
}

async function syncToTip(walletDir: string): Promise<void> {
  const target = await tip();
  await waitFor(`${walletDir} synced to ${target}`, async () => {
    syncWallet(walletDir);
    return getBalance(walletDir).height >= target;
  }, 120_000);
}

/** Idempotent: starts the regtest chain + light-client indexer and funds the
 * treasury/funding wallets on first run only. Safe to call repeatedly. */
export async function ensureRegtestReady(): Promise<{ treasuryUA: string; fundingUA: string }> {
  await ensureNodesRunning();

  const freshlyInitialized = !walletExists(TREASURY_DIR);
  initWallet(TREASURY_DIR, "treasury", TREASURY_IDENTITY);
  initWallet(FUNDING_DIR, "funding", FUNDING_IDENTITY);
  const treasuryUA = defaultUnifiedAddress(TREASURY_DIR);
  const fundingUA = defaultUnifiedAddress(FUNDING_DIR);

  if (freshlyInitialized) {
    await rpc("generatetoaddress", [FUND_BLOCKS_PER_WALLET, treasuryUA]);
    await rpc("generatetoaddress", [FUND_BLOCKS_PER_WALLET, fundingUA]);
    await rpc("generatetoaddress", [MATURITY_BLOCKS, BURN_ADDRESS]); // coinbase maturity
  }
  await syncToTip(TREASURY_DIR);
  await syncToTip(FUNDING_DIR);
  return { treasuryUA, fundingUA };
}

interface ShieldedTx {
  vin?: unknown[]; vout?: unknown[]; vShieldedSpend?: unknown[]; vShieldedOutput?: unknown[];
  orchard?: { actions?: unknown[]; valueBalanceZat?: number };
  ironwood?: { actions?: unknown[]; valueBalanceZat?: number };
}

/**
 * Network fee of a treasury payout, read back from the node. Since NU6.3
 * (Ironwood) mainnet accepts no new Orchard-pool outputs, so the treasury only
 * ever sends fully-Ironwood transactions (no transparent, Sapling or old
 * Orchard parts): the Ironwood value balance (value leaving the pool) is
 * exactly the fee. Throws on any other shape, which would mean the payout did
 * not land in the pool mainnet accepts.
 */
export async function shieldedTxFeeZats(txid: string): Promise<bigint> {
  const tx = (await rpc("getrawtransaction", [txid, 1])) as ShieldedTx;
  const pureIronwood =
    !tx.vin?.length && !tx.vout?.length && !tx.vShieldedSpend?.length && !tx.vShieldedOutput?.length && !tx.orchard?.actions?.length;
  if (!pureIronwood || !tx.ironwood?.actions?.length || typeof tx.ironwood.valueBalanceZat !== "number") {
    throw new Error(`tx ${txid} is not a pure Ironwood transaction`);
  }
  return BigInt(tx.ironwood.valueBalanceZat);
}

/** Action counts per pool of a mined or mempool tx, read from the node (used by the e2e to assert the pool). */
export async function txPoolActions(txid: string): Promise<{ ironwood: number; orchard: number }> {
  const tx = (await rpc("getrawtransaction", [txid, 1])) as ShieldedTx;
  return { ironwood: tx.ironwood?.actions?.length ?? 0, orchard: tx.orchard?.actions?.length ?? 0 };
}

export async function mineBlocks(n: number, toAddress: string = BURN_ADDRESS): Promise<void> {
  await rpc("generatetoaddress", [n, toAddress]);
}

export type ZcashTxStatus = "mined" | "mempool" | "unknown";

/**
 * Resume check for a Zcash payout (finding 1): before resending a chunk whose
 * txid we already recorded, find out whether it actually landed instead of
 * blindly resending. "unknown" means zebrad has never seen it (a genuine
 * crash-before-broadcast, or the regtest chain was reset) -- safe to resend.
 */
export async function zcashTxStatus(txid: string): Promise<ZcashTxStatus> {
  try {
    const tx = (await rpc("getrawtransaction", [txid, 1])) as { confirmations?: number };
    return (tx.confirmations ?? 0) > 0 ? "mined" : "mempool";
  } catch {
    return "unknown";
  }
}

/** Waits until `txid` has at least `n` confirmations. Regtest-only (mining is instant and under our control here). */
export async function waitForZcashConfirmations(txid: string, n: number, timeoutMs = 60_000): Promise<void> {
  await waitFor(`${txid} to reach ${n} confirmation(s)`, async () => {
    const tx = (await rpc("getrawtransaction", [txid, 1])) as { confirmations?: number };
    return (tx.confirmations ?? 0) >= n;
  }, timeoutMs);
}

export { TREASURY_IDENTITY, FUNDING_IDENTITY, syncToTip };
