// Audit S6-C1: a swap that could not be ATTEMPTED (a temporary failure before anything was signed) is retried, never
// turned into the public Solana fallback for every opted-in holder.
//   Before: submitOnce mapped every plain Error from submit() to failed_before_funds_moved, so a 1Click 5xx, a timeout, an
//   RPC error reading the keeper's balance (read as 0) or building the deposit paid every opted-in holder on the public
//   rail for good, in the same run. Only the adapter's own decisions (an amount outside its limits, a quote 1Click or the
//   pad refuses) are plain rejections now; everything temporary is SwapNotAttempted.
import { describe, expect, test } from "bun:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as db from "../src/db";
import { progressSwap } from "../src/epoch/engine";
import { makeSolanaDepositChain, type DepositChain } from "../src/swap/near1click-chain";
import { makeNear1ClickAdapter, type Near1ClickDeps } from "../src/swap/near1click";
import type { OneClickClient } from "../src/swap/near1click-api";
import { SwapNotAttempted, type SwapAdapter } from "../src/swap/types";

function epochWithShielded(shares: [string, string][]): { id: string; unsent: db.PayoutRow[] } {
  const id = `epoch-na-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
  for (const [wallet, amountZats] of shares) db.planPayout({ epochId: id, wallet, kind: "shielded", amountZats, zcashAddress: `u1${wallet}` });
  return { id, unsent: db.getUnsentPayouts(id, "shielded") };
}

describe("audit S6-C1: the engine on a swap that was not attempted", () => {
  test("SwapNotAttempted leaves the swap unstarted and the rows unsent; the next run can still start or refuse it", async () => {
    const { id, unsent } = epochWithShielded([["w1", "1500000"], ["w2", "500000"]]);
    let submits = 0;
    const flaky: SwapAdapter = {
      provider: "near-1click",
      quote: async (z) => ({ outZats: z }),
      submit: async () => { submits++; throw new SwapNotAttempted("1Click quote could not be fetched: fetch failed"); },
      status: async () => ({ status: "pending" }),
    };
    expect(await progressSwap(id, unsent, flaky)).toBe("pending");
    expect(db.getEpoch(id)!.swapState).toBe("none"); // not submitted, not failed: nothing was decided
    expect(db.getFreshUnsentPayouts(id, "shielded").map((p) => p.wallet).sort()).toEqual(["w1", "w2"]); // nobody fell back to Solana
    expect(db.getEpoch(id)!.teamSolanaZats ?? null).toBeNull(); // the team's delivery reserve was not resolved either
    expect(submits).toBe(1);

    expect(await progressSwap(id, unsent, flaky)).toBe("pending"); // the next run tries again (and fails again here)
    expect(submits).toBe(2);

    const refusing: SwapAdapter = { ...flaky, submit: async () => { throw new Error("swap amount is above the per-epoch cap"); } };
    expect(await progressSwap(id, unsent, refusing)).toBe("failed_before_funds_moved"); // a real decision still falls back, as designed
    expect(db.getEpoch(id)!.swapState).toBe("failed_before_funds_moved");
  });
});

/** A chain whose balance read fails like a dead RPC. */
const deadChain: DepositChain = {
  keeperTokenBalance: async () => { throw new TypeError("fetch failed"); },
  buildSignedDeposit: async () => { throw new Error("must not be reached"); },
  broadcast: async () => {},
  signatureStatus: async () => "absent" as never,
  depositAccountExists: async () => false,
  heights: async () => ({ confirmed: 1, finalized: 1 }),
  findIncomingTransfer: async () => null,
};
const silentClient: OneClickClient = {
  quote: async () => { throw new Error("must not be reached"); },
  status: async () => { throw new Error("must not be reached"); },
  submitDeposit: async () => {},
};
const keeper = Keypair.generate();
const baseDeps = (over: Partial<Near1ClickDeps>): Partial<Near1ClickDeps> => ({
  client: silentClient, chain: deadChain, keeperAddress: keeper.publicKey.toBase58(), receivedByTreasury: async () => null, now: () => Date.now(), sleep: async () => {},
  limits: { minSwapZats: 1_000_000n, maxSwapZats: 50_000_000n } as Near1ClickDeps["limits"], // the adapter fills the rest from its defaults
  ...over,
});

describe("audit S6-C1: what the 1Click adapter calls a temporary failure", () => {
  test("the keeper balance cannot be read: SwapNotAttempted, not 'balance below the swap'", async () => {
    const adapter = makeNear1ClickAdapter("u1treasury", baseDeps({}));
    await expect(adapter.submit(2_000_000n, `k-${crypto.randomUUID()}`)).rejects.toBeInstanceOf(SwapNotAttempted);
  });

  test("1Click answers 5xx or the network fails: SwapNotAttempted; 1Click answering 4xx stays a plain rejection", async () => {
    const chain: DepositChain = { ...deadChain, keeperTokenBalance: async () => 10_000_000n };
    for (const failure of [
      new Error("1Click quote failed: HTTP 503 upstream"), new Error("1Click quote failed: HTTP 429 Too Many Requests"), new Error("1Click quote failed: HTTP 408 timeout"),
      new Error("1Click quote failed: HTTP 502 <html>HTTP 400 looked like this once</html>"), new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError"),
    ]) {
      const client: OneClickClient = { ...silentClient, quote: async () => { throw failure; } };
      const adapter = makeNear1ClickAdapter("u1treasury", baseDeps({ client, chain }));
      await expect(adapter.submit(2_000_000n, `k-${crypto.randomUUID()}`)).rejects.toBeInstanceOf(SwapNotAttempted);
    }
    const refusing: OneClickClient = { ...silentClient, quote: async () => { throw new Error("1Click quote failed: HTTP 400 Amount is too low for bridge"); } };
    const err = await makeNear1ClickAdapter("u1treasury", baseDeps({ client: refusing, chain })).submit(2_000_000n, `k-${crypto.randomUUID()}`).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SwapNotAttempted);
    expect((err as Error).message).toMatch(/HTTP 400/);
  });

  test("an amount outside the pad's limits is still the adapter's own decision (plain rejection, nothing read)", async () => {
    const adapter = makeNear1ClickAdapter("u1treasury", baseDeps({}));
    const err = await adapter.submit(999_999n, `k-${crypto.randomUUID()}`).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(SwapNotAttempted);
    expect((err as Error).message).toMatch(/below the 1000000 zats floor/);
  });
});

describe("audit S6-C1: the deposit chain's balance read", () => {
  const mint = Keypair.generate().publicKey;
  const stub = (getAccountInfo: () => Promise<unknown>) => makeSolanaDepositChain({ keeper, mint, priorityMicroLamports: 0, connection: { getAccountInfo } as unknown as Connection });

  test("no token account yet is a balance of 0", async () => {
    expect(await stub(async () => null).keeperTokenBalance()).toBe(0n);
    expect(getAssociatedTokenAddressSync(mint, keeper.publicKey, false, TOKEN_PROGRAM_ID)).toBeInstanceOf(PublicKey);
  });

  test("an RPC failure is thrown, never read as 0", async () => {
    await expect(stub(async () => { throw new Error("429 Too Many Requests"); }).keeperTokenBalance()).rejects.toThrow("429");
  });
});
