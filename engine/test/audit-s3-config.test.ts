// Audit S3 sharp edges (audit/S3-SHARP-EDGES.md): operator typos that silently turn a safety off.
//   S3-02  PAYOUTS_PAUSED=true (or yes, on, 2) did NOT pause: only the exact string "1" did. A kill switch must fail safe.
//   S3-03  A non-numeric safety knob became NaN and every comparison against it was false: PAD_SNAPSHOT_MIN_SAMPLES=three
//          turned the anti-sniping sample gate off on mainnet, PAD_SWAP_TREASURY_MIN_CONFS=ten settled a swap at 0
//          confirmations. Startup must refuse instead.
import { afterEach, describe, expect, test } from "bun:test";
import { payoutsPaused } from "../src/pause";

const saved = process.env.PAYOUTS_PAUSED;
afterEach(() => {
  if (saved === undefined) delete process.env.PAYOUTS_PAUSED;
  else process.env.PAYOUTS_PAUSED = saved;
});

describe("audit S3-02: the env kill switch fails safe", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", "2"]) {
    test(`PAYOUTS_PAUSED=${v} pauses`, () => {
      process.env.PAYOUTS_PAUSED = v;
      expect(payoutsPaused()).toEqual({ paused: true, reason: "env" });
    });
  }
  for (const v of ["", "0", "false", "no", "off"]) {
    test(`PAYOUTS_PAUSED=${JSON.stringify(v)} does not pause`, () => {
      process.env.PAYOUTS_PAUSED = v;
      expect(payoutsPaused().reason).not.toBe("env");
    });
  }
});

function importConfig(env: Record<string, string>): number {
  const p = Bun.spawnSync(["bun", "-e", "await import('./src/config.ts')"], {
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAD_MODE: "mainnet", PAD_DB_FILE: "/dev/null", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return p.exitCode;
}

describe("audit S3-03: non-numeric safety knobs are refused at startup", () => {
  test("baseline: mainnet config loads with no overrides", () => {
    expect(importConfig({})).toBe(0);
  });
  for (const name of ["PAD_SNAPSHOT_MIN_SAMPLES", "PAD_SWAP_TREASURY_MIN_CONFS", "EPOCH_LOCK_STALE_MS", "PAD_DELIVERY_RESERVE_BPS", "PAD_SWAP_MAX_LOSS_BPS", "PAD_RPC_MONTHLY_CREDITS"]) {
    test(`${name}=abc is refused`, () => {
      expect(importConfig({ [name]: "abc" })).not.toBe(0);
    });
    test(`${name}=-1 is refused`, () => {
      expect(importConfig({ [name]: "-1" })).not.toBe(0);
    });
  }
});

// PAD_RPC_MONTHLY_CREDITS switches the keeper's RPC budget check on (src/rpcBudget.ts); unset means no check, so a typo must refuse rather than read as unset.
describe("PAD_RPC_MONTHLY_CREDITS: the RPC plan's credits a month", () => {
  function monthlyCredits(env: Record<string, string>): { code: number; value: string } {
    const p = Bun.spawnSync(["bun", "-e", "console.log((await import('./src/config.ts')).config.rpc.monthlyCredits)"], {
      cwd: `${import.meta.dir}/..`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAD_MODE: "mainnet", PAD_DB_FILE: "/dev/null", ...env },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: p.exitCode, value: p.stdout.toString().trim() };
  }

  test("unset or empty is 0, no check; a whole number of credits is taken as it is", () => {
    expect(monthlyCredits({})).toEqual({ code: 0, value: "0" });
    expect(monthlyCredits({ PAD_RPC_MONTHLY_CREDITS: "" })).toEqual({ code: 0, value: "0" });
    expect(monthlyCredits({ PAD_RPC_MONTHLY_CREDITS: "1000000" })).toEqual({ code: 0, value: "1000000" });
  });

  test("0, a fraction and a number with a unit are refused, not read as unset", () => {
    for (const bad of ["0", "1.5", "1M", "1,000,000"]) expect(monthlyCredits({ PAD_RPC_MONTHLY_CREDITS: bad }).code).not.toBe(0);
  });
});
