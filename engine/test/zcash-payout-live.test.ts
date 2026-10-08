// Live proof of the fixed defect (review finding 1, Zcash half; and finding 8:
// track mined/mempool status and resume by it), against the real local
// zebrad+zainod regtest chain (guarded: skipped if it isn't reachable). Real
// devtool `pay`, real mining, real chain status reads -- not a mock.
import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { sendZcashPayouts } from "../src/epoch/zcashPayout";
import { TREASURY_DIR, TREASURY_IDENTITY, zcashTxStatus, txPoolActions, mineBlocks, syncToTip } from "../src/zcash/regtest";
import * as db from "../src/db";

async function checkReachable(): Promise<boolean> {
  try {
    const res = await fetch(config.zcash.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getblockcount", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function deriveRegtestUA(): string {
  const proc = Bun.spawnSync([
    config.paths.zcashDevtoolBin, "wallet", "derive-address",
    "--mnemonic", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "--network", "regtest",
  ]);
  return /Unified Address:\s*(\S+)/.exec(new TextDecoder().decode(proc.stdout))![1]!;
}

const HAS_REGTEST = config.isLocal && (await checkReachable());

describe.if(HAS_REGTEST)("sendZcashPayouts against the real local regtest chain (finding 1, finding 8)", () => {
  test("a chunk's txid is recorded pending the instant devtool returns it, BEFORE it is confirmed sent; zcashTxStatus distinguishes mined from a never-broadcast txid", async () => {
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    const wallet = `wallet-${crypto.randomUUID()}`;
    const zcashAddress = deriveRegtestUA();
    db.planPayout({ epochId, wallet, kind: "shielded", amountZats: "20000", zcashAddress });

    const calls: string[] = [];
    const result = await sendZcashPayouts(
      [{ wallet, zcashAddress, amount: 20000n }],
      TREASURY_DIR,
      TREASURY_IDENTITY,
      {
        onPending: (wallets, txid) => {
          calls.push("pending");
          expect(txid).toMatch(/^[0-9a-f]{64}$/); // a real txid, not a placeholder
          for (const w of wallets) db.markPayoutPending(epochId, w, "shielded", txid);
        },
        onSent: (wallets, txid) => {
          calls.push("sent");
          for (const w of wallets) db.markPayoutSent(epochId, w, "shielded", txid);
        },
      },
    );

    expect(calls).toEqual(["pending", "sent"]); // pending is always recorded before sent, never after
    expect(result.txids).toHaveLength(1);
    const txid = result.txids[0]!;

    // Real chain check: it actually landed.
    expect(await zcashTxStatus(txid)).toBe("mined");
    // NU6.3 (Ironwood): the batch lands in the Ironwood pool (mainnet accepts no new Orchard outputs)
    // and pays ZIP-317's 5000 x (recipients + 1 change) zats.
    expect(await txPoolActions(txid)).toEqual({ ironwood: 2, orchard: 0 });
    expect(result.feeZats).toBe(10_000n);
    // A syntactically valid but never-broadcast txid is distinguishable: this
    // is exactly what lets resume tell "crash before broadcast, safe to
    // resend" apart from "broadcast but not yet mined, do not resend".
    expect(await zcashTxStatus("f".repeat(64))).toBe("unknown");
    expect(db.getUnsentPayouts(epochId, "shielded")).toHaveLength(0);
  }, 60_000);

  test("crash simulated right after devtool returns a txid (before mining/confirmation): the pending record survives, chain shows it in the mempool, and resume mines it to landed without ever resending", async () => {
    const epochId = `epoch-test-${crypto.randomUUID()}`;
    const wallet = `wallet-${crypto.randomUUID()}`;
    const zcashAddress = deriveRegtestUA();
    db.planPayout({ epochId, wallet, kind: "shielded", amountZats: "15000", zcashAddress });

    let capturedTxid = "";
    await expect(
      sendZcashPayouts([{ wallet, zcashAddress, amount: 15000n }], TREASURY_DIR, TREASURY_IDENTITY, {
        onPending: (wallets, txid) => {
          capturedTxid = txid;
          for (const w of wallets) db.markPayoutPending(epochId, w, "shielded", txid);
          throw new Error("simulated crash: process dies right after devtool returns the txid, before mining/confirmation");
        },
        onSent: () => {
          throw new Error("must never be reached");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    const pending = db.getPendingPayouts(epochId, "shielded");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sig).toBe(capturedTxid);

    // Real chain check: it was genuinely broadcast (devtool's `pay` already
    // sent it) but not yet mined -- the resume rule is "leave it pending, do
    // NOT resend" (resending would double-pay once it does confirm).
    expect(await zcashTxStatus(capturedTxid)).toBe("mempool");

    // Resume: mine it in, then resolve exactly as src/epoch/engine.ts's
    // resumePendingShieldedPayouts would (chain status -> mined -> markSent),
    // never a second `pay`.
    await mineBlocks(1);
    await syncToTip(TREASURY_DIR);
    expect(await zcashTxStatus(capturedTxid)).toBe("mined");
    db.markPayoutSent(epochId, wallet, "shielded", capturedTxid);
    expect(db.getUnsentPayouts(epochId, "shielded")).toHaveLength(0);
  }, 60_000);
});
