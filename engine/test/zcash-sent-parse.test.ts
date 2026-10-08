// parseSentPayment (audit O-4): reads the treasury's own `list-tx` to find the chunk a dead keeper's devtool sent.
// Fixture: the shape the regtest treasury printed for a stress payout (addresses shortened, values kept).
import { describe, expect, test } from "bun:test";
import { parseSentPayment } from "../src/zcash/devtool";

const MEMO = "SNARKS pad reward, epoch epoch-1";
const listing = `aaaa000000000000000000000000000000000000000000000000000000000001
     Mined: 700 (2011-02-02 23:18:54.0 +00:00:00)
    Amount:   0.00500000 REG
  Output 0 (Ironwood)
    Value:   0.00140677 REG
    Received by account: 11111111-b17a-44e4-aee5-098380ae118d (treasury)
5806442bf008720afdbae639e02d0a300a75d12f32962eb6a0f37e97264ac622
     Mined: 778 (2011-02-02 23:18:54.0 +00:00:00)
    Amount:   0.02632470 REG
  Fee paid:   0.00105000 REG
  Sent 2 notes, received 0 notes, 2 memos
  Output 0 (Ironwood)
    Value:   0.00140677 REG
    Sent from account: 9716026c-b17a-44e4-aee5-098380ae118d (treasury)
    To: uregtest1alice
    Memo: Memo::Text("${MEMO}")
  Output 1 (Ironwood)
    Value:   6.19934530 REG (Change)
    Memo: Memo::Empty
  Output 2 (Ironwood)
    Value:   0.00133409 REG
    Sent from account: 9716026c-b17a-44e4-aee5-098380ae118d (treasury)
    To: uregtest1bob
    Memo: Memo::Text("${MEMO}")
`;

describe("parseSentPayment", () => {
  test("finds the transaction that paid this address this amount with this epoch's memo", () => {
    expect(parseSentPayment(listing, "uregtest1alice", 140_677n, MEMO)).toBe("5806442bf008720afdbae639e02d0a300a75d12f32962eb6a0f37e97264ac622");
    expect(parseSentPayment(listing, "uregtest1bob", 133_409n, MEMO)).toBe("5806442bf008720afdbae639e02d0a300a75d12f32962eb6a0f37e97264ac622");
  });
  test("a different amount, address or epoch memo is not a match; a received output is never a sent one", () => {
    expect(parseSentPayment(listing, "uregtest1alice", 140_676n, MEMO)).toBeNull();
    expect(parseSentPayment(listing, "uregtest1carol", 140_677n, MEMO)).toBeNull();
    expect(parseSentPayment(listing, "uregtest1alice", 140_677n, "SNARKS pad reward, epoch epoch-2")).toBeNull();
    expect(parseSentPayment("", "uregtest1alice", 140_677n, MEMO)).toBeNull();
  });
});
