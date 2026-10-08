// Audit S6-B1: a shielded payout row left pending with a Zcash txid is resolved in every mode.
//   Before: outside the local chain nothing looked at such a row again (engine.ts returned before the status check). The intent
//   recovery (audit O-4) writes exactly that state after a keeper died inside devtool's pay, and so does a keeper killed
//   between the broadcast and its "sent" mark. The epoch stayed unfinished, was parked after a day, its amount counted as
//   owed from the treasury wallet (which had paid it), and once the wallet held less than that no new epoch could start.
//   Now: the row's txid is looked up in the treasury wallet's own record (synced first): mined = sent, waiting = left
//   pending, unknown = cleared and sent once. No chain here: the lookup is injected.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { runEpoch, type ShieldedTxStatus } from "../src/epoch/engine";
import type { IsolationDeps } from "../src/epoch/stuck";
import type { SwapAdapter } from "../src/swap/types";
import { parseSentTxStatus } from "../src/zcash/devtool";

const noClaims = async () => {};
const isolated: IsolationDeps = { keeperZecBalance: async () => 0n, treasurySpendableZats: async () => 0n };
const neverSwap: SwapAdapter = {
  provider: "simulated",
  quote: async () => ({ outZats: 0n }),
  submit: async () => { throw new Error("a settled epoch must not swap again"); },
  status: async () => { throw new Error("a settled epoch must not poll the swap"); },
};

const TXID = "6180b2929ec8f1581402972ddd659ee9100c95c7f5032fa72a35eccdcc11445a";
const UNMINED = "a".repeat(64);
// The real testnet treasury listing for TXID (addresses shortened by redactZcashAddresses, as logged), plus an unmined one.
const LISTING = `algnn926m5uuc68jkx3g4a2zlkf2vmf3gwks88rnz7uw2jpn7
${TXID}
     Mined: 4429808 (2026-10-01 20:59:13.0 +00:00:00)
    Amount:   0.01170984 TAZ
  Fee paid:   0.00015000 TAZ
  Sent 2 notes, received 0 notes, 0 memos
  Output 0 (Ironwood)
    Value:   0.00014016 TAZ (Change)
    Memo: Memo::Empty
  Output 1 (Ironwood)
    Value:   0.00636175 TAZ
    Sent from account: 30905d88-4a7a-466f-ba1a-7be96a9f7e85 (pad-treasury)
    To: utes…czgn
    Memo: Memo::Empty
${UNMINED}
    Amount:   0.00100000 TAZ
  Fee paid:   0.00015000 TAZ
  Sent 1 notes, received 0 notes, 0 memos
`;

/** The stuck state: swap settled, the shielded rows pending with a txid, status partial. Everything else in the shared DB set aside. */
function pendingEpoch(txid: string): string {
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("UPDATE epochs SET status = 'ok' WHERE status IN ('harvesting','partial')").run();
  const id = `epoch-pend-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date(Date.now() + 60_000).toISOString(), coinMints: "[]", harvestedZats: "3360000", feeZats: "0", status: "partial", swapProvider: "near-1click", swapRef: "ref", swapState: "settled", swapAmountOutZats: "1200000", zcashTxids: "[]" });
  for (const [wallet, amount] of [["optin-a", "636175"], ["optin-b", "519809"]] as const) {
    db.planPayout({ epochId: id, wallet, kind: "shielded", amountZats: amount, zcashAddress: `utest1${wallet}` });
    db.markPayoutPending(id, wallet, "shielded", txid);
  }
  return id;
}

describe("audit S6-B1: pending shielded rows with a txid are resolved on the real networks too", () => {
  test("the treasury wallet says the tx is mined: both rows are sent with that txid and the epoch finishes", async () => {
    const id = pendingEpoch(TXID);
    const looked: string[] = [];
    const shieldedTxStatus = async (txid: string): Promise<ShieldedTxStatus> => { looked.push(txid); return parseSentTxStatus(LISTING, txid); };
    await runEpoch(neverSwap, noClaims, { isolation: isolated, zcashFeeZats: async () => 15_000n, shieldedTxStatus });
    expect(looked).toEqual([TXID]);
    expect(db.getPayouts(id).map((p) => [p.wallet, p.sig, p.sentAt !== null])).toEqual([["optin-a", TXID, true], ["optin-b", TXID, true]]);
    expect(db.getEpoch(id)).toMatchObject({ status: "ok", feeZats: "15000", zcashTxids: JSON.stringify([TXID]) });
    expect(db.epochHasUnsentPayouts(id)).toBe(false);
  });

  test("the wallet lists the tx unmined: the rows stay pending (never resent), the epoch stays partial", async () => {
    const id = pendingEpoch(UNMINED);
    await runEpoch(neverSwap, noClaims, { isolation: isolated, zcashFeeZats: async () => 0n, shieldedTxStatus: async (txid) => parseSentTxStatus(LISTING, txid) });
    expect(db.getPendingPayouts(id, "shielded").map((p) => p.wallet)).toEqual(["optin-a", "optin-b"]);
    expect(db.getFreshUnsentPayouts(id, "shielded")).toEqual([]);
    expect(db.getEpoch(id)?.status).toBe("partial");
    db.getDb().query("UPDATE payouts SET sentAt = 'set-aside' WHERE epochId = $e").run({ $e: id });
    db.getDb().query("UPDATE epochs SET status = 'ok' WHERE id = $e").run({ $e: id });
  });

  test("the listing parser: mined, unmined, expired, absent", () => {
    expect(parseSentTxStatus(LISTING, TXID)).toBe("mined");
    expect(parseSentTxStatus(LISTING, UNMINED)).toBe("mempool");
    expect(parseSentTxStatus(LISTING, "c".repeat(64))).toBe("unknown");
    // The pinned devtool (list_tx.rs) prints "   Unmined (expiry height: H)" while the wallet has not synced past H and
    // "   Expired (expiry height: H)" once it has without seeing the tx mined: by ZIP 203 it can never mine now.
    expect(parseSentTxStatus(LISTING.replace(`${UNMINED}\n`, `${UNMINED}\n   Unmined (expiry height: 4429900)\n`), UNMINED)).toBe("mempool");
    expect(parseSentTxStatus(LISTING.replace(`${UNMINED}\n`, `${UNMINED}\n   Expired (expiry height: 4429900)\n`), UNMINED)).toBe("expired");
    expect(parseSentTxStatus(LISTING.replace(`${UNMINED}\n`, `${UNMINED}\n   Expired (expiry height: 4429900)\n`), TXID)).toBe("mined"); // the expiry line of a later tx is not read into an earlier one
  });

  test("the wallet lists the tx expired unmined (audit S6-B1 residual): the rows are cleared and sent once more, never left pending for good", async () => {
    const id = pendingEpoch(UNMINED);
    const asked: string[] = [];
    // The cleared rows go straight to a new shielded send, which has no Zcash node to reach here: the run ends in that error.
    const run = await runEpoch(neverSwap, noClaims, { isolation: isolated, shieldedTxStatus: async (txid) => { asked.push(txid); return "expired" as ShieldedTxStatus; } }).then(() => "finished", (e: Error) => e.message);
    expect(asked).toEqual([UNMINED]);
    const rows = db.getPayouts(id).filter((p) => p.kind === "shielded");
    expect(rows).toHaveLength(2);
    // The dead txid is gone from every row: cleared (no signature), handed to a new send (an intent mark), or sent anew (a txid that is not the dead one).
    expect(rows.every((p) => p.sig !== UNMINED && (p.sig === null || p.sig.startsWith("zcash-intent:") || /^[0-9a-f]{64}$/.test(p.sig)))).toBe(true);
    expect(run === "finished" || /devtool|wallet|pay/i.test(run)).toBe(true);
    db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE epochId = $e").run({ $e: id });
    db.getDb().query("UPDATE epochs SET status = 'ok' WHERE id = $e").run({ $e: id });
  });
});
