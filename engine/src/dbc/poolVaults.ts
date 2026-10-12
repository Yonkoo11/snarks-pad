// How much of a coin the Meteora pools themselves hold: the bonding curve's base vault, and after graduation the DAMM v2 pool's vault
// for the coin. These are program-owned accounts (never paid, never holders: src/holders.ts leaves every off-curve owner out of the
// epoch), and the holders view shows them as the "pool" rows. Read-only; one or two account reads, cached for POOL_VAULT_MAX_AGE_MS.
// `poolVaults` gives the trade reader (dbc/trade.ts) the pool's two vault addresses, so a trade's side and amounts are read off the pool, not the payer.
import { PublicKey } from "@solana/web3.js";
import { getConnection, getDbcClient } from "../solana";
import { viewCpAmm } from "./cpAmm";
import type { CoinRow } from "../db";
import { makeReadCache } from "./read";

export const POOL_VAULT_MAX_AGE_MS = Number(process.env.PAD_POOL_VAULT_MAX_AGE_MS ?? 30_000);

export interface PoolHolding {
  /** The vault's token account: an address an explorer opens. */
  account: string;
  balance: bigint;
  kind: "curve" | "pool";
  label: string;
}

async function balanceOf(account: PublicKey): Promise<bigint> {
  const { value } = await getConnection().getTokenAccountBalance(account, "confirmed");
  return BigInt(value.amount);
}

async function readPoolHoldings(coin: CoinRow): Promise<PoolHolding[]> {
  const out: PoolHolding[] = [];
  const virtualPool = coin.poolId ? await getDbcClient().state.getPool(new PublicKey(coin.poolId)) : null;
  if (virtualPool) {
    const vault = virtualPool.poolState.baseVault;
    out.push({ account: vault.toBase58(), balance: await balanceOf(vault), kind: "curve", label: "Meteora bonding curve" });
  }
  if (coin.dammPool) {
    const pool = await viewCpAmm().fetchPoolState(new PublicKey(coin.dammPool));
    const vault = pool.tokenAMint.toBase58() === coin.mint ? pool.tokenAVault : pool.tokenBVault;
    out.push({ account: vault.toBase58(), balance: await balanceOf(vault), kind: "pool", label: "Meteora DAMM v2 pool" });
  }
  return out.filter((h) => h.balance > 0n);
}

/** The pool vaults' holdings of a coin, read at most once per window per coin; a failed read is not kept. */
export const poolHoldings = makeReadCache(readPoolHoldings, (c: CoinRow) => `${c.mint}:${c.poolId}:${c.dammPool ?? ""}`, POOL_VAULT_MAX_AGE_MS);

/** The two token accounts a Meteora pool trades through: the coin's vault and the ZEC vault. */
export interface PoolVaults {
  base: string;
  quote: string;
}

async function readPoolVaults(p: { id: string; kind: "curve" | "pool"; mint: string }): Promise<PoolVaults> {
  if (p.kind === "curve") {
    const virtualPool = await getDbcClient().state.getPool(new PublicKey(p.id));
    if (!virtualPool) throw new Error(`DBC pool ${p.id} not found`);
    return { base: virtualPool.poolState.baseVault.toBase58(), quote: virtualPool.poolState.quoteVault.toBase58() };
  }
  const pool = await viewCpAmm().fetchPoolState(new PublicKey(p.id));
  const baseIsA = pool.tokenAMint.toBase58() === p.mint;
  return { base: (baseIsA ? pool.tokenAVault : pool.tokenBVault).toBase58(), quote: (baseIsA ? pool.tokenBVault : pool.tokenAVault).toBase58() };
}

/** A pool's vault addresses, read once per pool and kept for the process (a pool's vaults never change). A failed read is not kept. */
export const poolVaults = makeReadCache(readPoolVaults, (p: { id: string }) => p.id, Number.MAX_SAFE_INTEGER);
