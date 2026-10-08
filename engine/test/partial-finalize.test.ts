// Devnet D-1: an epoch whose swap was still pending on one run ("partial") and whose shielded batch went out on a
// later run stayed "partial" with feeZats "0" forever. Two defects: (1) a shielded leg that finished kept the
// earlier "partial" status instead of moving to "ok"; (2) a "partial" epoch with every row sent was never picked
// up again, so nothing could ever finish it. Outside local mode the network fee is read from the treasury wallet's
// own record of the transaction (zcash-devtool list-tx "Fee paid:"), never left at 0.
// No chain needed: every row is already sent, so the legs touch only the DB and the injected fee reader.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import type { IsolationDeps } from "../src/epoch/stuck";
import type { SwapAdapter } from "../src/swap/types";
import { parseTxFeeZats } from "../src/zcash/devtool";

const noClaims = async () => {};
const isolated: IsolationDeps = { keeperZecBalance: async () => 0n, treasurySpendableZats: async () => 0n };
const neverSwap: SwapAdapter = {
  provider: "simulated",
  quote: async () => ({ outZats: 0n }),
  submit: async () => {
    throw new Error("a fully sent epoch must not swap again");
  },
  status: async () => {
    throw new Error("a fully sent epoch must not poll the swap");
  },
};

const TXID = "6180b2929ec8f1581402972ddd659ee9100c95c7f5032fa72a35eccdcc11445a";
// The real testnet treasury listing for that txid (addresses shortened by redactZcashAddresses, as logged).
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
${"b".repeat(64)}
  Fee paid:   0.00099999 TAZ
`;

/** The stuck D-1 state: swap settled, both shielded rows sent in one Zcash tx, status still "partial", fee 0. */
function stuckPartialEpoch(): string {
  // Everything else in the shared test DB is set aside so this run resumes exactly this epoch.
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("UPDATE epochs SET status = 'ok' WHERE status IN ('harvesting','partial')").run();
  const id = `epoch-partial-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date(Date.now() + 60_000).toISOString(), coinMints: "[]", harvestedZats: "3360000", feeZats: "0", status: "partial", swapProvider: "simulated", swapRef: "ref", swapState: "settled", swapAmountOutZats: "1155984", zcashTxids: "[]" });
  for (const [wallet, amount] of [["optin-a", "636175"], ["optin-b", "519809"]] as const) {
    db.planPayout({ epochId: id, wallet, kind: "shielded", amountZats: amount, zcashAddress: `utest1${wallet}` });
    db.markPayoutPending(id, wallet, "shielded", TXID);
    db.markPayoutSent(id, wallet, "shielded", TXID);
  }
  return id;
}

describe("a partial epoch whose shielded batch went out is finalized (devnet D-1)", () => {
  test("the next run moves it to ok and records the network fee read for its Zcash tx", async () => {
    const id = stuckPartialEpoch();
    const feeReads: string[] = [];
    const zcashFeeZats = async (txid: string) => {
      feeReads.push(txid);
      return 15_000n;
    };
    await runEpoch(neverSwap, noClaims, { isolation: isolated, zcashFeeZats });
    expect(db.getEpoch(id)).toMatchObject({ status: "ok", feeZats: "15000", zcashTxids: JSON.stringify([TXID]) });
    expect(feeReads).toEqual([TXID]);

    // Finished: a later run neither resumes it nor counts its fee twice.
    await runEpoch(neverSwap, noClaims, { isolation: isolated, zcashFeeZats });
    expect(db.getEpoch(id)).toMatchObject({ status: "ok", feeZats: "15000" });
  });

  test("a fee the wallet cannot report raises an alert but never blocks the status after the money moved", async () => {
    const id = stuckPartialEpoch();
    await runEpoch(neverSwap, noClaims, { isolation: isolated, zcashFeeZats: async () => Promise.reject(new Error("no fee line")) });
    expect(db.getEpoch(id)).toMatchObject({ status: "ok", feeZats: "0", zcashTxids: JSON.stringify([TXID]) });
    expect(db.getDb().query("SELECT 1 FROM alerts WHERE kind = 'epoch_fee_unread' AND epochId = $e AND resolvedAt IS NULL").get({ $e: id })).toBeTruthy();
  });

  test("the fee is parsed exactly from the wallet's list-tx entry for that txid", () => {
    expect(parseTxFeeZats(LISTING, TXID)).toBe(15_000n);
    expect(parseTxFeeZats(LISTING.replaceAll("TAZ", "ZEC"), TXID)).toBe(15_000n);
    expect(parseTxFeeZats(LISTING, "c".repeat(64))).toBeNull();
  });
});
