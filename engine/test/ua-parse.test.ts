import { describe, expect, test } from "bun:test";
import { checkZcashAddress, maskZcashAddress } from "../src/zcash/address";
import { config } from "../src/config";
import { existsSync } from "node:fs";

// zcash-devtool's `derive-address` needs no wallet or running chain (offline),
// so these tests don't depend on the regtest chain being up.
const HAS_DEVTOOL = existsSync(config.paths.zcashDevtoolBin);
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function derive(network: "regtest" | "test" | "main"): { ua: string; taddr: string } {
  const proc = Bun.spawnSync([
    config.paths.zcashDevtoolBin,
    "wallet",
    "derive-address",
    "--mnemonic",
    TEST_MNEMONIC,
    "--network",
    network,
  ]);
  const out = new TextDecoder().decode(proc.stdout);
  const ua = /Unified Address:\s*(\S+)/.exec(out)?.[1];
  const taddr = /Transparent Address:\s*(\S+)/.exec(out)?.[1];
  if (!ua || !taddr) throw new Error(`derive-address failed: ${out}`);
  return { ua, taddr };
}

describe.if(HAS_DEVTOOL)("checkZcashAddress (real zcash-devtool binary)", () => {
  test("accepts a real regtest unified address with an Orchard receiver", () => {
    const { ua } = derive("regtest");
    expect(checkZcashAddress(ua, "regtest")).toEqual({ ok: true });
  });

  test("rejects a bare transparent address (no Orchard receiver)", () => {
    const { taddr } = derive("regtest");
    expect(checkZcashAddress(taddr, "regtest")).toEqual({ ok: false, reason: "no_orchard_receiver" });
  });

  test("rejects a unified address from the wrong network", () => {
    const { ua } = derive("test");
    expect(checkZcashAddress(ua, "regtest")).toEqual({ ok: false, reason: "bad_address" });
  });

  test("rejects a garbage string", () => {
    expect(checkZcashAddress("not-a-zcash-address", "regtest")).toEqual({ ok: false, reason: "bad_address" });
  });

  test("rejects an empty string", () => {
    expect(checkZcashAddress("", "regtest")).toEqual({ ok: false, reason: "bad_address" });
  });
});

describe("maskZcashAddress", () => {
  test("never returns the full address", () => {
    const { ua } = HAS_DEVTOOL ? derive("regtest") : { ua: "uregtest1abcdefghijklmnopqrstuvwxyz" };
    const masked = maskZcashAddress(ua);
    expect(masked).not.toBe(ua);
    expect(masked.length).toBeLessThan(ua.length);
    expect(masked).toContain("…");
  });
});
