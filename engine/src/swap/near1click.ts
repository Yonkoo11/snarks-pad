// Real NEAR 1Click swap leg: Solana ZEC (keeper) -> native ZEC (treasury u1).
//
// A crash-safe state machine, keyed by the epoch id, persisted in
// near1click_swaps (src/db.ts). Every claim below is pinned in
// PORT-ASSUMPTIONS.md sections 6b (the API) and 6c (these rules).
//
//   quote(dry:false) -> check it -> store it            phase quoted
//   build + sign the SPL transfer -> store the bytes    phase signed   <- a deposit MAY exist from here
//   broadcast -> confirm                                phase deposited
//   poll 1Click status                                  phase settled | returned
//   (signed -> no_deposit only when provably never landed)
//
// Rules that make a double deposit impossible:
//  - the signed bytes are stored BEFORE they are broadcast; a restart rebroadcasts
//    those exact bytes (Solana dedups by signature) and never builds a second one;
//  - once bytes are stored this adapter never rejects with a plain Error: a
//    confirm timeout, a lagging RPC or an RPC error is SwapFundsMayHaveMoved;
//  - "no deposit" needs the signature absent AND the finalized block height past
//    the blockhash's last valid height by a margin AND 1Click saying it saw nothing;
//  - 1Click evidence of a deposit always beats our own chain read (the safe direction);
//  - REFUNDED/FAILED never trigger the Solana fallback by themselves: only an
//    incoming transfer of exactly the refunded amount into the keeper's ZEC account does;
//  - the settled amount is what the treasury WALLET received, not 1Click's amountOut (N8).
import { config, ZEC_MINT_MAINNET } from "../config";
import * as db from "../db";
import { loadKeeperKeypair } from "../keeper";
import { getBalance, receivedInTx, syncWallet } from "../zcash/devtool";
import { isProvablyNeverLanded, makeSolanaDepositChain, type DepositChain } from "./near1click-chain";
import {
  NEAR_ZEC_NATIVE_ASSET,
  buildQuoteRequest,
  checkQuote,
  makeOneClickClient,
  originAssetFor,
  verifyQuoteSignature,
  type OneClickClient,
  type QuoteResponse,
  type StatusResponse,
} from "./near1click-api";
import { SwapFundsMayHaveMoved, SwapNotAttempted, type SwapAdapter, type SwapSettlement, type SwapSubmission } from "./types";

/** What the treasury's Zcash wallet reports for the delivery txids. */
export interface TreasuryReceipt {
  zats: bigint;
  /** Confirmations of the shallowest delivery tx. */
  confirmations: number;
  /** The wallet's spendable shielded balance, to be at least `zats` before the epoch spends it. */
  spendableZats: bigint;
}

export interface SwapLimits {
  minSwapZats: bigint;
  maxSwapZats: bigint;
  slippageBps: number;
  quoteValidityMs: number;
  maxLossBps: number;
  pollWindowMs: number;
  confirmTimeoutMs: number;
  submitDepositHash: boolean;
  treasuryMinConfirmations: number;
  /** A stored quote with less than this left before its request deadline is replaced (while nothing is signed). */
  minQuoteRemainingMs: number;
  /** A signed deposit is never called "provably never landed" sooner than this after it was signed, whatever the RPC says (a blockhash lives ~90 s). */
  noDepositMinAgeMs: number;
  /** After this many quotes for one epoch with nothing signed, give up and let the epoch pay Solana ZEC. */
  maxQuoteAttempts: number;
}

export type Step = "quote_received" | "quote_persisted" | "signed_persisted" | "broadcast_sent" | "confirmed";

export interface Near1ClickDeps {
  client: OneClickClient;
  chain: DepositChain;
  keeperAddress: string;
  treasuryAddress: string;
  receivedByTreasury(txids: string[]): Promise<TreasuryReceipt | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  limits: SwapLimits;
  /** Whose quote signature to trust. Default: 1Click's pinned key; only a test passes another. */
  quoteSigner?: string;
  /** Test seam: called after each durable step. A test throws from it to simulate the process dying right there. */
  checkpoint?: (step: Step) => void | Promise<void>;
}

const DEFAULT_LIMITS = (): SwapLimits => ({
  minSwapZats: config.near1click.minSwapZats,
  maxSwapZats: config.near1click.maxSwapZats,
  slippageBps: config.near1click.slippageBps,
  quoteValidityMs: config.near1click.quoteValidityMs,
  maxLossBps: config.near1click.maxLossBps,
  pollWindowMs: config.near1click.pollWindowMs,
  confirmTimeoutMs: 45_000,
  submitDepositHash: config.near1click.submitDepositHash,
  treasuryMinConfirmations: config.near1click.treasuryMinConfirmations,
  minQuoteRemainingMs: 10 * 60_000,
  noDepositMinAgeMs: 5 * 60_000,
  maxQuoteAttempts: 3,
});

/** Reads the treasury wallet (devtool): sync, then what each delivery tx paid it. Synchronous CLI calls, as everywhere in this engine. */
export function walletReceipt(walletDir: string): (txids: string[]) => Promise<TreasuryReceipt | null> {
  return async (txids) => {
    syncWallet(walletDir);
    let zats = 0n;
    let confirmations = Number.MAX_SAFE_INTEGER;
    const { height, spendableZats } = getBalance(walletDir);
    for (const txid of txids) {
      const rec = receivedInTx(walletDir, txid);
      if (!rec) return null;
      zats += rec.zats;
      confirmations = Math.min(confirmations, rec.minedHeight === null ? 0 : Math.max(0, height - rec.minedHeight + 1));
    }
    return { zats, confirmations, spendableZats };
  };
}

function defaultDeps(treasuryAddress: string): Near1ClickDeps {
  const keeper = loadKeeperKeypair();
  // A missing setting is never a reason to pay opted-in holders on the public rail (audit S6-C1): the epoch waits for a fix.
  if (!config.near1click.treasuryWalletDir) throw new SwapNotAttempted("TREASURY_WALLET_DIR is not set: the swap's settled amount is read from the treasury wallet, so it is required");
  return {
    client: makeOneClickClient({ baseUrl: config.near1click.baseUrl, apiKey: config.near1click.apiKey }),
    chain: makeSolanaDepositChain({ keeper, mint: config.solana.dbc.quoteMint, priorityMicroLamports: config.near1click.priorityMicroLamports }),
    keeperAddress: keeper.publicKey.toBase58(),
    treasuryAddress,
    receivedByTreasury: walletReceipt(config.near1click.treasuryWalletDir),
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    limits: DEFAULT_LIMITS(),
  };
}

const ORIGIN_ASSET = originAssetFor(ZEC_MINT_MAINNET.toBase58());

type Drive = { kind: "deposited" } | { kind: "no_deposit" } | { kind: "unresolved"; note: string };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pending = (note: string): SwapSettlement => ({ status: "pending", note });

export class Near1ClickAdapter implements SwapAdapter {
  readonly provider = "near-1click" as const;
  // Resolved on first use, so a read-only quote() never needs the keeper key or a wallet.
  private resolved: Near1ClickDeps | null = null;
  private readonly lastHashSubmit = new Map<string, number>();

  constructor(
    private readonly treasuryAddress: string,
    private readonly overrides: Partial<Near1ClickDeps> = {},
  ) {}

  private deps(): Near1ClickDeps {
    if (this.resolved) return this.resolved;
    const o = this.overrides;
    const complete = !!(o.client && o.chain && o.keeperAddress && o.receivedByTreasury && o.now && o.sleep);
    this.resolved = { ...(complete ? {} : defaultDeps(this.treasuryAddress)), treasuryAddress: this.treasuryAddress, ...o, limits: { ...DEFAULT_LIMITS(), ...o.limits } } as Near1ClickDeps;
    return this.resolved;
  }

  private async step(s: Step): Promise<void> {
    await this.deps().checkpoint?.(s);
  }

  // ---- quote ----

  private expectation(amountIn: bigint, deadlineIso: string) {
    const d = this.deps();
    return {
      amountIn, recipient: d.treasuryAddress, refundTo: d.keeperAddress, originAsset: ORIGIN_ASSET, destinationAsset: NEAR_ZEC_NATIVE_ASSET,
      slippageBps: d.limits.slippageBps, deadline: deadlineIso, keeper: d.keeperAddress, maxLossBps: d.limits.maxLossBps, withdrawFeeZats: config.epoch.team.withdrawFeeZats, nowMs: d.now(), signer: d.quoteSigner,
    };
  }

  private quoteRequestFor(amountIn: bigint, dry: boolean, validityMs: number) {
    const d = this.deps();
    return buildQuoteRequest({ amountIn, recipient: d.treasuryAddress, refundTo: d.keeperAddress, originAsset: ORIGIN_ASSET, slippageBps: d.limits.slippageBps, dry, deadlineMs: d.now() + validityMs });
  }

  private async requestCheckedQuote(amountIn: bigint): Promise<QuoteResponse> {
    const d = this.deps();
    const body = this.quoteRequestFor(amountIn, false, d.limits.quoteValidityMs);
    let resp: QuoteResponse;
    try {
      resp = await d.client.quote(body);
    } catch (e) {
      // 1Click saying no to THIS request (400 bad request, 404, 409, 422: the amount or the pair) is its decision and a plain
      // rejection; anything else (a 429 or 408 that will pass, a 5xx, a timeout, a network error, a malformed answer) says
      // nothing about this swap and is retried next run (audit S6-C1 and its hostile review). The status is read from the
      // start of the client's own message, never from the body it quotes.
      const status = /^1Click quote failed: HTTP (\d{3})\b/.exec(msg(e))?.[1];
      if (status && ["400", "404", "409", "422"].includes(status)) throw e;
      throw new SwapNotAttempted(`1Click quote could not be fetched, nothing was signed, retrying next run: ${msg(e)}`);
    }
    await this.step("quote_received");
    const problems = checkQuote(resp, this.expectation(amountIn, body.deadline));
    if (problems.length) throw new Error(`refusing the 1Click quote, nothing was signed: ${problems.join("; ")}`);
    return resp;
  }

  private toRow(key: string, amountIn: bigint, resp: QuoteResponse): db.NewNear1ClickQuote {
    return {
      key,
      amountInZats: amountIn.toString(),
      keeper: this.deps().keeperAddress,
      recipient: this.deps().treasuryAddress,
      quoteJson: JSON.stringify(resp),
      depositAddress: resp.quote.depositAddress!,
      requestDeadline: new Date(Date.parse(resp.quoteRequest.deadline)).toISOString(),
      quoteDeadline: new Date(Date.parse(resp.quote.deadline!)).toISOString(),
    };
  }

  private async storeFreshQuote(key: string, amountIn: bigint): Promise<db.Near1ClickSwapRow> {
    const resp = await this.requestCheckedQuote(amountIn);
    db.insertNear1ClickQuote(this.toRow(key, amountIn, resp)); // false = a row appeared meanwhile; the re-read below uses it
    await this.step("quote_persisted");
    return db.getNear1ClickSwap(key)!;
  }

  /** A stored quote is reusable while nothing is signed and it still has time, for the same amount, keeper and treasury. */
  private quoteUsable(row: db.Near1ClickSwapRow, amountIn: bigint): boolean {
    const d = this.deps();
    return row.amountInZats === amountIn.toString() && row.keeper === d.keeperAddress && row.recipient === d.treasuryAddress && Date.parse(row.requestDeadline) - d.now() > d.limits.minQuoteRemainingMs;
  }

  private async usableQuote(row: db.Near1ClickSwapRow, amountIn: bigint): Promise<db.Near1ClickSwapRow> {
    if (this.quoteUsable(row, amountIn)) return row;
    if (row.attempts >= this.deps().limits.maxQuoteAttempts) throw new Error(`no usable 1Click quote after ${row.attempts} attempts, nothing was signed`);
    const resp = await this.requestCheckedQuote(amountIn); // safe: no transaction is signed, so no deposit can exist
    db.replaceNear1ClickQuote(this.toRow(row.key, amountIn, resp));
    await this.step("quote_persisted");
    return db.getNear1ClickSwap(row.key)!;
  }

  // ---- 1Click status ----

  private async oneClickEvidence(row: db.Near1ClickSwapRow): Promise<"deposit" | "none" | "unknown"> {
    try {
      const res = await this.deps().client.status(row.depositAddress);
      if (res.kind === "unknown_address") return "none";
      if (!this.statusIsTrusted(row, res.body)) return "unknown";
      return res.body.status === "PENDING_DEPOSIT" ? "none" : "deposit";
    } catch {
      return "unknown";
    }
  }

  /** A status payload is believed only if its embedded quote is 1Click-signed and for OUR deposit address. */
  private statusIsTrusted(row: db.Near1ClickSwapRow, body: StatusResponse): boolean {
    const q = body.quoteResponse;
    if (!q) return true; // the fields we act on are all re-checked against the chain or the wallet
    return q.quote.depositAddress === row.depositAddress && verifyQuoteSignature(q, this.deps().quoteSigner);
  }

  private async bestEffortSubmitHash(row: db.Near1ClickSwapRow, everyMs = 30_000): Promise<void> {
    const d = this.deps();
    if (this.lastHashSubmit.has(row.key) && d.now() - this.lastHashSubmit.get(row.key)! < everyMs) return;
    this.lastHashSubmit.set(row.key, d.now());
    try {
      await d.client.submitDeposit(row.signature!, row.depositAddress);
    } catch (e) {
      console.error(`1Click deposit/submit failed (not needed for the swap): ${msg(e)}`);
    }
  }

  // ---- the signed deposit ----

  /**
   * Resolves a signed deposit as far as the chain and 1Click can say, chain
   * status FIRST. `rebroadcast` resends the stored bytes (never a new tx) while
   * their blockhash is alive; `waitMs` keeps looking for the confirmation.
   */
  private async driveSigned(row: db.Near1ClickSwapRow, opts: { rebroadcast: boolean; waitMs: number }): Promise<Drive> {
    const d = this.deps();
    const until = d.now() + opts.waitMs;
    let rebroadcast = opts.rebroadcast;
    for (;;) {
      const last = d.now() + 1_000 > until;
      const verdict = await this.judgeSigned(row, rebroadcast, last);
      rebroadcast = false;
      if (verdict.kind !== "unresolved" || last) return verdict;
      await d.sleep(1_000);
    }
  }

  /** `last`: no more polling follows, so also ask 1Click whether it saw a deposit our chain read has not caught up to. */
  private async judgeSigned(row: db.Near1ClickSwapRow, rebroadcast: boolean, last: boolean): Promise<Drive> {
    const d = this.deps();
    const sig = row.signature!;
    const st = await d.chain.signatureStatus(sig);
    if (st === "landed") return this.markDeposited(row, "deposit confirmed on Solana");
    if (st === "failed") return this.noDepositIfOneClickSawNothing(row, "the deposit transaction failed on chain");
    if (rebroadcast && (await this.blockhashAlive(row))) await d.chain.broadcast(new Uint8Array(Buffer.from(row.rawTxBase64!, "base64"))).catch((e) => console.error(`rebroadcast of ${sig} failed: ${msg(e)}`));
    if (await d.chain.depositAccountExists(row.depositAddress)) return this.markDeposited(row, "the deposit address's token account exists on Solana");
    const oldEnough = d.now() - Date.parse(row.signedAt ?? row.updatedAt) > d.limits.noDepositMinAgeMs;
    if (oldEnough && (await isProvablyNeverLanded(d.chain, sig, row.lastValidBlockHeight!))) return this.noDepositIfOneClickSawNothing(row, "the signed deposit expired without landing");
    if (last && (await this.oneClickEvidence(row)) === "deposit") return this.markDeposited(row, "1Click reports a deposit");
    return { kind: "unresolved", note: `deposit ${sig} is ${st}; not confirmed, not provably absent` };
  }

  private async blockhashAlive(row: db.Near1ClickSwapRow): Promise<boolean> {
    const d = this.deps();
    return d.now() < Date.parse(row.requestDeadline) && (await d.chain.heights()).confirmed <= row.lastValidBlockHeight!;
  }

  private markDeposited(row: db.Near1ClickSwapRow, note: string): Drive {
    db.advanceNear1ClickPhase(row.key, ["signed"], "deposited");
    db.setNear1ClickNote(row.key, note);
    return { kind: "deposited" };
  }

  private async noDepositIfOneClickSawNothing(row: db.Near1ClickSwapRow, why: string): Promise<Drive> {
    const seen = await this.oneClickEvidence(row);
    if (seen === "deposit") return this.markDeposited(row, "1Click reports a deposit");
    if (seen === "unknown") return { kind: "unresolved", note: `${why}, but 1Click could not confirm it saw no deposit` };
    if (!db.advanceNear1ClickPhase(row.key, ["signed"], "no_deposit")) return { kind: "unresolved", note: `${why}, but the swap is no longer in the signed phase` };
    db.setNear1ClickNote(row.key, why);
    return { kind: "no_deposit" };
  }

  // ---- polling an existing deposit ----

  private async pollDeposited(row: db.Near1ClickSwapRow): Promise<SwapSettlement> {
    const d = this.deps();
    let res;
    try {
      res = await d.client.status(row.depositAddress);
    } catch (e) {
      return pending(`1Click status unavailable: ${msg(e)}`);
    }
    if (res.kind === "unknown_address") return this.afterNoSight(row, "1Click does not know the deposit address yet");
    const body = res.body;
    if (!this.statusIsTrusted(row, body)) return pending("1Click status payload failed the quote-signature check; ignoring it");
    db.setNear1ClickNote(row.key, `1Click status ${body.status}`);
    switch (body.status) {
      case "SUCCESS":
        return this.settleFromTreasury(row, body);
      case "REFUNDED":
        return this.confirmRefund(row, body);
      case "PENDING_DEPOSIT":
        return this.afterNoSight(row, "the deposit is confirmed on Solana but 1Click shows PENDING_DEPOSIT");
      case "FAILED":
        return pending("1Click reports FAILED: no fallback until funds are seen back in the keeper account (REFUNDED) or the swap delivers");
      case "INCOMPLETE_DEPOSIT":
        return pending("1Click reports INCOMPLETE_DEPOSIT: it expects a refund by the request deadline");
      default:
        return pending(`1Click status ${body.status}`);
    }
  }

  private async afterNoSight(row: db.Near1ClickSwapRow, note: string): Promise<SwapSettlement> {
    await this.bestEffortSubmitHash(row); // N14: nudges 1Click; failure is harmless
    return pending(note);
  }

  private async settleFromTreasury(row: db.Near1ClickSwapRow, body: StatusResponse): Promise<SwapSettlement> {
    const d = this.deps();
    const txids = (body.swapDetails?.destinationChainTxHashes ?? []).map((t) => t.hash).filter((h) => /^[0-9a-f]{64}$/.test(h));
    if (txids.length === 0) return pending("1Click reports SUCCESS without a Zcash txid yet");
    const reused = txids.map((t) => db.findNear1ClickSwapByDestinationTxid(t, row.key)).find((k) => k);
    if (reused) return pending(`the delivery tx is already the settlement of swap ${reused}: not counting it twice, needs a human`);
    let receipt: TreasuryReceipt | null;
    try {
      receipt = await d.receivedByTreasury(txids);
    } catch (e) {
      return pending(`could not read the treasury wallet: ${msg(e)}`);
    }
    if (!receipt) return pending(`delivered by 1Click (${txids.join(",")}); the treasury wallet has not seen it yet`);
    if (receipt.confirmations < d.limits.treasuryMinConfirmations || receipt.spendableZats < receipt.zats) {
      return pending(`delivered ${receipt.zats} zats, ${receipt.confirmations}/${d.limits.treasuryMinConfirmations} confirmations, spendable ${receipt.spendableZats}`);
    }
    if (receipt.zats === 0n || receipt.zats > BigInt(row.amountInZats)) return pending(`treasury received ${receipt.zats} zats for a ${row.amountInZats} deposit: not accepting it, needs a human`);
    db.advanceNear1ClickPhase(row.key, ["deposited"], "settled", { amountOutZats: receipt.zats.toString(), destinationTxids: txids });
    return { status: "settled", amountOutZats: receipt.zats };
  }

  private async confirmRefund(row: db.Near1ClickSwapRow, body: StatusResponse): Promise<SwapSettlement> {
    const refunded = /^[0-9]{1,30}$/.test(body.swapDetails?.refundedAmount ?? "") ? BigInt(body.swapDetails!.refundedAmount!) : 0n;
    if (refunded === 0n) return pending("1Click reports REFUNDED without a refunded amount: no fallback until a human checks the keeper account");
    let seenSig: string | null;
    try {
      seenSig = await this.deps().chain.findIncomingTransfer(row.signature!, refunded);
    } catch (e) {
      return pending(`could not search the keeper account for the refund: ${msg(e)}`);
    }
    if (!seenSig) return pending(`1Click reports REFUNDED (${refunded} zats) but no such transfer is in the keeper account yet`);
    // amountOutZats on a returned row is what came back (audit S3-01: a refund is short by 1Click's refund fee).
    db.advanceNear1ClickPhase(row.key, ["deposited"], "returned", { refundSig: seenSig, amountOutZats: refunded.toString() });
    return { status: "returned", amountReturnedZats: refunded };
  }

  private async statusOnce(key: string): Promise<SwapSettlement> {
    const row = db.getNear1ClickSwap(key);
    if (!row) return pending(`no 1Click swap is recorded for ${key}`);
    switch (row.phase) {
      case "settled":
        return { status: "settled", amountOutZats: BigInt(row.amountOutZats!) };
      case "returned":
        return { status: "returned", amountReturnedZats: row.amountOutZats ? BigInt(row.amountOutZats) : undefined };
      case "no_deposit":
        return { status: "returned" };
      case "quoted":
        return pending("a 1Click quote is stored but no deposit was signed yet");
      case "signed": {
        const drive = await this.driveSigned(row, { rebroadcast: true, waitMs: 0 });
        if (drive.kind === "no_deposit") return { status: "returned" };
        if (drive.kind === "unresolved") return pending(drive.note);
        return this.pastDeadline(row, await this.pollDeposited(db.getNear1ClickSwap(key)!));
      }
      case "deposited":
        return this.pastDeadline(row, await this.pollDeposited(row));
    }
  }

  /** Past the request deadline 1Click should be refunding: say so, and still never fall back before the refund is seen. */
  private pastDeadline(row: db.Near1ClickSwapRow, result: SwapSettlement): SwapSettlement {
    if (result.status !== "pending" || this.deps().now() <= Date.parse(row.requestDeadline)) return result;
    return pending(`${result.note ?? "pending"} (past the request deadline ${row.requestDeadline}: 1Click should refund; no fallback until the refund is seen)`);
  }

  // ---- the adapter ----

  private guardAmount(amountZats: bigint): void {
    const l = this.deps().limits;
    if (config.solana.dbc.quoteMint.toBase58() !== ZEC_MINT_MAINNET.toBase58()) throw new Error("the 1Click swap only runs with the mainnet ZEC mint");
    if (amountZats < l.minSwapZats) throw new Error(`swap amount ${amountZats} is below the ${l.minSwapZats} zats floor`);
    if (amountZats > l.maxSwapZats) throw new Error(`swap amount ${amountZats} is above the ${l.maxSwapZats} zats per-epoch cap (PAD_SWAP_MAX_ZATS)`);
  }

  private async requireKeeperBalance(amountIn: bigint): Promise<void> {
    let balance: bigint;
    try {
      balance = await this.deps().chain.keeperTokenBalance();
    } catch (e) {
      throw new SwapNotAttempted(`keeper Solana ZEC balance could not be read, nothing was signed, retrying next run: ${msg(e)}`); // audit S6-C1: not a balance of 0
    }
    if (balance < amountIn) throw new Error(`keeper Solana ZEC balance is below the requested swap ${amountIn}, nothing was signed`);
  }

  private async signAndStore(row: db.Near1ClickSwapRow, amountIn: bigint): Promise<db.Near1ClickSwapRow> {
    const d = this.deps();
    await this.requireKeeperBalance(amountIn);
    let built: Awaited<ReturnType<DepositChain["buildSignedDeposit"]>>;
    try {
      built = await d.chain.buildSignedDeposit(row.depositAddress, amountIn);
    } catch (e) {
      throw new SwapNotAttempted(`the deposit could not be built (RPC), nothing was signed, retrying next run: ${msg(e)}`); // audit S6-C1
    }
    const stored = db.recordNear1ClickSigned(row.key, { signature: built.signature, rawTxBase64: Buffer.from(built.rawTx).toString("base64"), lastValidBlockHeight: built.lastValidBlockHeight });
    if (!stored) return db.getNear1ClickSwap(row.key)!; // another run signed first: resume that one, never ours
    try {
      await this.step("signed_persisted");
      return db.getNear1ClickSwap(row.key)!;
    } catch (e) {
      throw new SwapFundsMayHaveMoved(row.key, `signed deposit stored, then: ${msg(e)}`); // bytes exist: never a plain rejection
    }
  }

  /** From here a deposit may exist: every failure is SwapFundsMayHaveMoved, except a proven no-deposit. */
  private async sendAndConfirm(row: db.Near1ClickSwapRow, key: string): Promise<SwapSubmission> {
    const d = this.deps();
    try {
      if (row.phase === "deposited") return { ref: key }; // already confirmed on an earlier run
      if (row.phase === "signed") {
        if (await this.blockhashAlive(row)) await d.chain.broadcast(new Uint8Array(Buffer.from(row.rawTxBase64!, "base64"))).catch((e) => console.error(`broadcast of ${row.signature} failed, will retry on resume: ${msg(e)}`));
        await this.step("broadcast_sent");
      }
      const drive = await this.driveSigned(db.getNear1ClickSwap(key)!, { rebroadcast: false, waitMs: d.limits.confirmTimeoutMs });
      if (drive.kind === "no_deposit") throw new NoDeposit(db.getNear1ClickSwap(key)?.note ?? "no deposit landed");
      if (drive.kind === "unresolved") throw new Unresolved(drive.note);
      await this.step("confirmed");
      if (d.limits.submitDepositHash) await this.bestEffortSubmitHash(db.getNear1ClickSwap(key)!);
      return { ref: key };
    } catch (e) {
      if (e instanceof NoDeposit) throw new Error(`the 1Click deposit provably did not land: ${e.message}`);
      throw new SwapFundsMayHaveMoved(key, msg(e));
    }
  }

  private async resumeStarted(row: db.Near1ClickSwapRow, amountZats: bigint, key: string): Promise<SwapSubmission> {
    if (row.amountInZats !== amountZats.toString()) console.error(`swap ${key} already started with ${row.amountInZats} zats (now asked for ${amountZats}); resuming the original`);
    if (row.phase === "settled") return { ref: key };
    if (row.phase === "returned" || row.phase === "no_deposit") throw new Error(`swap ${key} ended with the ZEC back in the keeper account (${row.phase}); not starting another`);
    return this.sendAndConfirm(row, key);
  }

  async quote(amountZats: bigint): Promise<{ outZats: bigint }> {
    const d = this.deps();
    const resp = await d.client.quote(this.quoteRequestFor(amountZats, true, 30 * 60_000));
    if (!verifyQuoteSignature(resp, d.quoteSigner)) throw new Error("1Click dry quote failed the signature check");
    return { outZats: BigInt(resp.quote.amountOut) };
  }

  async submit(amountZats: bigint, key: string): Promise<SwapSubmission> {
    let row = db.getNear1ClickSwap(key);
    if (row && row.phase !== "quoted") return this.resumeStarted(row, amountZats, key);
    this.guardAmount(amountZats);
    await this.requireKeeperBalance(amountZats); // before asking for a quote nobody will use
    row = row ? await this.usableQuote(row, amountZats) : await this.storeFreshQuote(key, amountZats);
    row = await this.signAndStore(row, amountZats);
    return this.sendAndConfirm(row, key);
  }

  async status(ref: string): Promise<SwapSettlement> {
    const d = this.deps();
    const stopAt = d.now() + d.limits.pollWindowMs;
    let wait = 3_000;
    for (;;) {
      let result: SwapSettlement;
      try {
        result = await this.statusOnce(ref);
      } catch (e) {
        result = pending(`status check failed, will retry: ${msg(e)}`); // never a fallback signal
      }
      if (result.status !== "pending" || d.now() + wait > stopAt) return result;
      await d.sleep(wait);
      wait = Math.min(Math.round(wait * 1.5), 15_000);
    }
  }
}

export function makeNear1ClickAdapter(treasuryUnifiedAddress: string, overrides?: Partial<Near1ClickDeps>): SwapAdapter {
  return new Near1ClickAdapter(treasuryUnifiedAddress, overrides);
}

class NoDeposit extends Error {}
class Unresolved extends Error {}
