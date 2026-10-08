// Audit O-1 on the real chain: the sniper's stack, bought after every window sample and before the claim, earns nothing.
import { describe, expect, test } from "bun:test";
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

interface Outcome {
  creator: string; honest: string; sniper: string; harvest: { soldForZatsQuote: string; teamZats: string }[]; shares: Record<string, string>;
}

function attack(extraEnv: Record<string, string>): Outcome {
  const dir = mkdtempSync(join(tmpdir(), "snipe-"));
  const run = Bun.spawnSync(["bun", "test/helpers/snapshot-attack.ts"], {
    cwd: config.paths.engineRoot,
    env: { ...process.env, PAD_DB_FILE: join(dir, "snipe.sqlite"), ...extraEnv },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString().slice(-1500) + run.stdout.toString().slice(-500));
  return JSON.parse(run.stdout.toString().trim().split("\n").pop()!) as Outcome;
}

describe.if(await validatorUp())("snapshot sniping against a real coin", () => {
  test("control, the old single claim-time snapshot: the sniper takes most of the claim", () => {
    const out = attack({ SNIPE_CONTROL: "1", PAD_SNAPSHOT_MIN_SAMPLES: "0" });
    const sniper = BigInt(out.shares[out.sniper] ?? "0");
    const holdersPool = BigInt(out.harvest[0]!.soldForZatsQuote) - BigInt(out.harvest[0]!.teamZats);
    expect(sniper).toBeGreaterThan(holdersPool / 2n); // most of what the holders were to split
  }, 120_000);

  test("a buyer that arrives after the window samples gets ~0 of the claim; holders present throughout split it", () => {
    const out = attack({ PAD_SNAPSHOT_MIN_SAMPLES: "3" });
    const claimed = BigInt(out.harvest[0]!.soldForZatsQuote);
    expect(claimed).toBeGreaterThan(0n);
    expect(BigInt(out.shares[out.sniper] ?? "0")).toBe(0n);
    const paid = BigInt(out.shares[out.honest] ?? "0") + BigInt(out.shares[out.creator] ?? "0");
    const team = BigInt(out.harvest[0]!.teamZats);
    expect(team).toBe((claimed * 2500n) / 10_000n); // the owner policy: the team keeps 25%
    expect(paid + team).toBe(claimed); // everything else went to the holders that stayed
    expect(BigInt(out.shares[out.honest] ?? "0")).toBeGreaterThan(0n);
  }, 120_000);
});
