// Stress chaos round 32 (audit/STRESS-REPORT.md D11): keeper 1 was frozen right after marking a Zcash chunk
// `zcash-intent:` and before devtool ran; keeper 2 took the stale lock, found no devtool running and nothing sent,
// made the rows fresh and paid the chunk; keeper 1 woke up and went straight on to `pay` the same chunk: the lock was
// checked before the intent, never again before the money moved. Its transaction was rejected only because it picked
// notes keeper 2's transaction was already spending. The lock is now checked again right before devtool runs.
import { describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { sendZcashPayouts } from "../src/epoch/zcashPayout";
import { TREASURY_DIR, TREASURY_IDENTITY } from "../src/zcash/regtest";
import { walletExists } from "../src/zcash/devtool";

describe.if(config.isLocal && walletExists(TREASURY_DIR))("the lock is checked right before devtool pays", () => {
  test("a lock lost after the chunk was marked as intended stops the payment before devtool runs", async () => {
    let lost = false;
    let checks = 0;
    const run = sendZcashPayouts([{ wallet: "w", zcashAddress: "not-an-address", amount: 200_000n }], TREASURY_DIR, TREASURY_IDENTITY, {
      beforeChunk: () => {
        checks++;
        if (lost) throw new Error("fence: lock lost");
      },
      onIntent: () => {
        lost = true; // another keeper takes the lock while this one is frozen here
      },
      onPending: () => {},
      onSent: () => {},
    });
    await expect(run).rejects.toThrow("fence: lock lost");
    expect(checks).toBe(2);
  }, 120_000);
});
