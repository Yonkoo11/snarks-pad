// A fake 1Click server (a `fetch` replacement) for tests. It signs its quotes with
// its own throwaway key, which the adapter is told to trust (`quoteSigner`), so
// every signature check still runs for real. Shapes follow the live API
// (PORT-ASSUMPTIONS 6b) and probe/f030.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { quoteSigningMessage, type OneClickStatus, type QuoteRequestBody, type QuoteResponse, type SwapDetails } from "../../src/swap/near1click-api";

export interface StatusScript {
  status: OneClickStatus;
  swapDetails?: SwapDetails;
}

export class Fake1Click {
  private readonly keys = nacl.sign.keyPair();
  readonly signer = `ed25519:${bs58.encode(this.keys.publicKey)}`;
  readonly quotes: QuoteResponse[] = [];
  readonly depositSubmits: { txHash: string; depositAddress: string }[] = [];
  quoteRequests = 0;
  statusCalls = 0;
  /** Status per deposit address; an address with no script answers `unscripted`. */
  readonly scripts = new Map<string, StatusScript>();
  unscripted: "404" | "PENDING_DEPOSIT" = "404";
  statusFails = false;
  quoteFails = false;
  /** Mutates the response BEFORE it is signed (a 1Click that signs something wrong). */
  beforeSign: ((q: QuoteResponse) => void) | null = null;
  /** Mutates it AFTER signing (a man in the middle). */
  afterSign: ((q: QuoteResponse) => void) | null = null;

  readonly fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname.endsWith("/quote")) return this.handleQuote(JSON.parse(String(init?.body)) as QuoteRequestBody);
    if (u.pathname.endsWith("/status")) return this.handleStatus(u.searchParams.get("depositAddress") ?? "");
    if (u.pathname.endsWith("/deposit/submit")) {
      this.depositSubmits.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  private handleQuote(body: QuoteRequestBody): Response {
    this.quoteRequests++;
    if (this.quoteFails) return Response.json({ message: "Amount is too low for bridge" }, { status: 400 });
    const amountIn = BigInt(body.amount);
    const amountOut = amountIn - 32_000n;
    const q: QuoteResponse = {
      correlationId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      signature: "",
      quoteRequest: { ...body, deadline: new Date(Date.parse(body.deadline)).toISOString(), depositMode: "SIMPLE", confidentiality: "public", quoteWaitingTimeMs: 0, insured: false, appFees: [] } as QuoteResponse["quoteRequest"],
      quote: {
        amountIn: body.amount, amountInFormatted: "x", amountInUsd: "1", minAmountIn: body.amount,
        amountOut: amountOut.toString(), amountOutFormatted: "x", amountOutUsd: "1", minAmountOut: ((amountOut * 99n) / 100n).toString(),
        depositAddress: Keypair.generate().publicKey.toBase58(),
        deadline: new Date(Date.parse(body.deadline) + 72 * 3_600_000).toISOString(),
        timeWhenInactive: new Date(Date.parse(body.deadline) + 72 * 3_600_000).toISOString(),
        timeEstimate: 135, refundFee: "715", withdrawFee: "32000",
      },
    };
    this.beforeSign?.(q);
    q.signature = `ed25519:${bs58.encode(nacl.sign.detached(quoteSigningMessage(q), this.keys.secretKey))}`;
    this.quotes.push(structuredClone(q));
    this.afterSign?.(q);
    return Response.json(q);
  }

  private handleStatus(depositAddress: string): Response {
    this.statusCalls++;
    if (this.statusFails) return Response.json({ message: "boom" }, { status: 500 });
    const quote = this.quotes.find((q) => q.quote.depositAddress === depositAddress);
    if (!quote) return Response.json({ message: "Deposit address not found" }, { status: 404 });
    const script = this.scripts.get(depositAddress);
    if (!script && this.unscripted === "404") return Response.json({ message: "Deposit address not found" }, { status: 404 });
    return Response.json({
      correlationId: crypto.randomUUID(),
      status: script?.status ?? "PENDING_DEPOSIT",
      updatedAt: new Date().toISOString(),
      swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...script?.swapDetails },
      quoteResponse: quote,
    });
  }

  script(depositAddress: string, s: StatusScript): void {
    this.scripts.set(depositAddress, s);
  }

  /** The most recent non-dry quote's deposit address. */
  get lastDepositAddress(): string {
    return this.quotes[this.quotes.length - 1]!.quote.depositAddress!;
  }
}
