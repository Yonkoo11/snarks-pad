// dbc/migrate.ts reconcileMigrations: the API's one-minute sweep records a coin whose curve the chain shows migrated (by anyone: migration is permissionless)
// so the site stops showing its curve price hours before the keeper's epoch would notice. Written 2026-10-12 after $SNARKS graduated on mainnet unrecorded.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import { reconcileMigrations, type MigrationLook } from "../src/dbc/graduation";
import { ChainUnavailableError } from "../src/rpcGuard";

const made: string[] = [];
afterAll(() => { for (const m of made) db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: m }); });

function coin(symbol: string, opts: { status?: "pending" | "launched"; poolId?: string | null; dammPool?: string | null } = {}): string {
  const mint = Keypair.generate().publicKey.toBase58();
  made.push(mint);
  db.upsertCoin({
    mint, name: symbol, symbol, imageUrl: "", description: "", creator: Keypair.generate().publicKey.toBase58(), createdAt: new Date().toISOString(),
    feeBps: 100, poolId: opts.poolId === undefined ? Keypair.generate().publicKey.toBase58() : opts.poolId, mintDecimals: 6, status: opts.status ?? "launched",
    configId: Keypair.generate().publicKey.toBase58(), socials: "{}", creatorWallet: null, feeSchedule: null,
  });
  if (opts.dammPool) db.markCoinMigrated(mint, opts.dammPool, null);
  return mint;
}

/** A chain that answers `stages` by pool and records by writing the DAMM pool "damm-<symbol>"; it counts what it was asked. */
function fakeLook(stages: Record<string, "open" | "complete" | "migrated" | Error>): MigrationLook & { asked: string[]; recorded: string[] } {
  const look = {
    asked: [] as string[],
    recorded: [] as string[],
    async stage(poolId: string) {
      look.asked.push(poolId);
      const s = stages[poolId];
      if (s === undefined) throw new Error(`DBC pool ${poolId} not found`);
      if (s instanceof Error) throw s;
      return s;
    },
    async record(c: db.CoinRow) {
      look.recorded.push(c.symbol);
      db.markCoinMigrated(c.mint, `damm-${c.symbol}`, null);
      return db.getCoin(c.mint)!;
    },
  };
  return look;
}

describe("the API's migration sweep", () => {
  test("records a migrated coin, leaves open and full curves to the keeper, and skips pending, unlaunched and already recorded rows", async () => {
    const migrated = coin("MIG1");
    const open = coin("OPEN1");
    const full = coin("FULL1");
    const done = coin("DONE1", { dammPool: "damm-already" });
    const pending = coin("PEND1", { status: "pending", poolId: null });
    const pools = (m: string) => db.getCoin(m)!.poolId!;
    const look = fakeLook({ [pools(migrated)]: "migrated", [pools(open)]: "open", [pools(full)]: "complete" });
    const recorded = await reconcileMigrations(look);
    expect(recorded).toContain("MIG1");
    expect(recorded).not.toContain("OPEN1");
    expect(recorded).not.toContain("FULL1");
    expect(look.recorded).toEqual(["MIG1"]);
    expect(db.getCoin(migrated)!.dammPool).toBe("damm-MIG1");
    expect(db.getCoin(open)!.dammPool ?? null).toBeNull();
    expect(db.getCoin(done)!.dammPool).toBe("damm-already");
    expect(look.asked).not.toContain(pools(done));
    expect(db.getCoin(pending)!.status).toBe("pending");
    // a second round asks nothing about the coin already recorded
    const again = fakeLook({ [pools(open)]: "open", [pools(full)]: "complete" });
    await reconcileMigrations(again);
    expect(again.asked).not.toContain(pools(migrated));
  });

  test("one coin's failure is logged and the others are still looked at; a chain outage ends the round", async () => {
    const broken = coin("BRK1");
    const fine = coin("FINE1");
    const pools = (m: string) => db.getCoin(m)!.poolId!;
    const look = fakeLook({ [pools(fine)]: "migrated", [pools(broken)]: new Error("pool is full but needs a vesting locker") });
    const quiet = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    try {
      const recorded = await reconcileMigrations(look);
      expect(recorded).toContain("FINE1");
      expect(logged.some((l) => l.includes("BRK1") && l.includes("vesting locker"))).toBe(true);
      const outage = fakeLook({ [pools(fine)]: "migrated", [pools(broken)]: new ChainUnavailableError("timeout", "rpc down") });
      db.getDb().query("UPDATE coins SET dammPool = NULL, migratedAt = NULL WHERE mint = $m").run({ $m: fine });
      await expect(reconcileMigrations(outage)).rejects.toThrow("chain unavailable");
    } finally {
      console.error = quiet;
    }
  });
});
