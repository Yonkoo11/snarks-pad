// A coin whose claim cannot run (Meteora pauses a graduated pool, an RPC error,
// a pool that cannot be read) must not stall the other coins (PORT-ASSUMPTIONS
// D27, P13). Runs in a subprocess with its own sqlite file so it cannot see, or
// claim, the coins other test files launched.
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { getConnection } from "../src/solana";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

describe.if(await validatorUp())("per-coin isolation of the claim step (live validator)", () => {
  test("an unreadable coin listed first is skipped; the next coin is still claimed and attributed", () => {
    const dbFile = join(config.paths.dataDir, "isolation.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
    const proc = Bun.spawnSync(["bun", "test/helpers/claim-isolation.ts"], {
      cwd: config.paths.engineRoot, env: { ...process.env, PAD_DB_FILE: dbFile }, stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString().trim().split("\n").filter((l) => l.startsWith("{")).pop()!) as {
      broken: string; mint: string; harvests: { mint: string; soldForZatsQuote: string }[]; unconfirmed: number;
    };
    expect(out.harvests.find((h) => h.mint === out.broken)).toBeUndefined(); // retried next epoch
    expect(out.harvests.find((h) => h.mint === out.mint)?.soldForZatsQuote).toBe("160000"); // 80% of the 1% fee on a 20,000,000 buy
    expect(out.unconfirmed).toBe(0); // nothing was signed for the broken coin
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  }, 120_000);
});
