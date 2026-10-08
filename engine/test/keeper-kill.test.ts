// The keeper loop killed at random points mid-epoch, then restarted: every holder is paid exactly once and the
// claim is counted exactly once (checked on chain, not from the engine's own tables). Real `bun run keeper`
// processes against the local validator; one round is a graceful SIGTERM, the others are SIGKILL at a random
// moment (a crash anywhere: before the claim, between the claim and the plan, between the two payout batches).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

const zecOf = async (owner: string): Promise<bigint> => {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(config.solana.dbc.quoteMint, new PublicKey(owner), false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};

function stateOf(dbFile: string) {
  const d = new Database(dbFile, { readonly: true });
  try {
    const n = (sql: string) => (d.query(sql).get() as { n: number }).n;
    return {
      epochs: n("SELECT COUNT(*) AS n FROM epochs WHERE status != 'harvesting'"),
      draft: n("SELECT COUNT(*) AS n FROM epochs WHERE status = 'harvesting'"),
      claims: n("SELECT COUNT(*) AS n FROM claim_progress"),
      planned: n("SELECT COUNT(*) AS n FROM payouts"),
      pending: n("SELECT COUNT(*) AS n FROM payouts WHERE sig IS NOT NULL AND sentAt IS NULL"),
      sent: n("SELECT COUNT(*) AS n FROM payouts WHERE sentAt IS NOT NULL"),
      unsent: n("SELECT COUNT(*) AS n FROM payouts WHERE sentAt IS NULL"),
    };
  } finally {
    d.close();
  }
}

describe.if(await validatorUp())("the keeper killed mid-epoch and restarted (real processes, real chain)", () => {
  test("random SIGKILLs and one graceful SIGTERM: each epoch pays every holder exactly once and counts its claim exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-"));
    const dbFile = join(dir, "kill.sqlite");
    const env = {
      ...process.env,
      KILL_DIR: dir,
      PAD_DB_FILE: dbFile,
      PAD_KEEPER_HEALTH_LOG: join(dir, "health.log"),
      PAD_PAUSE_FILE: join(dir, "PAUSED"),
      EPOCH_LOCK_STALE_MS: "1500", // a killed run's lock is takeable almost at once
      PAD_FIRST_EPOCH_AT: "2020-01-01T00:00:00Z", // the first epoch is due immediately
      PAD_EPOCH_EVERY_MS: "1", // and so is every later one
      PAD_RESUME_EVERY_MS: "0",
    };
    const run = (script: string, args: string[] = []) => Bun.spawnSync(["bun", `test/helpers/${script}.ts`, ...args], { cwd: config.paths.engineRoot, env });
    const setup = run("kill-setup");
    if (setup.exitCode !== 0) throw new Error(setup.stderr.toString().slice(-1500));
    const keeperOnce = () => Bun.spawn(["bun", "scripts/keeper.ts", "--once"], { cwd: config.paths.engineRoot, env, stdout: "pipe", stderr: "pipe" });

    const report: string[] = [];
    const ROUNDS = 5;
    for (let round = 1; round <= ROUNDS; round++) {
      const trade = run("kill-trade", [String(round % 10)]); // new fees accrue before every epoch
      if (trade.exitCode !== 0) throw new Error(trade.stderr.toString().slice(-1500));
      const seed = JSON.parse(trade.stdout.toString().trim().split("\n").pop()!) as { accrued: string; holders: string[]; before: Record<string, string> };

      const graceful = round === 3;
      const proc = keeperOnce();
      const delay = 300 + Math.floor(Math.random() * 4_500);
      await Bun.sleep(delay);
      proc.kill(graceful ? "SIGTERM" : "SIGKILL");
      if (graceful) {
        const code = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => "hung")]);
        if (code === "hung") {
          proc.kill("SIGKILL");
          throw new Error(`SIGTERM did not stop the keeper within 30 s (sent after ${delay} ms)`);
        }
        expect(code).toBe(0);
      } else {
        await proc.exited;
      }
      const atKill = stateOf(dbFile);

      // Restart until this round's epoch is complete (a killed run's lock may need a moment to go stale).
      const done = () => {
        const st = stateOf(dbFile);
        return st.epochs === round && st.unsent === 0;
      };
      for (let attempt = 0; attempt < 8 && !done(); attempt++) {
        await keeperOnce().exited;
        if (!done()) await Bun.sleep(1_800);
      }
      expect(done()).toBe(true);

      const d = new Database(dbFile, { readonly: true });
      const epoch = d.query("SELECT id, harvestedZats FROM epochs WHERE status != 'harvesting' ORDER BY at DESC LIMIT 1").get() as { id: string; harvestedZats: string };
      const rows = d.query("SELECT wallet, amountZats, sig FROM payouts WHERE epochId = ? AND sentAt IS NOT NULL").all(epoch.id) as { wallet: string; amountZats: string; sig: string }[];
      const team = BigInt((d.query("SELECT teamGrossZats AS t FROM epochs WHERE id = ?").get(epoch.id) as { t: string }).t);
      d.close();

      // The claim was counted once: the epoch's total is exactly what the pool said was accrued for the partner.
      expect(epoch.harvestedZats).toBe(seed.accrued);
      // Every holder is on chain exactly once at the amount the plan says (a double send would show as 2x).
      let paid = 0n;
      let carried = 0n;
      for (const h of seed.holders) {
        const mine = rows.filter((r) => r.wallet === h);
        expect(mine.length).toBeLessThanOrEqual(1);
        const real = mine.filter((r) => !r.sig.startsWith("carried:"));
        carried += mine.filter((r) => r.sig.startsWith("carried:")).reduce((a, r) => a + BigInt(r.amountZats), 0n);
        const want = real[0] ? BigInt(real[0].amountZats) : 0n;
        expect((await zecOf(h)) - BigInt(seed.before[h]!)).toBe(want);
        paid += want;
      }
      expect(team).toBe((BigInt(seed.accrued) * 2500n) / 10_000n); // the owner policy: the team keeps 25% of the claim
      expect(paid + carried + team).toBe(BigInt(seed.accrued)); // nothing lost, nothing invented
      report.push(`round ${round} (${graceful ? "SIGTERM" : "SIGKILL"} after ${delay} ms, state at kill: ${JSON.stringify(atKill)}): paid ${paid} of ${seed.accrued}`);
    }
    console.log(report.join("\n"));
  }, 600_000);
});
