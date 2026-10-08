// Stress scale run 2026-10-03 (audit/STRESS-REPORT.md scenario 1, run 2): one Solana payout batch "did not land within
// 20000ms" and the whole epoch run stopped there; the next run had to resume it. broadcastAndConfirm sent the signed
// bytes ONCE and then only polled, so a transaction the network dropped was never offered again until a later run.
// A dropped transaction is ordinary on a busy cluster. Resending the SAME signed bytes while waiting is safe (one
// signature, executed at most once) and is what every reliable Solana sender does.
import { afterEach, describe, expect, test } from "bun:test";
import { broadcastAndConfirm, getConnection } from "../src/solana";

const conn = getConnection() as unknown as Record<string, unknown>;
const saved = { send: conn.sendRawTransaction, statuses: conn.getSignatureStatuses };
afterEach(() => {
  conn.sendRawTransaction = saved.send;
  conn.getSignatureStatuses = saved.statuses;
});

/** A cluster that drops the first `drops` copies of a transaction and lands the next one. */
function droppingCluster(drops: number) {
  let sends = 0;
  let landed = false;
  conn.sendRawTransaction = async () => {
    sends++;
    if (sends > drops) landed = true;
    return "sig";
  };
  conn.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [landed ? { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null] });
  return { sends: () => sends };
}

describe("broadcastAndConfirm resends the same signed bytes while it waits", () => {
  test("a transaction dropped once still lands within one call", async () => {
    const c = droppingCluster(1);
    await broadcastAndConfirm(new Uint8Array([1, 2, 3]), "sig", 3_000, "confirmed", 200);
    expect(c.sends()).toBeGreaterThanOrEqual(2);
  });

  test("a transaction that never lands still fails after the timeout, having been offered more than once", async () => {
    const c = droppingCluster(Number.MAX_SAFE_INTEGER);
    await expect(broadcastAndConfirm(new Uint8Array([1]), "sig", 1_000, "confirmed", 200)).rejects.toThrow(/did not land/);
    expect(c.sends()).toBeGreaterThanOrEqual(2); // offered more than once (polls are 500 ms apart)
  });

  test("a first send refused for a real reason (not 'already processed') still throws at once", async () => {
    droppingCluster(0);
    conn.sendRawTransaction = async () => { throw new Error("Transaction simulation failed: insufficient funds"); };
    await expect(broadcastAndConfirm(new Uint8Array([1]), "sig", 1_000, "confirmed", 200)).rejects.toThrow(/insufficient funds/);
  });
});
