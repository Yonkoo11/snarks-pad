// Devnet's half of the simulated swap: after the stand-in ZEC is burnt on Solana devnet, the "bridge" pays real Zcash
// TESTNET coins (TAZ) from a funding wallet into the pad's testnet treasury, exactly once, then waits until the treasury
// sees that payment with enough confirmations (the same rule the real 1Click leg uses). Never used on mainnet.
//
// Crash safety: the intent is written BEFORE the wallet pays ("paying") and the txid right after ("paid"). A restart that
// finds "paying" without a txid cannot know whether the payment went out, so it waits for a person rather than paying twice.
import { config } from "../config";
import * as db from "../db";
import { chainTipHeight, getBalance, payBatch, receivedInTx, syncWallet } from "../zcash/devtool";
import type { SwapSettlement } from "./types";

type PayRecord = { state: "paying"; at: string } | { state: "paid"; txid: string; amountOutZats: string };

const metaKey = (ref: string): string => `devnet_swap_pay:${ref}`;

function readRecord(ref: string): PayRecord | null {
  const raw = db.getMeta(metaKey(ref));
  return raw ? (JSON.parse(raw) as PayRecord) : null;
}

/** Pays the treasury once from the funding wallet; returns the txid, or a pending note when a person must look. */
function payTreasuryOnce(ref: string, amountOutZats: bigint): { txid: string } | { note: string } {
  const existing = readRecord(ref);
  if (existing?.state === "paid") return { txid: existing.txid };
  if (existing?.state === "paying") {
    return { note: `a testnet payment for swap ${ref} may or may not have been sent (the keeper stopped while paying); check the funding wallet's list-tx, then set meta ${metaKey(ref)} to a paid record or delete it` };
  }
  const { fundingWalletDir, fundingIdentityFile } = config.simulatedSwap;
  const treasuryAddress = process.env.TREASURY_ZCASH_ADDRESS;
  if (!fundingWalletDir || !fundingIdentityFile || !treasuryAddress) throw new Error("devnet simulated swap: funding wallet or treasury address is not configured");
  syncWallet(fundingWalletDir);
  db.setMeta(metaKey(ref), JSON.stringify({ state: "paying", at: new Date().toISOString() } satisfies PayRecord));
  const txid = payBatch(fundingWalletDir, fundingIdentityFile, [{ address: treasuryAddress, zats: amountOutZats }]);
  db.setMeta(metaKey(ref), JSON.stringify({ state: "paid", txid, amountOutZats: amountOutZats.toString() } satisfies PayRecord));
  return { txid };
}

/** Idempotent: pays once, then reports pending until the treasury holds the payment with enough confirmations, then settles from what the treasury received. */
export async function settleOnTestnet(ref: string, amountInZats: bigint, expectedOutZats: bigint): Promise<SwapSettlement> {
  void amountInZats;
  if (expectedOutZats <= 0n) throw new Error(`simulated swap ${ref}: the quote leaves nothing to pay`);
  const paid = payTreasuryOnce(ref, expectedOutZats);
  if ("note" in paid) return { status: "pending", note: paid.note };
  const dir = config.near1click.treasuryWalletDir!;
  syncWallet(dir);
  const received = receivedInTx(dir, paid.txid);
  if (!received || received.minedHeight === null) return { status: "pending", note: `testnet payment ${paid.txid} is not mined yet` };
  const confs = chainTipHeight(dir) - received.minedHeight + 1;
  const need = config.near1click.treasuryMinConfirmations;
  if (confs < need || getBalance(dir).spendableZats < received.zats) {
    return { status: "pending", note: `testnet payment ${paid.txid} has ${Math.max(confs, 0)}/${need} confirmations` };
  }
  db.recordSwapSettled(ref, received.zats, paid.txid);
  return { status: "settled", amountOutZats: received.zats };
}
