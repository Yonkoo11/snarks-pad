// PAD_HELD_CLAIM_KINDS (owner decision 2026-10-12): a round may leave whole claim kinds in the pool and pay out only the rest, so a pool keeps earning
// for later rounds. A held kind whose claim already started still finishes (its ZEC may be on its way). An unknown kind name refuses startup.
import { describe, expect, test } from "bun:test";

function configValue(env: Record<string, string>, expr: string): { exitCode: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "-e", `const { config } = await import('./src/config.ts'); console.log(String(${expr}));`], {
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAD_MODE: "local", PAD_DB_FILE: "/dev/null", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: p.exitCode, out: new TextDecoder().decode(p.stdout).trim(), err: new TextDecoder().decode(p.stderr) };
}

describe("PAD_HELD_CLAIM_KINDS", () => {
  test("unset or blank holds nothing", () => {
    expect(configValue({}, "[...config.epoch.heldClaimKinds].join(',')")).toMatchObject({ exitCode: 0, out: "" });
    expect(configValue({ PAD_HELD_CLAIM_KINDS: "  " }, "[...config.epoch.heldClaimKinds].join(',')")).toMatchObject({ exitCode: 0, out: "" });
  });
  test("a list of known kinds is read, spaces and case ignored", () => {
    expect(configValue({ PAD_HELD_CLAIM_KINDS: " damm_position, Surplus " }, "[...config.epoch.heldClaimKinds].sort().join(',')")).toMatchObject({ exitCode: 0, out: "damm_position,surplus" });
  });
  test("an unknown kind name stops startup and names the known ones", () => {
    const r = configValue({ PAD_HELD_CLAIM_KINDS: "damm" }, "1");
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("PAD_HELD_CLAIM_KINDS names an unknown claim kind");
    expect(r.err).toContain("trading, damm_position, surplus");
  });
});
