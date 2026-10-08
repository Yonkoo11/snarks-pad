// Payout policy (plan 4, review 2026-09-30). Pure: no chain. Each test names the
// behaviour the OLD code got wrong: a shielded share of 5,000 zats was sent (a
// Zcash fee of 5,000 per output ate all of it) and a 1Click swap ran for any
// total; a Solana payout to a wallet with no ZEC account always paid the rent.
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { applyShieldedPolicy } from "../src/epoch/math";
import { partitionByAccountPolicy, type ResolvedRecipient } from "../src/epoch/solanaPayout";
import { planPayouts } from "../src/epoch/engine";
import * as db from "../src/db";

const POLICY = { perHolderMinZats: 100_000n, swapMinZats: 1_000_000n };
const share = (wallet: string, amount: bigint) => ({ wallet, amount });

describe("applyShieldedPolicy", () => {
  test("a holder under 100,000 zats is carried, even when the pot is big enough to swap", () => {
    const r = applyShieldedPolicy([share("big1", 600_000n), share("big2", 600_000n), share("small", 99_999n)], new Map(), POLICY);
    expect(r.toSend.map((s) => s.wallet)).toEqual(["big1", "big2"]);
    expect(r.toCarry).toEqual([share("small", 99_999n)]);
  });

  test("a carried balance counts toward the 100,000 minimum", () => {
    const r = applyShieldedPolicy([share("a", 60_000n), share("b", 1_200_000n)], new Map([["a", 50_000n]]), POLICY);
    expect(r.toSend).toContainEqual(share("a", 110_000n));
  });

  test("when the sendable total is under 0.01 ZEC (1,000,000 zats) NOBODY is sent: every share carries and no swap runs", () => {
    const r = applyShieldedPolicy([share("a", 400_000n), share("b", 300_000n), share("c", 10_000n)], new Map(), POLICY);
    expect(r.toSend).toEqual([]);
    expect(r.toCarry.map((s) => s.amount).reduce((x, y) => x + y, 0n)).toBe(710_000n); // nothing lost
  });

  test("exactly 1,000,000 zats sendable is enough to swap", () => {
    const r = applyShieldedPolicy([share("a", 500_000n), share("b", 500_000n)], new Map(), POLICY);
    expect(r.toSend).toHaveLength(2);
  });

  test("the thresholds are configurable", () => {
    const r = applyShieldedPolicy([share("a", 10n), share("b", 10n)], new Map(), { perHolderMinZats: 5n, swapMinZats: 20n });
    expect(r.toSend).toHaveLength(2);
  });
});

describe("partitionByAccountPolicy (Solana leg)", () => {
  const ZEC = new PublicKey("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
  const recipient = (amount: bigint): ResolvedRecipient => {
    const owner = Keypair.generate().publicKey;
    return { wallet: owner.toBase58(), amount, ata: getAssociatedTokenAddressSync(ZEC, owner, false, TOKEN_PROGRAM_ID) };
  };

  test("a wallet with no ZEC account and a share at or under the rent is deferred", () => {
    const tiny = recipient(30_000n);
    const { payable, deferred } = partitionByAccountPolicy([tiny], new Set(), 30_000n);
    expect(payable).toEqual([]);
    expect(deferred).toEqual([tiny]);
  });

  test("a wallet with no ZEC account and a share over the rent is paid", () => {
    const enough = recipient(30_001n);
    expect(partitionByAccountPolicy([enough], new Set(), 30_000n).payable).toEqual([enough]);
  });

  test("a wallet that already has a ZEC account is paid whatever the amount", () => {
    const has = recipient(1n);
    expect(partitionByAccountPolicy([has], new Set([has.ata.toBase58()]), 30_000n).payable).toEqual([has]);
  });
});

describe("planPayouts", () => {
  const epochId = () => `epoch-test-${crypto.randomUUID()}`;
  const wallet = () => Keypair.generate().publicKey.toBase58();

  test("a coin creator is paid like any holder and the payout row is flagged 'creator'", () => {
    const id = epochId();
    const creator = wallet();
    const holder = wallet();
    planPayouts(id, new Map([[creator, 50_000n], [holder, 50_000n]]), new Set(), new Map(), new Set([creator]));
    const rows = db.getPayouts(id);
    expect(rows.find((p) => p.wallet === creator)).toMatchObject({ kind: "solana", amountZats: "50000", flag: "creator" });
    expect(rows.find((p) => p.wallet === holder)?.flag ?? null).toBeNull();
  });

  test("shielded shares under the per-holder minimum are carried, not planned", () => {
    const id = epochId();
    const [big, big2, small] = [wallet(), wallet(), wallet()] as [string, string, string];
    const addr = new Map([[big, "u1big"], [big2, "u1big2"], [small, "u1small"]]);
    planPayouts(id, new Map([[big, 900_000n], [big2, 900_000n], [small, 50_000n]]), new Set([big, big2, small]), addr, new Set());
    const planned = db.getPayouts(id).filter((p) => p.kind === "shielded").map((p) => p.wallet).sort();
    expect(planned).toEqual([big, big2].sort());
    expect(db.getCarry(small, "shielded")).toBe(50_000n);
  });

  test("a shielded total under 0.01 ZEC plans no shielded payout at all (no swap is ever needed) and carries everything", () => {
    const id = epochId();
    const [a, b] = [wallet(), wallet()] as [string, string];
    planPayouts(id, new Map([[a, 300_000n], [b, 300_000n]]), new Set([a, b]), new Map([[a, "u1a"], [b, "u1b"]]), new Set());
    expect(db.getPayouts(id).filter((p) => p.kind === "shielded")).toEqual([]);
    expect(db.getCarry(a, "shielded")).toBe(300_000n);
    expect(db.getCarry(b, "shielded")).toBe(300_000n);
  });
});
