// Audit S2 PoCs on carry accounting and the local swap adapter.
//   S2-07  carry owed to a wallet that stops holding, or that switches rail, is never paid
//   S2-08  the simulated swap rejects with a plain Error after its burn may have broadcast
//   S2-12  markPayoutSent overwrites the signature of a payout that is already sent
import { afterEach, describe, expect, test } from "bun:test";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { config } from "../src/config";
import * as db from "../src/db";
import { planPayouts } from "../src/epoch/engine";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import { simulatedSwapAdapter } from "../src/swap/simulated";
import { SwapFundsMayHaveMoved } from "../src/swap/types";

const id = () => `epoch-audit-${crypto.randomUUID()}`;
const wallet = () => `w-${crypto.randomUUID()}`;

describe("audit S2: carry is always paid out (S2-07)", () => {
  test("a wallet with Solana carry above the floor and no share this epoch is paid its carry", () => {
    const e = id();
    const w = wallet();
    db.setCarry(w, "solana", 40_000n); // carried earlier (e.g. new_account_below_rent), then the holder sold
    planPayouts(e, new Map([[wallet(), 10_000n]]), new Set(), new Map(), new Set());
    const row = db.getPayouts(e).find((p) => p.wallet === w);
    expect(row?.amountZats).toBe("40000");
    expect(db.getCarry(w, "solana")).toBe(0n);
  });

  test("a wallet that opted out keeps its shielded carry: it moves to the Solana payout", () => {
    const e = id();
    const w = wallet();
    db.setCarry(w, "shielded", 70_000n); // held under the per-holder shielded minimum, then the holder opted out
    planPayouts(e, new Map([[w, 10_000n]]), new Set(), new Map(), new Set());
    const row = db.getPayouts(e).find((p) => p.wallet === w && p.kind === "solana");
    expect(row?.amountZats).toBe("80000");
    expect(db.getCarry(w, "shielded")).toBe(0n);
  });
});

describe("audit S2: payout rows (S2-12)", () => {
  test("a payout already sent keeps its real signature when a late resume marks it again", () => {
    const e = id();
    db.planPayout({ epochId: e, wallet: "w1", kind: "solana", amountZats: "1000" });
    db.markPayoutSent(e, "w1", "solana", "real-landed-signature");
    db.markPayoutSent(e, "w1", "solana", "carried:late_resume");
    expect(db.getPayouts(e)[0]!.sig).toBe("real-landed-signature");
  });
});

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const conn = getConnection();
const realSend = conn.sendRawTransaction.bind(conn);
afterEach(() => {
  conn.sendRawTransaction = realSend;
});

describe.if(await validatorUp())("audit S2: simulated swap (S2-08)", () => {
  test("a burn that was signed and recorded but not confirmed is SwapFundsMayHaveMoved, never a plain rejection (which the engine reads as 'safe to fall back')", async () => {
    const k = loadKeeperKeypair();
    const mint = config.solana.dbc.quoteMint;
    await mintTo(conn, k, mint, getAssociatedTokenAddressSync(mint, k.publicKey, false, TOKEN_PROGRAM_ID), k, 2_000_000n);
    conn.sendRawTransaction = (async () => {
      throw new Error("socket hang up");
    }) as typeof conn.sendRawTransaction;
    const err = await simulatedSwapAdapter.submit(1_000_000n, id()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapFundsMayHaveMoved);
  }, 30_000);
});
