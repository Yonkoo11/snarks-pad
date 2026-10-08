// Audit S2-14: zcash-devtool was spawned with the engine's whole environment,
// so every keeper secret in env (RPC keys, NEAR1CLICK_API_KEY, ...) was visible
// to the binary that also holds the treasury key. It gets only what it needs.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { payBatch } from "../src/zcash/devtool";

const work = mkdtempSync(join(tmpdir(), "audit-env-"));
const stub = join(work, "zcash-devtool");
writeFileSync(stub, `#!/bin/sh\nenv >&2\nexit 1\n`);
chmodSync(stub, 0o755);
const paths = config.paths as unknown as Record<string, string>;
const savedBin = paths.zcashDevtoolBin!;
afterEach(() => {
  paths.zcashDevtoolBin = savedBin;
  delete process.env.AUDIT_FAKE_SECRET;
});

test("S2-14: zcash-devtool does not inherit the keeper's environment", () => {
  paths.zcashDevtoolBin = stub;
  process.env.AUDIT_FAKE_SECRET = "s3cr3t-value-for-test";
  let message = "";
  try {
    payBatch(join(work, "w"), join(work, "w.age"), [{ address: "uregtest1qqqq", zats: 1n }]);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("RUST_LOG=warn");
  expect(message).not.toContain("s3cr3t-value-for-test");
});
