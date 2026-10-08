// research/METEORA-WORKSHOP.md L2: trades and claims carry a compute unit price; PAD_PRIORITY_MICROLAMPORTS sets it, 0 turns it off.
import { describe, expect, test } from "bun:test";
import { ComputeBudgetProgram, Keypair, SystemProgram } from "@solana/web3.js";
import { priorityMicroLamports, withPriorityFee } from "../src/solana";

const transfer = SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });

describe("priority fee on trades and claims", () => {
  test("the price goes first and the instructions keep their order", () => {
    const out = withPriorityFee([transfer, transfer], 50_000);
    expect(out).toHaveLength(3);
    expect(out[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(out.slice(1)).toEqual([transfer, transfer]);
  });

  test("0 turns it off", () => {
    expect(withPriorityFee([transfer], 0)).toEqual([transfer]);
  });

  test("the setting: default 50,000; a bad or out-of-range value falls back to the default", () => {
    expect(priorityMicroLamports({})).toBe(50_000);
    expect(priorityMicroLamports({ PAD_PRIORITY_MICROLAMPORTS: "0" })).toBe(0);
    expect(priorityMicroLamports({ PAD_PRIORITY_MICROLAMPORTS: "120000" })).toBe(120_000);
    expect(priorityMicroLamports({ PAD_PRIORITY_MICROLAMPORTS: "lots" })).toBe(50_000);
    expect(priorityMicroLamports({ PAD_PRIORITY_MICROLAMPORTS: "99999999" })).toBe(50_000);
  });
});
