// One swap per epoch: Solana ZEC (in the keeper's wallet) -> native ZEC (in the
// pad's Zcash treasury). Never per-holder (see ai/senior-review/REVIEW.md K2).
//
// Split into submit()/status() (rather than one execute()) so the epoch engine
// can persist a durable state machine around it: planned -> submitted(ref) ->
// settled(amountOut) | failed-before-funds-moved (src/epoch/engine.ts
// progressSwap). This mirrors how a real bridge works (you send a deposit,
// then poll a status endpoint) and is what makes the swap leg resumable
// without ever double-paying: once submit() has resolved, funds have already
// left the keeper, so the engine never falls back to Solana ZEC after that
// point -- it only ever polls status() again.
export type SwapProvider = "near-1click" | "simulated";

export interface SwapSubmission {
  /** Durable proof the swap was submitted (e.g. the Solana burn/deposit signature). Passed to status() on every later poll. */
  ref: string;
}

/**
 * pending:  keep polling; nothing may be paid another way.
 * settled:  the swap delivered; amountOutZats is what the treasury really received.
 * returned: the swap will not deliver AND the keeper is provably holding the ZEC again
 *           (a refund seen on chain, or a deposit that provably never landed): the
 *           only state after submit() succeeded from which falling back is safe.
 */
export type SwapSettlementStatus = "pending" | "settled" | "returned";

export interface SwapSettlement {
  status: SwapSettlementStatus;
  /** Only present once status === "settled": the real native ZEC the treasury received, after the bridge's own spread/fees. */
  amountOutZats?: bigint;
  /** Only with status === "returned": what came back to the keeper, when it can be less than the deposit (a refund fee). Absent: nothing moved. */
  amountReturnedZats?: bigint;
  /** Why a pending swap is waiting, for the operator's log. */
  note?: string;
}

/**
 * Thrown by submit() once a deposit MAY have left the keeper (signed bytes are
 * stored, so a broadcast may have landed) but the adapter cannot say it did.
 * The engine records the swap as submitted with `ref` and polls status(); it
 * must never treat this like a plain rejection (a confirm timeout is not "no
 * funds moved").
 */
export class SwapFundsMayHaveMoved extends Error {
  constructor(
    readonly ref: string,
    message: string,
  ) {
    super(message);
    this.name = "SwapFundsMayHaveMoved";
  }
}

/**
 * Thrown by submit() when nothing was signed AND the refusal is not the adapter's decision but a temporary failure
 * (a network or RPC error, a balance that could not be read, a 5xx from the provider, a missing setting). The engine
 * leaves the swap unstarted and tries again on the next run; it never falls back to Solana ZEC on it (audit S6-C1:
 * one transient error used to pay every opted-in holder on the public rail for good).
 */
export class SwapNotAttempted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapNotAttempted";
  }
}

export interface SwapAdapter {
  provider: SwapProvider;
  /** Read-only estimate; never moves funds. */
  quote(amountZats: bigint): Promise<{ outZats: bigint }>;
  /**
   * Moves `amountZats` of Solana ZEC out of the keeper toward the treasury.
   * `key` is the epoch id: calling submit() again with the same key (after a
   * crash, say) must return the swap already started, never start a second.
   * Contract: if this rejects with a plain Error, no funds may have left the
   * keeper (nothing was signed) and the adapter DECIDED not to swap (an amount
   * outside its limits, a quote it refuses) -- the engine treats it as safe to
   * fall back to Solana ZEC. If it rejects with SwapNotAttempted, nothing was
   * signed either but the cause is temporary: the engine retries next run and
   * never falls back on it. If it rejects with SwapFundsMayHaveMoved, or
   * resolves, a deposit may exist; the engine persists "submitted" with the ref
   * before doing anything else and never falls back on a submit() outcome again.
   */
  submit(amountZats: bigint, key: string): Promise<SwapSubmission>;
  /** Never throws for "still pending" -- returns a status instead. Safe to call any number of times for the same ref (idempotent). */
  status(ref: string): Promise<SwapSettlement>;
}
