// Receipt memo on every shielded output (ZIP 321 `memo.N`, base64url without padding). The URI shape is checked
// against zip321 0.9.0's own encoder (the version the pinned zcash-devtool is locked to), and the whole path is run on
// the regtest chain: the recipients' own wallets see the text.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { MAX_MEMO_BYTES, buildZip321Uri, defaultUnifiedAddress, encodeMemo, enhanceWallet, initWallet, payBatch, receivedMemos, rewardMemo } from "../src/zcash/devtool";
import { TREASURY_DIR, TREASURY_IDENTITY, mineBlocks, syncToTip } from "../src/zcash/regtest";

const UA = "uregtest1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("the ZIP-321 URI", () => {
  test("memo.N follows the address and amount of its own payment; the first payment has no index", () => {
    const uri = buildZip321Uri([
      { address: UA, zats: 150_000n, memo: "first" },
      { address: UA + "b", zats: 1n },
      { address: UA + "c", zats: 100_000_000n, memo: "third" },
    ]);
    expect(uri).toBe(
      `zcash:?address=${UA}&amount=0.0015&memo=${Buffer.from("first").toString("base64url")}` +
      `&address.1=${UA}b&amount.1=0.00000001` +
      `&address.2=${UA}c&amount.2=1&memo.2=${Buffer.from("third").toString("base64url")}`,
    );
  });

  test("base64url, not base64: no '+', '/' or '=' ever appears (a '+' in a URI becomes a space)", () => {
    const text = ">>>???~~~"; // standard base64 of these bytes contains '+' and '/'
    expect(Buffer.from(text).toString("base64")).toMatch(/[+/]/);
    expect(encodeMemo(text)).not.toMatch(/[+/=]/);
    expect(Buffer.from(encodeMemo(text), "base64url").toString("utf8")).toBe(text);
    for (let n = 1; n < 40; n++) expect(encodeMemo("x".repeat(n))).not.toContain("="); // no padding at any length
  });

  test("the reward memo says what the note is, with the epoch", () => {
    expect(rewardMemo("epoch-1790926259151")).toBe("SNARKS pad reward, epoch epoch-1790926259151");
  });

  test("a memo over 512 bytes is refused before any URI is built; exactly 512 is allowed", () => {
    expect(() => encodeMemo("a".repeat(MAX_MEMO_BYTES + 1))).toThrow(/at most 512 bytes/);
    expect(() => encodeMemo("é".repeat(257))).toThrow(/at most 512 bytes/); // 514 bytes: bytes, not characters
    expect(encodeMemo("a".repeat(MAX_MEMO_BYTES))).toBeTruthy();
  });

  test("a payment with no memo has no memo parameter", () => {
    expect(buildZip321Uri([{ address: UA, zats: 5_000n }])).toBe(`zcash:?address=${UA}&amount=0.00005`);
  });
});

async function regtestUp(): Promise<boolean> {
  try {
    return config.isLocal && (await fetch(config.zcash.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getblockcount", params: [] }) })).ok && existsSync(config.paths.zcashDevtoolBin);
  } catch {
    return false;
  }
}

describe.if(await regtestUp())("on the regtest chain: recipients see the memo in their own wallets", () => {
  function recipient(): { dir: string; ua: string } {
    const dir = join(config.paths.zcashWorkDir, "wallets", `memo-test-${crypto.randomUUID().slice(0, 8)}`);
    initWallet(dir, "memo-test", `${dir}.identity.age`);
    return { dir, ua: defaultUnifiedAddress(dir) };
  }

  test("one batched transaction, three recipients: each sees its own memo text, including non-ASCII and URL-hostile characters, and one with no memo sees none", async () => {
    const a = recipient(), b = recipient(), c = recipient();
    const memoA = rewardMemo("epoch-test-1");
    const memoB = "ü ✓ >>>??? ~ epoch";
    const txid = payBatch(TREASURY_DIR, TREASURY_IDENTITY, [
      { address: a.ua, zats: 40_000n, memo: memoA },
      { address: b.ua, zats: 41_000n, memo: memoB },
      { address: c.ua, zats: 42_000n }, // no memo
    ]);
    await mineBlocks(10);
    for (const r of [a, b, c]) await syncToTip(r.dir);
    for (const r of [a, b, c]) enhanceWallet(r.dir); // a light wallet reads memos from the full transaction

    expect(receivedMemos(a.dir, txid)).toEqual([memoA]);
    expect(receivedMemos(b.dir, txid)).toEqual([memoB]);
    expect(receivedMemos(c.dir, txid)).toEqual([]);
  }, 240_000);

  test("a memo over 512 bytes never reaches the wallet: payBatch throws before it runs", () => {
    const a = recipient();
    expect(() => payBatch(TREASURY_DIR, TREASURY_IDENTITY, [{ address: a.ua, zats: 40_000n, memo: "x".repeat(513) }])).toThrow(/at most 512 bytes/);
  }, 60_000);
});
