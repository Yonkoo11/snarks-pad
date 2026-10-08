// PORT-ASSUMPTIONS N1-N5, N10-N15: the 1Click request shape, the quote
// signature and the quote checks, pinned to the artifacts of the real swap
// (probe/f030, 2026-09-30) and to a real dry quote taken 2026-10-01.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, ZEC_MINT_MAINNET } from "../src/config";
import { receivedInTx, walletOwnsAddress } from "../src/zcash/devtool";
import {
  NEAR_ZEC_NATIVE_ASSET,
  buildQuoteRequest,
  checkQuote,
  makeOneClickClient,
  originAssetFor,
  stableStringify,
  verifyQuoteSignature,
  type QuoteResponse,
  type StatusResponse,
} from "../src/swap/near1click-api";

const f030 = (name: string) => JSON.parse(readFileSync(join(config.paths.repoRoot, "probe", "f030", name), "utf8"));
const quoteReq = f030("quote-req.json");
const quoteResp = f030("quote-resp.json") as QuoteResponse;
const status = f030("status.json") as StatusResponse;
const dryQuote = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "near1click-dry-quote-2026-10-01.json"), "utf8")) as QuoteResponse;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const KEEPER = quoteReq.refundTo as string;
const wantF030 = {
  amountIn: 400_000n, recipient: quoteReq.recipient as string, refundTo: KEEPER, originAsset: quoteReq.originAsset as string,
  destinationAsset: NEAR_ZEC_NATIVE_ASSET, slippageBps: 100, deadline: quoteReq.deadline as string, keeper: KEEPER, maxLossBps: 300, withdrawFeeZats: 32_000n,
  nowMs: Date.parse("2026-09-30T20:05:58Z"),
};

describe("request shape (N1-N5)", () => {
  test("the origin asset id is the 1cs_v1 form of the engine's ZEC mint, equal to the id of the swap that worked", () => {
    expect(originAssetFor(ZEC_MINT_MAINNET.toBase58())).toBe(quoteReq.originAsset);
    expect(originAssetFor(config.solana.dbc.quoteMint.toBase58())).toBe(quoteReq.originAsset);
    expect(NEAR_ZEC_NATIVE_ASSET).toBe(quoteReq.destinationAsset);
  });

  test("the request body has exactly the fields and values of probe/f030/quote-req.json", () => {
    const body = buildQuoteRequest({ amountIn: 400_000n, recipient: quoteReq.recipient, refundTo: KEEPER, originAsset: quoteReq.originAsset, slippageBps: 100, dry: false, deadlineMs: Date.parse(quoteReq.deadline) });
    // 1Click echoes the deadline as ...57.000Z; same instant, so compare instants.
    expect({ ...body, deadline: Date.parse(body.deadline) }).toEqual({ ...quoteReq, deadline: Date.parse(quoteReq.deadline) });
  });
});

describe("quote signature (N15)", () => {
  test("the real F-030 quote verifies, and so do its status payload and a live dry quote from 2026-10-01", () => {
    expect(verifyQuoteSignature(quoteResp)).toBe(true);
    expect(verifyQuoteSignature(status.quoteResponse!)).toBe(true);
    expect(verifyQuoteSignature(dryQuote)).toBe(true);
  });

  test("changing the deposit address, the amount out, the recipient or the timestamp breaks it", () => {
    const addr = clone(quoteResp);
    addr.quote.depositAddress = "CRXW44tQRXQEeG3KNxCpHGJMFcfKNcortnWnJac7UGnH";
    const out = clone(quoteResp);
    out.quote.amountOut = "368001";
    const rec = clone(quoteResp);
    rec.quoteRequest.recipient = rec.quoteRequest.recipient.replace(/.$/, "a");
    const ts = clone(quoteResp);
    ts.timestamp = "2026-09-30T20:05:59.512Z";
    for (const tampered of [addr, out, rec, ts]) expect(verifyQuoteSignature(tampered)).toBe(false);
  });

  test("another signer's key, a garbage signature and a missing field are all false, never a throw", () => {
    expect(verifyQuoteSignature(quoteResp, "ed25519:7yu7FuCvr6xKiVTUZeSNbBGLnfBnrqBxKxGvm1xqxn6r")).toBe(false);
    expect(verifyQuoteSignature({ ...quoteResp, signature: "ed25519:abc" })).toBe(false);
    expect(verifyQuoteSignature({} as QuoteResponse)).toBe(false);
  });

  test("stableStringify sorts keys and drops undefined like json-stable-stringify", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [3, { z: 1, y: null }] } })).toBe('{"a":{"c":[3,{"y":null,"z":1}]},"b":1}');
  });
});

describe("checkQuote (INV-14: the deposit goes only where the treasury and the keeper say)", () => {
  test("the real F-030 quote passes every check", () => {
    expect(checkQuote(quoteResp, wantF030)).toEqual([]);
  });

  test("a different recipient, refund address, amount, asset, deposit address or deadline is each named", () => {
    const cases: [string, (q: QuoteResponse) => void, RegExp][] = [
      ["recipient", (q) => (q.quoteRequest.recipient = "u1attacker"), /quoteRequest\.recipient/],
      ["refundTo", (q) => (q.quoteRequest.refundTo = "11111111111111111111111111111112"), /quoteRequest\.refundTo/],
      ["amount", (q) => (q.quoteRequest.amount = "400001"), /quoteRequest\.amount/],
      ["amountIn", (q) => (q.quote.amountIn = "800000"), /quote\.amountIn/],
      ["originAsset", (q) => (q.quoteRequest.originAsset = "nep141:sol-a7bd.omft.near"), /quoteRequest\.originAsset/],
      ["destinationAsset", (q) => (q.quoteRequest.destinationAsset = "nep141:btc.omft.near"), /quoteRequest\.destinationAsset/],
      ["depositAddress", (q) => (q.quote.depositAddress = "not-an-address"), /depositAddress/],
      ["keeper as deposit", (q) => (q.quote.depositAddress = KEEPER), /keeper's own address/],
      ["deadline", (q) => (q.quoteRequest.deadline = "2026-09-30T20:00:00Z"), /quoteRequest\.deadline/],
      ["refundType", (q) => (q.quoteRequest.refundType = "INTENTS" as never), /refundType/],
      ["dry", (q) => (q.quoteRequest.dry = true), /quoteRequest\.dry/],
    ];
    for (const [label, mutate, expected] of cases) {
      const q = clone(quoteResp);
      mutate(q);
      const problems = checkQuote(q, wantF030);
      expect(problems.some((p) => expected.test(p)), `${label}: ${problems.join(" | ")}`).toBe(true);
      // The request deadline is NOT covered by the signature (quote.deadline overwrites it in the signed JSON; the SDK agrees), so our own echo check is the only guard for it.
      if (label !== "deadline") expect(problems.some((p) => /signature/.test(p)), `${label} must also fail the signature`).toBe(true);
    }
  });

  test("the loss cap is the withdraw fee plus the bps (audit S6, product decision 2): F-030 lost 35,680 of 400,000, the fee and 92 bps", () => {
    const lossOf = (want: Partial<typeof wantF030>) => checkQuote(quoteResp, { ...wantF030, ...want }).filter((p) => /loses more than/.test(p));
    expect(lossOf({})).toEqual([]); // 300 bps over the fee: the real quote passes
    expect(lossOf({ maxLossBps: 100 })).toEqual([]); // 100 bps over the fee still covers the 92
    expect(lossOf({ maxLossBps: 50 })[0]).toMatch(/loses more than 50 bps of 400000 on top of the 32000 zats withdraw fee \(the least accepted is 366000\)/);
    expect(lossOf({ maxLossBps: 0, withdrawFeeZats: 35_680n })).toEqual([]); // exactly the loss: accepted
    expect(lossOf({ maxLossBps: 0, withdrawFeeZats: 35_679n }).length).toBe(1);
    expect(lossOf({ maxLossBps: 700, withdrawFeeZats: 0n }).length).toBe(1); // the old flat 7% alone refused this 8.9% loss
  });

  test("a request deadline already in the past is refused", () => {
    expect(checkQuote(quoteResp, { ...wantF030, nowMs: Date.parse("2026-10-01T00:00:00Z") }).some((p) => /already in the past/.test(p))).toBe(true);
  });
});

describe("client (N10, N13, N14)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  test("an API key is sent only when configured; status needs none", async () => {
    const seen: Record<string, string>[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return json(status);
    }) as unknown as typeof fetch;
    await makeOneClickClient({ baseUrl: "http://x", fetch: fakeFetch }).status("addr");
    await makeOneClickClient({ baseUrl: "http://x", fetch: fakeFetch, apiKey: "k" }).status("addr");
    expect(seen[0]!["x-api-key"]).toBeUndefined();
    expect(seen[1]!["x-api-key"]).toBe("k");
  });

  test("status: 404 is an unknown address, 5xx and an unknown status value throw", async () => {
    const mk = (res: Response) => makeOneClickClient({ baseUrl: "http://x", fetch: (async () => res) as unknown as typeof fetch });
    expect(await mk(json({ message: "nope" }, 404)).status("a")).toEqual({ kind: "unknown_address" });
    await expect(mk(json({ message: "boom" }, 500)).status("a")).rejects.toThrow(/HTTP 500/);
    await expect(mk(json({ status: "SOMETHING_NEW" })).status("a")).rejects.toThrow(/unknown status/);
    expect((await mk(json(status)).status("a")).kind).toBe("ok");
  });

  test("quote errors carry the HTTP status and message; submitDeposit surfaces 1Click's 500 so the caller can ignore it", async () => {
    const mk = (res: Response) => makeOneClickClient({ baseUrl: "http://x", fetch: (async () => res) as unknown as typeof fetch });
    await expect(mk(json({ message: "Amount is too low for bridge, try at least 133334" }, 400)).quote(quoteReq)).rejects.toThrow(/HTTP 400.*too low/);
    await expect(mk(json({ message: "Empty AMQP response" }, 500)).submitDeposit("sig", "addr")).rejects.toThrow(/HTTP 500/);
  });
});

// The settled amount is read from the treasury wallet (N8). This is the one test that reads a real mainnet
// wallet: the owner's pad-main wallet from the F-030 swap, read-only, no network. Skipped where it is absent.
const MAINNET_WALLET = join(config.paths.repoRoot, "probe", "zcash-batch", "work", "wallets-live", "main");
describe.if(existsSync(join(MAINNET_WALLET, "data.sqlite")) && existsSync(config.paths.zcashDevtoolBin))("treasury wallet read (N8, N17), against the real F-030 wallet", () => {
  test("the F-030 delivery reads 375,000 zats (1Click's own status said 368,000), mined at 3501832", () => {
    expect(receivedInTx(MAINNET_WALLET, status.swapDetails!.destinationChainTxHashes![0]!.hash)).toEqual({ zats: 375_000n, minedHeight: 3_501_832 });
  });

  test("a payout the wallet SENT (P1) received nothing, and an unknown txid is null", () => {
    expect(receivedInTx(MAINNET_WALLET, "63a85230d6cef5a5465b3d9a34327de89f8c63c47a5a6b8e01e31004ca7d961c")?.zats).toBe(0n);
    expect(receivedInTx(MAINNET_WALLET, "0".repeat(64))).toBeNull();
  });

  test("the wallet owns the F-030 recipient and not another address", () => {
    expect(walletOwnsAddress(MAINNET_WALLET, quoteReq.recipient)).toBe(true);
    expect(walletOwnsAddress(MAINNET_WALLET, "u1notthiswallet")).toBe(false);
  });
});
