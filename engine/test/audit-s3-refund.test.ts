// Audit S3 PoC.
//   S3-01  A refunded 1Click swap comes back short by 1Click's refund fee, yet the epoch credits the team its whole
//          gross share and the opted-in holders their whole planned amounts as Solana fallback. The keeper pays the
//          difference out of money it holds for others (carry, later epochs). Per the delivery-cost rule the team
//          bears delivery costs first, so the refund fee comes out of the team's share.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";
import { progressSwap } from "../src/epoch/engine";
import type { SwapAdapter } from "../src/swap/types";

function refundingSwap(returnedZats: bigint | undefined): SwapAdapter {
  return {
    provider: "simulated",
    quote: async (a) => ({ outZats: a }),
    submit: async (_amount, key) => ({ ref: `ref-${key}` }),
    status: async () => ({ status: "returned", amountReturnedZats: returnedZats }),
  } as SwapAdapter;
}

function setup(teamGross: bigint, reserve: bigint, shares: bigint[]): { epochId: string; wallets: string[] } {
  const epochId = `epoch-s3-${crypto.randomUUID()}`;
  db.upsertEpoch({
    id: epochId, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok",
    swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]", includeShielded: 1,
  });
  db.setEpochTeamSplit(epochId, teamGross, reserve);
  const wallets = shares.map(() => `w-${crypto.randomUUID()}`);
  shares.forEach((s, i) => db.planPayout({ epochId, wallet: wallets[i]!, kind: "shielded", amountZats: s.toString(), zcashAddress: "u1x", flag: null }));
  return { epochId, wallets };
}

describe("audit S3-01: a refund short by the refund fee is borne by the team, not by other money in the keeper", () => {
  test("refund 726 zats short: team Solana share drops by 726, holders keep their planned amounts", async () => {
    const { epochId, wallets } = setup(100_000n, 60_000n, [300_000n, 100_000n]);
    const deposit = 300_000n + 100_000n + 60_000n;
    const out = await progressSwap(epochId, db.getUnsentPayouts(epochId, "shielded"), refundingSwap(deposit - 726n));
    expect(out).toBe("returned_to_keeper");
    const e = db.getEpoch(epochId)!;
    expect(e.teamSolanaZats).toBe((100_000n - 726n).toString());
    const rows = db.getPayouts(epochId);
    expect(rows.find((r) => r.wallet === wallets[0])!.amountZats).toBe("300000");
    expect(rows.find((r) => r.wallet === wallets[1])!.amountZats).toBe("100000");
  });

  test("a shortfall larger than the team's share is borne by the holders pro rata; total out never exceeds what came back", async () => {
    const { epochId } = setup(1_000n, 1_000n, [300_000n, 100_000n]);
    const deposit = 401_000n;
    const returned = deposit - 5_000n;
    await progressSwap(epochId, db.getUnsentPayouts(epochId, "shielded"), refundingSwap(returned));
    const e = db.getEpoch(epochId)!;
    expect(e.teamSolanaZats).toBe("0");
    const holderTotal = db.getPayouts(epochId).reduce((a, r) => a + BigInt(r.amountZats), 0n);
    // what the keeper may pay for this epoch: what came back plus the team's gross that never entered the swap (0 here)
    expect(holderTotal + BigInt(e.teamSolanaZats!)).toBeLessThanOrEqual(returned);
    expect(BigInt(e.holderShortfallZats!)).toBe(4_000n);
  });

  test("a returned swap that does not say how much came back (nothing moved) keeps today's behavior", async () => {
    const { epochId } = setup(100_000n, 60_000n, [300_000n]);
    await progressSwap(epochId, db.getUnsentPayouts(epochId, "shielded"), refundingSwap(undefined));
    expect(db.getEpoch(epochId)!.teamSolanaZats).toBe("100000");
    expect(db.getPayouts(epochId)[0]!.amountZats).toBe("300000");
  });
});
