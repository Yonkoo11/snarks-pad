// The test network's claim co-signer (DEVNET_OWNER_KEYPAIR) is read in devnet mode only: a mainnet or local process ignores it and says so, because the
// owner approves every mainnet claim from their phone and no owner key may ever act on a server (ops/MAINNET-RUNBOOK.md section 1).
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ENGINE = resolve(import.meta.dir, "..");
function configIn(mode: string, extra: Record<string, string> = {}): { value: string; err: string } {
  const r = Bun.spawnSync(["bun", "-e", 'import { config } from "./src/config"; console.log(JSON.stringify(config.devnetCoSignerKeypair ?? null))'], {
    cwd: ENGINE,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: "test", PAD_MODE: mode, PAD_ENV_FILE: "/nonexistent", DEVNET_OWNER_KEYPAIR: "/keys/devnet-owner.json", ...extra },
  });
  return { value: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr) };
}

describe("DEVNET_OWNER_KEYPAIR, the test network's claim co-signer", () => {
  test("devnet mode reads it", () => {
    expect(configIn("devnet").value).toBe('"/keys/devnet-owner.json"');
  });
  test("mainnet mode ignores it and says so at startup; local mode too", () => {
    const main = configIn("mainnet");
    expect(main.value).toBe("null");
    expect(main.err).toContain("DEVNET_OWNER_KEYPAIR is set but PAD_MODE=mainnet: ignored");
    expect(configIn("local").value).toBe("null");
  });
  test("a blank value counts as unset", () => {
    expect(configIn("devnet", { DEVNET_OWNER_KEYPAIR: "  " }).value).toBe("null");
  });
});
