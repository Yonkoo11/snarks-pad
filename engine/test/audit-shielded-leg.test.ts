// Audit S2 PoCs on the shielded leg, with a stub zcash-devtool that records its
// arguments (no chain needed).
//   S2-05  outside local mode the shielded payout spends from the REGTEST wallet
//          path, not the treasury wallet the swap delivered into
//   S2-06  a failed devtool `pay` puts every recipient's full u1 into the error
//          text that scripts/epoch.ts logs
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import { payBatch } from "../src/zcash/devtool";
import type { SwapAdapter } from "../src/swap/types";

const U1 = "u1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(6); // shape of a mainnet unified address
const TXID = "ab".repeat(32);
const work = mkdtempSync(join(tmpdir(), "audit-devtool-"));
const log = join(work, "argv.log");
const stub = join(work, "zcash-devtool");
const failingStub = join(work, "zcash-devtool-fail");

type Mutable = { -readonly [K in keyof typeof config]: (typeof config)[K] } & Record<string, unknown>;
const cfg = config as unknown as Mutable;
const paths = config.paths as unknown as Record<string, string>;
const near = config.near1click as unknown as Record<string, unknown>;
const saved = { isLocal: config.isLocal, bin: paths.zcashDevtoolBin, dir: near.treasuryWalletDir, id: near.treasuryIdentityFile };

beforeAll(() => {
  // pay: record argv and print a txid. The failing stub echoes its arguments on stderr (as a CLI usage error does) and exits 1.
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\necho "${TXID}"\n`);
  writeFileSync(failingStub, `#!/bin/sh\necho "error: invalid payment request: $@" >&2\nexit 1\n`);
  chmodSync(stub, 0o755);
  chmodSync(failingStub, 0o755);
});

afterEach(() => {
  cfg.isLocal = saved.isLocal;
  paths.zcashDevtoolBin = saved.bin!;
  near.treasuryWalletDir = saved.dir;
  near.treasuryIdentityFile = saved.id;
});

const settledSwap: SwapAdapter = {
  provider: "near-1click",
  quote: async () => ({ outZats: 0n }),
  submit: async () => ({ ref: "unused" }),
  status: async () => ({ status: "settled", amountOutZats: 0n }),
};

describe("audit S2: shielded leg", () => {
  test("S2-05: outside local mode the shielded payout spends from TREASURY_WALLET_DIR (the wallet the swap paid), never the regtest path", async () => {
    db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
    db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
    db.getDb().query("DELETE FROM carry").run();
    const id = `epoch-audit-${crypto.randomUUID()}`;
    db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "1000000", feeZats: "0", status: "ok", swapProvider: "near-1click", swapRef: id, swapState: "settled", swapAmountOutZats: "200000", zcashTxids: "[]" });
    db.planPayout({ epochId: id, wallet: "Holder1111111111111111111111111111111111111", kind: "shielded", amountZats: "190000", zcashAddress: U1 });

    const treasuryDir = join(work, "mainnet-treasury");
    cfg.isLocal = false;
    paths.zcashDevtoolBin = stub;
    near.treasuryWalletDir = treasuryDir;
    near.treasuryIdentityFile = `${treasuryDir}.identity.age`;
    writeFileSync(log, "");

    await runEpoch(settledSwap, async () => {});
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain(`-w ${treasuryDir} pay -i ${treasuryDir}.identity.age`);
    expect(db.getPayouts(id)[0]!.sig).toBe(TXID);
  });

  test("S2-06: a failed pay never carries a recipient's full u1 in its error", () => {
    paths.zcashDevtoolBin = failingStub;
    let message = "";
    try {
      payBatch(join(work, "w"), join(work, "w.identity.age"), [{ address: U1, zats: 100_000n }]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("zcash-devtool pay failed");
    expect(message).not.toContain(U1);
    expect(message).not.toMatch(/u1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}/);
  });
});
