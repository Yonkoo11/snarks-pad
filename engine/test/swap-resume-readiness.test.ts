// A resume of a swap whose deposit already exists must never be blocked by "fund the
// keeper" checks and must never deposit again; a fresh swap with an empty keeper must
// still be refused. Fake balances and a fake chain: no validator, no network.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { balanceProblems, fundingNeeds } from "../src/swap/live-readiness";
import { makeNear1ClickAdapter } from "../src/swap/near1click";
import type { DepositChain } from "../src/swap/near1click-chain";
import { makeOneClickClient } from "../src/swap/near1click-api";
import { config } from "../src/config";

const AMOUNT = 150_000n;
const want = { amountZats: AMOUNT, minLamports: 3_500_000n, keeper: "K", zecAccount: "ATA", zecLabel: "0.0015 ZEC" };
const rich = 10_000_000n;

describe("live-check readiness from the persisted phase", () => {
  test("a fresh swap with 0 ZEC is refused", () => {
    expect(balanceProblems(fundingNeeds(undefined), { lamports: rich, zecZats: 0n }, want).join()).toContain("ZEC account");
    expect(balanceProblems(fundingNeeds("quoted"), { lamports: rich, zecZats: 0n }, want).length).toBe(1);
  });
  test("a fresh swap with enough ZEC but no SOL is refused", () => {
    expect(balanceProblems(fundingNeeds(undefined), { lamports: 0n, zecZats: AMOUNT }, want).join()).toContain("SOL");
  });
  test("resume past `deposited` with 0 ZEC and 0 SOL has no funding problem", () => {
    for (const phase of ["deposited", "settled", "returned", "no_deposit"] as const) {
      expect(balanceProblems(fundingNeeds(phase), { lamports: 0n, zecZats: 0n }, want)).toEqual([]);
      expect(fundingNeeds(phase).quoteAndSimulation).toBe(false);
    }
  });
  test("a signed swap needs SOL to rebroadcast but not ZEC", () => {
    const p = balanceProblems(fundingNeeds("signed"), { lamports: 0n, zecZats: 0n }, want);
    expect(p.length).toBe(1);
    expect(p[0]).toContain("SOL");
  });
});

describe("adapter: a deposited swap is never re-deposited, even with an empty keeper", () => {
  test("submit() on a deposited row returns its ref and never signs or broadcasts", async () => {
    const key = `resume-readiness-${crypto.randomUUID()}`;
    db.insertNear1ClickQuote({ key, amountInZats: AMOUNT.toString(), keeper: "K", recipient: "T", quoteJson: "{}", depositAddress: `D-${key}`, requestDeadline: new Date(Date.now() + 3_600_000).toISOString(), quoteDeadline: new Date(Date.now() + 3_600_000).toISOString() });
    db.recordNear1ClickSigned(key, { signature: "sig", rawTxBase64: "AA==", lastValidBlockHeight: 1 });
    db.advanceNear1ClickPhase(key, ["signed"], "deposited");
    let sends = 0;
    const boom = async (): Promise<never> => {
      sends++;
      throw new Error("must not be called");
    };
    const chain = { keeperTokenBalance: async () => 0n, buildSignedDeposit: boom, broadcast: boom } as unknown as DepositChain;
    const adapter = makeNear1ClickAdapter("T", {
      client: makeOneClickClient({ baseUrl: "http://unused", fetch: boom as never }),
      chain, keeperAddress: "K", receivedByTreasury: async () => null, now: () => Date.now(), sleep: async () => {},
    });
    expect(await adapter.submit(AMOUNT, key)).toEqual({ ref: key });
    expect(sends).toBe(0);
    expect(db.getNear1ClickSwap(key)!.phase).toBe("deposited");
  });
  test("a fresh submit() with 0 ZEC refuses before any quote or signature", async () => {
    let calls = 0;
    const boom = async (): Promise<never> => {
      calls++;
      throw new Error("must not be called");
    };
    const chain = { keeperTokenBalance: async () => 0n, buildSignedDeposit: boom, broadcast: boom } as unknown as DepositChain;
    const adapter = makeNear1ClickAdapter("T", {
      client: makeOneClickClient({ baseUrl: "http://unused", fetch: boom as never }),
      chain, keeperAddress: "K", receivedByTreasury: async () => null, now: () => Date.now(), sleep: async () => {},
    });
    const key = `fresh-readiness-${crypto.randomUUID()}`;
    await expect(adapter.submit(config.near1click.minSwapZats, key)).rejects.toThrow(/below the requested swap|only runs with the mainnet/);
    expect(calls).toBe(0);
  });
});
