// zcash-devtool holds the treasury key. (1) Its binary is pinned to a checksum before every use
// (audit/S2-SUPPLY-CHAIN.md). (2) O-5: its `pay` takes the payment request on argv only; a canary that fails the
// day the pinned binary offers a file or stdin input, so payBatch can stop putting recipient addresses on argv.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { syncWallet, verifyDevtoolBinary } from "../src/zcash/devtool";

const realBin = config.paths.zcashDevtoolBin;
const realPin = config.zcash.devtoolSha256;
afterEach(() => {
  (config.paths as { zcashDevtoolBin: string }).zcashDevtoolBin = realBin;
  (config.zcash as { devtoolSha256: string | null }).devtoolSha256 = realPin;
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeBinary(body: string): { path: string; marker: string; content: string } {
  const dir = mkdtempSync(join(tmpdir(), "devtool-"));
  const marker = join(dir, "ran");
  const content = `#!/bin/sh\ntouch ${marker}\n${body}\n`;
  const path = join(dir, "zcash-devtool");
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return { path, marker, content };
}

describe("the devtool binary is checked against its pinned sha256", () => {
  test("a matching checksum runs; a different one is refused BEFORE the binary executes", () => {
    const good = fakeBinary("echo ok");
    (config.paths as { zcashDevtoolBin: string }).zcashDevtoolBin = good.path;
    (config.zcash as { devtoolSha256: string | null }).devtoolSha256 = sha(good.content);
    expect(() => verifyDevtoolBinary()).not.toThrow();
    expect(() => syncWallet("/nonexistent")).not.toThrow(); // runs the stub (exit 0)
    expect(existsSync(good.marker)).toBe(true);

    const evil = fakeBinary("echo stolen");
    (config.paths as { zcashDevtoolBin: string }).zcashDevtoolBin = evil.path;
    expect(() => syncWallet("/nonexistent")).toThrow(/does not match ZCASH_DEVTOOL_SHA256/);
    expect(existsSync(evil.marker)).toBe(false); // never executed
  });

  test("a binary replaced after it was verified is checked again", async () => {
    const b = fakeBinary("echo ok");
    (config.paths as { zcashDevtoolBin: string }).zcashDevtoolBin = b.path;
    (config.zcash as { devtoolSha256: string | null }).devtoolSha256 = sha(b.content);
    verifyDevtoolBinary();
    await Bun.sleep(20);
    writeFileSync(b.path, "#!/bin/sh\necho replaced\n");
    expect(() => verifyDevtoolBinary()).toThrow(/does not match/);
  });
});

describe.if(existsSync(realBin))("O-5: the pinned devtool's pay command has no file or stdin input for the payment request", () => {
  test("`wallet pay --help` offers --payment-uri only; if this fails, switch payBatch to the new input and close O-5", () => {
    const help = Bun.spawnSync([realBin, "wallet", "pay", "--help"], { env: { PATH: process.env.PATH! } }).stdout.toString();
    expect(help).toContain("--payment-uri <PAYMENT_URI>");
    expect(help).not.toMatch(/payment[-_ ](uri[-_ ])?file|--payment-file|--payment-uri-file|stdin|@file|reads? from/i);
  });
});
