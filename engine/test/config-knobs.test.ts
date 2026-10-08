// Audit S6 (lens 6-1, 6-4): what a blank, misspelt or missing setting does on mainnet.
//   Before: BigInt("") read a blank PAD_SWAP_MAX_ZATS as a cap of 0 zats (every opted-in holder paid on the public rail, no alert);
//   Number("") read a blank PAD_EPOCH_EVERY_HOURS as a round every tick and a misspelt PAD_STUCK_MAX_ATTEMPTS as "never park";
//   a mainnet process with no SOLANA_MAINNET_RPC ran on the public RPC without a word.
import { describe, expect, test } from "bun:test";
import { mainnetStartupProblems } from "../src/startupChecks";

/** Loads the config in a child process with exactly this environment and prints the asked-for expression; exit 1 means startup was refused. */
function configValue(env: Record<string, string>, expr: string): { exitCode: number; out: string } {
  const p = Bun.spawnSync(["bun", "-e", `const { config } = await import('./src/config.ts'); console.log(String(${expr}));`], {
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAD_MODE: "mainnet", PAD_DB_FILE: "/dev/null", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: p.exitCode, out: new TextDecoder().decode(p.stdout).trim() };
}

describe("lens 6-1: numeric knobs read a blank as the default and refuse a typo", () => {
  test("a blank PAD_SWAP_MAX_ZATS is the 0.5 ZEC default, not a cap of 0", () => {
    expect(configValue({ PAD_SWAP_MAX_ZATS: "" }, "config.near1click.maxSwapZats")).toEqual({ exitCode: 0, out: "50000000" });
    expect(configValue({ PAD_SWAP_MAX_ZATS: "  " }, "config.near1click.maxSwapZats")).toEqual({ exitCode: 0, out: "50000000" });
    expect(configValue({ PAD_SWAP_MAX_ZATS: "250000000" }, "config.near1click.maxSwapZats")).toEqual({ exitCode: 0, out: "250000000" });
  });
  test("a misspelt zat amount stops startup", () => {
    expect(configValue({ PAD_SWAP_MAX_ZATS: "0.5" }, "config.near1click.maxSwapZats").exitCode).toBe(1);
    expect(configValue({ PAD_SHIELDED_MIN_PER_HOLDER_ZATS: "1e5" }, "config.epoch.shieldedMinPerHolderZats").exitCode).toBe(1);
  });
  test("a blank cadence is the documented default, never a round every tick", () => {
    expect(configValue({ PAD_EPOCH_EVERY_HOURS: "" }, "config.scheduler.epochEveryMs")).toEqual({ exitCode: 0, out: String(48 * 3_600_000) });
    expect(configValue({ PAD_SHIELDED_EVERY_DAYS: "" }, "config.scheduler.shieldedEveryMs")).toEqual({ exitCode: 0, out: String(7 * 86_400_000) });
    expect(configValue({ PAD_EPOCH_EVERY_HOURS: "0" }, "config.scheduler.epochEveryMs").exitCode).toBe(1);
  });
  test("a misspelt stuck limit stops startup instead of never parking", () => {
    expect(configValue({ PAD_STUCK_MAX_ATTEMPTS: "twenty" }, "config.epoch.stuckMaxAttempts").exitCode).toBe(1);
    expect(configValue({ PAD_STUCK_MAX_ATTEMPTS: "" }, "config.epoch.stuckMaxAttempts")).toEqual({ exitCode: 0, out: "24" });
  });
});

describe("lens 6-4: what a mainnet process refuses or calls out at start", () => {
  const full = { SOLANA_MAINNET_RPC: "https://rpc.example/key", ZCASH_LIGHTWALLETD: "lwd.example:443", PUBLIC_DIR: "/srv/pad/public", LAUNCHPAD_SIGNER_PATH: "/etc/pad/api-keys/launchpad-signer.json" };
  test("a complete mainnet environment starts quietly", () => {
    expect(mainnetStartupProblems("keeper", "mainnet", full)).toEqual({ fatal: [], warnings: [] });
    expect(mainnetStartupProblems("api", "mainnet", full)).toEqual({ fatal: [], warnings: [] });
  });
  test("no SOLANA_MAINNET_RPC is fatal for both processes", () => {
    const { SOLANA_MAINNET_RPC: _drop, ...rest } = full;
    expect(mainnetStartupProblems("keeper", "mainnet", rest).fatal.join()).toContain("SOLANA_MAINNET_RPC");
    expect(mainnetStartupProblems("api", "mainnet", { ...rest, SOLANA_MAINNET_RPC: "  " }).fatal.join()).toContain("SOLANA_MAINNET_RPC");
  });
  test("the local-chain lightwalletd default and an unserved PUBLIC_DIR are warnings, PUBLIC_DIR only for the API", () => {
    const { ZCASH_LIGHTWALLETD: _a, PUBLIC_DIR: _b, ...rest } = full;
    expect(mainnetStartupProblems("keeper", "mainnet", rest)).toMatchObject({ fatal: [] });
    expect(mainnetStartupProblems("keeper", "mainnet", rest).warnings.map((w) => w.split(" ")[0])).toEqual(["ZCASH_LIGHTWALLETD"]);
    expect(mainnetStartupProblems("api", "mainnet", rest).warnings.map((w) => w.split(" ")[0])).toEqual(["ZCASH_LIGHTWALLETD", "PUBLIC_DIR"]);
  });
  test("no launch signer is a warning for the API only (launches build without the pad's signature)", () => {
    const { LAUNCHPAD_SIGNER_PATH: _a, ...rest } = full;
    expect(mainnetStartupProblems("keeper", "mainnet", rest)).toEqual({ fatal: [], warnings: [] });
    expect(mainnetStartupProblems("api", "mainnet", rest).warnings.map((w) => w.split(" ")[0])).toEqual(["LAUNCHPAD_SIGNER_PATH"]);
  });
  test("devnet and local are not checked", () => {
    expect(mainnetStartupProblems("keeper", "devnet", {})).toEqual({ fatal: [], warnings: [] });
    expect(mainnetStartupProblems("api", "local", {})).toEqual({ fatal: [], warnings: [] });
  });
});
