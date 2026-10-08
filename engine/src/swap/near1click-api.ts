// NEAR 1Click HTTP client and quote checks (https://1click.chaindefuser.com/v0).
// Every request/response shape here is pinned in PORT-ASSUMPTIONS.md section 6b
// (N1-N19) against the live API and the F-030 artifacts. Nothing in this file
// moves funds: it asks for quotes, reads status and (optionally) tells 1Click a
// deposit hash. The state machine around it is src/swap/near1click.ts.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { verifyEd25519 } from "../crypto/ed25519";

export const NEAR_ZEC_NATIVE_ASSET = "nep141:zec.omft.near"; // N2

/** N1: the id is `1cs_v1:sol:spl:<mint>`, not the old `nep141:sol-<mint>.omft.near`. */
export const originAssetFor = (mint: string): string => `1cs_v1:sol:spl:${mint}`;

/** The key 1Click signs quotes with (N15). Pinned from @defuse-protocol/one-click-sdk-typescript 0.1.26. */
export const ONE_CLICK_QUOTE_SIGNER = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/** The 7 statuses the OpenAPI lists (N12). */
export type OneClickStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
const STATUSES: readonly string[] = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"];

export interface QuoteRequestBody {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

export interface QuoteFields {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate?: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequestBody & { [extra: string]: unknown };
  quote: QuoteFields;
}

export interface TxHash {
  hash: string;
  explorerUrl?: string;
}

export interface SwapDetails {
  amountIn?: string;
  amountOut?: string;
  refundedAmount?: string;
  refundReason?: string | null;
  depositedAmount?: string;
  destinationChainTxHashes?: TxHash[];
  originChainTxHashes?: TxHash[];
}

export interface StatusResponse {
  status: OneClickStatus;
  updatedAt?: string;
  swapDetails?: SwapDetails;
  quoteResponse?: QuoteResponse;
}

export type StatusResult = { kind: "ok"; body: StatusResponse } | { kind: "unknown_address" };

export interface OneClickClient {
  quote(body: QuoteRequestBody): Promise<QuoteResponse>;
  /** Never throws for HTTP 404 (an address 1Click does not know yet): returns unknown_address. Throws on anything else that is not a valid status. */
  status(depositAddress: string): Promise<StatusResult>;
  submitDeposit(txHash: string, depositAddress: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 15_000;

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  apiKey?: string | null;
}

async function bodyText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}

export function makeOneClickClient(opts: ClientOptions): OneClickClient {
  const doFetch = opts.fetch ?? fetch;
  const headers = (json: boolean): Record<string, string> => ({
    ...(json ? { "content-type": "application/json" } : {}),
    ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
  });
  return {
    async quote(body) {
      const res = await doFetch(`${opts.baseUrl}/quote`, { method: "POST", headers: headers(true), body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`1Click quote failed: HTTP ${res.status} ${await bodyText(res)}`);
      const json = (await res.json()) as QuoteResponse;
      if (!json?.quote || !json.quoteRequest || typeof json.signature !== "string") throw new Error("1Click quote response is missing quote, quoteRequest or signature");
      return json;
    },
    async status(depositAddress) {
      const url = `${opts.baseUrl}/status?depositAddress=${encodeURIComponent(depositAddress)}`;
      const res = await doFetch(url, { headers: headers(false), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 404) return { kind: "unknown_address" };
      if (!res.ok) throw new Error(`1Click status failed: HTTP ${res.status} ${await bodyText(res)}`);
      const json = (await res.json()) as StatusResponse;
      if (!STATUSES.includes(json?.status)) throw new Error(`1Click status response has an unknown status: ${JSON.stringify(json?.status)}`);
      return { kind: "ok", body: json };
    },
    async submitDeposit(txHash, depositAddress) {
      const res = await doFetch(`${opts.baseUrl}/deposit/submit`, { method: "POST", headers: headers(true), body: JSON.stringify({ txHash, depositAddress }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`1Click deposit/submit failed: HTTP ${res.status} ${await bodyText(res)}`);
    },
  };
}

// ---- quote signature (N15) ----

/** json-stable-stringify's output for plain JSON: keys sorted, undefined omitted, no whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

const truthy = <T>(v: T | null | undefined | 0 | ""): T | undefined => (v ? v : undefined);

function signedRequestFields(r: QuoteResponse["quoteRequest"]): Record<string, unknown> {
  return {
    dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset, depositType: r.depositType,
    destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient,
    recipientType: r.recipientType, deadline: r.deadline,
    quoteWaitingTimeMs: truthy(r.quoteWaitingTimeMs as number | undefined),
    referral: truthy(r.referral as string | undefined),
    virtualChainRecipient: truthy(r.virtualChainRecipient as string | undefined),
    virtualChainRefundRecipient: truthy(r.virtualChainRefundRecipient as string | undefined),
    customRecipientMsg: truthy(r.customRecipientMsg as string | undefined),
  };
}

function signedQuoteFields(resp: QuoteResponse): Record<string, unknown> {
  const q = resp.quote;
  const base = {
    amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut,
  };
  if (resp.quoteRequest.dry) return base;
  return {
    ...base,
    depositAddress: truthy(q.depositAddress), depositMemo: truthy(q.depositMemo), deadline: truthy(q.deadline),
    timeWhenInactive: truthy(q.timeWhenInactive), timeEstimate: truthy(q.timeEstimate), refundFee: truthy(q.refundFee), withdrawFee: truthy(q.withdrawFee),
  };
}

const decodeKey = (v: string): Uint8Array => bs58.decode(v.startsWith("ed25519:") ? v.slice("ed25519:".length) : v);

/** The bytes 1Click signs for a quote response: base58(sha256(stable JSON of the signed request fields, quote fields and timestamp)). */
export function quoteSigningMessage(resp: QuoteResponse): Uint8Array {
  const data = stableStringify({ ...signedRequestFields(resp.quoteRequest), ...signedQuoteFields(resp), timestamp: resp.timestamp });
  return new TextEncoder().encode(bs58.encode(createHash("sha256").update(data).digest()));
}

/** True iff `resp` (a quote response, or the quoteResponse inside a status) carries 1Click's signature. Never throws. */
export function verifyQuoteSignature(resp: QuoteResponse, signer: string = ONE_CLICK_QUOTE_SIGNER): boolean {
  try {
    return verifyEd25519(quoteSigningMessage(resp), decodeKey(resp.signature), decodeKey(signer));
  } catch {
    return false;
  }
}

// ---- quote checks (PORT-ASSUMPTIONS N3, N4, N6, N7; threat-model INV-14) ----

export interface QuoteExpectation {
  amountIn: bigint;
  recipient: string;
  refundTo: string;
  originAsset: string;
  destinationAsset: string;
  slippageBps: number;
  /** The request deadline we sent (ISO). */
  deadline: string;
  keeper: string;
  /** The variable loss allowed on top of the fixed withdraw fee, in basis points of amountIn (audit S6, product decision 2). */
  maxLossBps: number;
  /** The fixed fee 1Click takes on the way out, as the pad knows it (never the quote's own figure: a quote naming a bigger one is refused). */
  withdrawFeeZats: bigint;
  nowMs: number;
  /** Whose signature to require. Default: 1Click's pinned key. Only a test passes another. */
  signer?: string;
}

export function buildQuoteRequest(p: { amountIn: bigint; recipient: string; refundTo: string; originAsset: string; slippageBps: number; dry: boolean; deadlineMs: number }): QuoteRequestBody {
  return {
    dry: p.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: p.slippageBps,
    originAsset: p.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_ZEC_NATIVE_ASSET,
    amount: p.amountIn.toString(),
    refundTo: p.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    // 1Click echoes the deadline with milliseconds; second precision keeps the echo comparable.
    deadline: new Date(Math.floor(p.deadlineMs / 1000) * 1000).toISOString(),
  };
}

export function isSolanaAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function parseBig(v: unknown): bigint | null {
  return typeof v === "string" && /^[0-9]{1,30}$/.test(v) ? BigInt(v) : null;
}

/**
 * Everything that must be true of a NON-dry quote before the keeper signs a
 * deposit to its depositAddress. Returns the list of problems (empty = ok).
 * An attacker (or a bad proxy) who can alter the response must get past the
 * signature AND these echoes: a different recipient, refund address, amount,
 * asset or deposit address is refused before anything is signed.
 */
export function checkQuote(resp: QuoteResponse, want: QuoteExpectation): string[] {
  const problems: string[] = [];
  const req = resp.quoteRequest;
  const q = resp.quote;
  if (!verifyQuoteSignature(resp, want.signer)) problems.push("the quote signature does not verify against 1Click's signing key");
  const echoes: [string, unknown, unknown][] = [
    ["dry", req.dry, false], ["swapType", req.swapType, "EXACT_INPUT"], ["depositType", req.depositType, "ORIGIN_CHAIN"],
    ["originAsset", req.originAsset, want.originAsset], ["destinationAsset", req.destinationAsset, want.destinationAsset],
    ["amount", req.amount, want.amountIn.toString()], ["refundTo", req.refundTo, want.refundTo], ["refundType", req.refundType, "ORIGIN_CHAIN"],
    ["recipient", req.recipient, want.recipient], ["recipientType", req.recipientType, "DESTINATION_CHAIN"], ["slippageTolerance", req.slippageTolerance, want.slippageBps],
  ];
  for (const [field, got, expected] of echoes) if (got !== expected) problems.push(`quoteRequest.${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  if (Date.parse(req.deadline) !== Date.parse(want.deadline)) problems.push(`quoteRequest.deadline is ${req.deadline}, expected ${want.deadline}`);

  const amountIn = parseBig(q.amountIn);
  const minIn = parseBig(q.minAmountIn);
  const amountOut = parseBig(q.amountOut);
  const minOut = parseBig(q.minAmountOut);
  if (amountIn !== want.amountIn) problems.push(`quote.amountIn is ${q.amountIn}, expected exactly ${want.amountIn}`);
  if (minIn === null || minIn > want.amountIn) problems.push(`quote.minAmountIn ${q.minAmountIn} is missing or above the amount we send`);
  if (amountOut === null || minOut === null || minOut > amountOut || amountOut === 0n) problems.push(`quote amountOut/minAmountOut are missing or inconsistent (${q.amountOut}/${q.minAmountOut})`);
  else {
    // The cap is fixed plus variable (audit S6, product decision 2): the withdraw fee the pad knows, then `maxLossBps` of the
    // amount. A flat percentage alone either refused every small swap (the fee is 4.2% of 0.01 ZEC) or let a large one lose far
    // more than the fee; measured, the whole loss of a real swap was the fee (F-030: 400,000 in, 364,320 out, fee 32,000).
    const floor = want.amountIn - want.withdrawFeeZats - (want.amountIn * BigInt(want.maxLossBps)) / 10_000n;
    if (minOut < floor) problems.push(`quote.minAmountOut ${q.minAmountOut} loses more than ${want.maxLossBps} bps of ${want.amountIn} on top of the ${want.withdrawFeeZats} zats withdraw fee (the least accepted is ${floor})`);
  }

  const dep = q.depositAddress;
  if (!dep || !isSolanaAddress(dep)) problems.push("quote.depositAddress is missing or not a Solana address");
  else if (dep === want.keeper) problems.push("quote.depositAddress is the keeper's own address");
  const quoteDeadline = Date.parse(q.deadline ?? "");
  if (!Number.isFinite(quoteDeadline) || quoteDeadline < Date.parse(want.deadline)) problems.push(`quote.deadline ${q.deadline} is missing or earlier than the request deadline`);
  if (!Number.isFinite(Date.parse(want.deadline)) || Date.parse(want.deadline) <= want.nowMs) problems.push("the request deadline is already in the past");
  return problems;
}
