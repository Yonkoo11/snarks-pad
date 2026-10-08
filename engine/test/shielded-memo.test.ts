// The shielded leg puts "SNARKS pad reward, epoch <id>" on every output it sends (a stub zcash-devtool records argv;
// the real devtool and a recipient wallet are in zcash-memo.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import type { SwapAdapter } from "../src/swap/types";

const U1 = "u1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(6);
const work = mkdtempSync(join(tmpdir(), "memo-devtool-"));
const log = join(work, "argv.log");
const stub = join(work, "zcash-devtool");
writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\necho "${"cd".repeat(32)}"\n`);
chmodSync(stub, 0o755);

const cfg = config as unknown as Record<string, unknown>;
const paths = config.paths as unknown as Record<string, string>;
const near = config.near1click as unknown as Record<string, unknown>;
const saved = { isLocal: config.isLocal, bin: paths.zcashDevtoolBin, dir: near.treasuryWalletDir, id: near.treasuryIdentityFile };
afterEach(() => {
  cfg.isLocal = saved.isLocal;
  paths.zcashDevtoolBin = saved.bin!;
  near.treasuryWalletDir = saved.dir;
  near.treasuryIdentityFile = saved.id;
});

const settled: SwapAdapter = { provider: "near-1click", quote: async () => ({ outZats: 0n }), submit: async () => ({ ref: "unused" }), status: async () => ({ status: "settled", amountOutZats: 0n }) };

describe("receipt memo on the shielded leg", () => {
  test("every output of the batch carries the epoch's memo, indexed per ZIP 321", async () => {
    db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
    db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
    db.getDb().query("DELETE FROM carry").run();
    const id = `epoch-memo-${crypto.randomUUID()}`;
    db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "3000000", feeZats: "0", status: "ok", swapProvider: "near-1click", swapRef: id, swapState: "settled", swapAmountOutZats: "3000000", zcashTxids: "[]" });
    for (const w of ["HolderA1111111111111111111111111111111111111", "HolderB1111111111111111111111111111111111111"]) {
      db.planPayout({ epochId: id, wallet: w, kind: "shielded", amountZats: "1000000", zcashAddress: U1 });
    }
    const dir = join(work, "treasury");
    cfg.isLocal = false;
    paths.zcashDevtoolBin = stub;
    near.treasuryWalletDir = dir;
    near.treasuryIdentityFile = `${dir}.identity.age`;
    writeFileSync(log, "");

    await runEpoch(settled, async () => {});
    const argv = readFileSync(log, "utf8");
    const memo = Buffer.from(`SNARKS pad reward, epoch ${id}`).toString("base64url");
    expect(argv).toContain(`&memo=${memo}`);
    expect(argv).toContain(`&memo.1=${memo}`);
    expect(argv.match(/memo(\.\d)?=/g)!.length).toBe(2);
    db.resolveAlerts("epoch_fee_unread", id); // the stub devtool has no fee line; this test's alert must not leak into other files' open-alert checks
  });
});
