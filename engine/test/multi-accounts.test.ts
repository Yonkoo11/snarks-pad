// The bulk account reader learns the provider's getMultipleAccounts limit from the provider's own refusal (devnet QuickNode, 2026-10-07: HTTP 413,
// code -32615, "getMultipleAccounts is limited to N accounts"; the test site's payout round parked on it) and reads smaller chunks from then on.
import { beforeEach, describe, expect, test } from "bun:test";
import { Keypair, type AccountInfo, type PublicKey } from "@solana/web3.js";
import { ChainUnavailableError } from "../src/rpcGuard";
import { forgetLearnedLimit, readAccountsInfo, tooManyKeys } from "../src/multiAccounts";

const keys = Array.from({ length: 23 }, () => Keypair.generate().publicKey);
const info = (k: PublicKey): AccountInfo<Buffer> => ({ executable: false, owner: k, lamports: 1, data: Buffer.from(k.toBytes()), rentEpoch: 0 });
/** A provider that refuses more than `limit` keys the way QuickNode does, and records every call's size. */
function provider(limit: number, text = `HTTP 413 {"jsonrpc":"2.0","id":"x","error":{"code":-32615,"message":"getMultipleAccounts is limited to ${limit} accounts"}}`) {
  const sizes: number[] = [];
  const read = async (ks: PublicKey[]) => {
    sizes.push(ks.length);
    if (ks.length > limit) throw new ChainUnavailableError("http_error", text);
    return ks.map((k) => (k.toBase58() < "H" ? null : info(k))); // some accounts do not exist
  };
  return { sizes, read };
}
const expectedFor = (ks: PublicKey[]) => ks.map((k) => (k.toBase58() < "H" ? null : info(k)));

beforeEach(forgetLearnedLimit);

describe("the bulk account reader and a provider that allows fewer keys than the public 100", () => {
  test("a refusal that names the limit: the same chunk is read again at that size, every account comes back in order, later reads start at the learned size", async () => {
    const p = provider(5);
    expect(await readAccountsInfo(keys, p.read, 100)).toEqual(expectedFor(keys));
    expect(p.sizes).toEqual([23, 5, 5, 5, 5, 3]);
    const again = provider(5);
    await readAccountsInfo(keys.slice(0, 12), again.read, 100);
    expect(again.sizes).toEqual([5, 5, 2]); // learned, no refusal first
  });

  test("a refusal that names no number halves until the provider accepts", async () => {
    const p = provider(10, 'HTTP 413 {"jsonrpc":"2.0","error":{"code":-32615,"message":"request too large"}}');
    expect(await readAccountsInfo(keys, p.read, 100)).toEqual(expectedFor(keys));
    expect(p.sizes).toEqual([23, 11, 5, 5, 5, 5, 3]); // 23 and 11 refused, 5 accepted
  });

  test("the configured maximum caps the first chunk; any other failure is thrown as it came", async () => {
    const p = provider(100);
    await readAccountsInfo(keys, p.read, 10);
    expect(p.sizes).toEqual([10, 10, 3]);
    const down = async () => { throw new ChainUnavailableError("timeout", "no answer within 20000 ms"); };
    await expect(readAccountsInfo(keys, down, 100)).rejects.toThrow("chain unavailable (timeout)");
    const notFromUs = async () => { throw new Error("Transfer: insufficient lamports"); };
    await expect(readAccountsInfo(keys, notFromUs, 100)).rejects.toThrow("insufficient lamports");
  });

  test("tooManyKeys reads the provider's number, 0 without one, null for anything else", () => {
    expect(tooManyKeys(new ChainUnavailableError("http_error", 'HTTP 413 {"error":{"code":-32615,"message":"getMultipleAccounts is limited to 5 accounts"}}'))).toBe(5);
    expect(tooManyKeys(new ChainUnavailableError("http_error", 'HTTP 413 {"jsonrpc":"2.0","id":"c00c5f76","error":{"code":-32615,"message":"getMultipleAccounts is limited to a 5 range, upgrade from discover plan"}}'))).toBe(5);
    expect(tooManyKeys(new Error("failed to get info about account X: ChainUnavailableError: chain unavailable (http_error): HTTP 413 too large"))).toBe(0);
    expect(tooManyKeys(new ChainUnavailableError("http_error", "HTTP 500 upstream"))).toBeNull();
    expect(tooManyKeys(new ChainUnavailableError("rate_limited", "HTTP 429"))).toBeNull();
    expect(tooManyKeys(new Error("boom"))).toBeNull();
  });
});
