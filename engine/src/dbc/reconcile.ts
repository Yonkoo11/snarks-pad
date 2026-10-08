// Records launches that landed on chain but that no browser confirmed. Before this, a launch whose confirm call never
// came (the page closed, the wallet's network failed, or the 2026-10-06 rehearsal's websocket wait timed out) stayed "pending" for good: off the board,
// its page a 404, its holders never paid, its creator unable to claim. The proof used here is the coin's DBC pool under the coin's own config: only a
// launch that landed can have made it (the create-pool instruction is atomic), and a pool address cannot be faked: the program alone creates it, and
// an account someone funds at that address is owned by the system program, which is read as "absent".
// Every RECONCILE_EVERY_MS, launches prepared more than RECONCILE_AFTER_MS ago (time for their own browser to confirm) are looked up in batches of
// 100 (one getMultipleAccounts call each); the hourly sweep asks the same question before it drops a launch (publicFiles/sweep.ts).
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { deriveDbcPoolAddress, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "../config";
import * as db from "../db";
import { getDbcClient } from "../solana";
import { readAccountsInfo } from "../multiAccounts";

export type PoolLook = { state: "landed"; poolId: string; activationPoint: string | null } | { state: "absent" } | { state: "unknown" };

/** Time a launch's own browser has to confirm it before the engine looks for it. */
export const RECONCILE_AFTER_MS = 90_000;
export const RECONCILE_EVERY_MS = 120_000;
const BATCH = 100;

export type ReadAccounts = (keys: PublicKey[]) => Promise<(AccountInfo<Buffer> | null)[]>;
const readAccounts: ReadAccounts = (keys) => readAccountsInfo(keys);

/**
 * The pool's activation point (for a Timestamp config, the second the launch landed in), decoded from the account just read: no extra RPC call. null
 * when it does not decode; the coin's first chain read then fills it in (dbc/read.ts).
 */
export function activationPointOf(poolId: string, data: Buffer): string | null {
  try {
    return getDbcClient().state.program.coder.accounts.decode<VirtualPool>("virtualPool", data).poolState.activationPoint.toString();
  } catch (err) {
    console.error(`[api] activation point of pool ${poolId} did not decode, left for the first chain read: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

function lookOf(pool: PublicKey, info: AccountInfo<Buffer> | null): PoolLook {
  if (!info || !info.owner.equals(config.solana.dbc.programId)) return { state: "absent" };
  const poolId = pool.toBase58();
  return { state: "landed", poolId, activationPoint: activationPointOf(poolId, info.data) };
}

/** The pools these launches would have made, read 100 at a time. A batch whose read fails answers "unknown" for each of its launches. */
export async function lookForPools(rows: readonly { mint: string; configId: string }[], read: ReadAccounts = readAccounts): Promise<Map<string, PoolLook>> {
  const out = new Map<string, PoolLook>();
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const pools = chunk.map((r) => deriveDbcPoolAddress(config.solana.dbc.quoteMint, new PublicKey(r.mint), new PublicKey(r.configId)));
    try {
      const infos = await read(pools);
      chunk.forEach((r, j) => out.set(r.mint, lookOf(pools[j]!, infos[j] ?? null)));
    } catch (err) {
      console.error(`[reconcile] the pools of ${chunk.length} pending launch(es) could not be read: ${(err as Error)?.message ?? err}`);
      for (const r of chunk) out.set(r.mint, { state: "unknown" });
    }
  }
  return out;
}

/** One pending launch's pool (the sweep asks one launch at a time). A row with no config can never be confirmed, so it reads as absent. */
export async function lookForPool(mint: string, read: ReadAccounts = readAccounts): Promise<PoolLook> {
  const configId = db.getCoin(mint)?.configId;
  if (!configId) return { state: "absent" };
  return (await lookForPools([{ mint, configId }], read)).get(mint) ?? { state: "unknown" };
}

/** Records every launch prepared more than RECONCILE_AFTER_MS before `now` whose pool exists. Returns the mints it recorded. */
export async function reconcilePendingLaunches(now: number = Date.now(), read: ReadAccounts = readAccounts): Promise<string[]> {
  const rows = db.listStalePendingCoins(new Date(now - RECONCILE_AFTER_MS).toISOString()).flatMap(({ mint }) => {
    const configId = db.getCoin(mint)?.configId;
    return configId ? [{ mint, configId }] : [];
  });
  if (rows.length === 0) return [];
  const recorded: string[] = [];
  for (const [mint, look] of await lookForPools(rows, read)) {
    if (look.state !== "landed") continue;
    db.markCoinLaunched(mint, look.poolId, look.activationPoint);
    recorded.push(mint);
  }
  return recorded;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the two-minute reconcile in the API process. It never throws into the API: a failed round is a log line and the next one tries again. */
export function startLaunchReconciler(): void {
  if (timer) return;
  const round = () =>
    reconcilePendingLaunches().then(
      (r) => { if (r.length) console.log(`[reconcile] recorded ${r.length} launch(es) no browser confirmed: ${r.join(", ")}`); },
      (err) => console.error(`[reconcile] round failed: ${(err as Error)?.message ?? err}`),
    );
  timer = setInterval(round, RECONCILE_EVERY_MS);
  timer.unref?.();
}
