// Local- and devnet-mode stand-in for the NEAR 1Click leg (devnet pays real Zcash TESTNET coins, src/swap/simulatedTestnet.ts): burns `amountZats` of Solana ZEC
// from the keeper's wallet on the local validator (the funds "leave" Solana),
// then has the regtest "funding" wallet pay native ZEC into the treasury's own
// address (the funds "arrive" shielded). Models a real bridge's spread +
// withdraw fee (config.simulatedSwap) instead of a 1:1 pass-through, so local
// runs exercise "pay from the swap's actual settled output" (finding 7).
//
// submit()/status() split (src/swap/types.ts) plus src/db.ts's swap_progress
// table make this resumable: the burn is signed and its bytes persisted
// BEFORE it is broadcast, so a crash between signing and confirming resumes
// by re-broadcasting the exact same signed transaction (Solana dedups by
// signature -- replaying it can never cause a second burn) rather than
// building a new one. Once the burn is confirmed, status() performs the
// treasury-side payment exactly once (recorded in swap_progress), so polling
// status() any number of times after that never pays twice.
import {
  createBurnCheckedInstruction,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config";
import { getConnection, broadcastAndConfirm, isSignatureLanded } from "../solana";
import { loadKeeperKeypair } from "../keeper";
import { payBatch, defaultUnifiedAddress, syncWallet } from "../zcash/devtool";
import { FUNDING_DIR, FUNDING_IDENTITY, TREASURY_DIR, mineBlocks, syncToTip } from "../zcash/regtest";
import { settleOnTestnet } from "./simulatedTestnet";
import * as db from "../db";
import { SwapFundsMayHaveMoved, type SwapAdapter, type SwapSubmission, type SwapSettlement } from "./types";

/** Applies a configurable spread + flat withdraw fee, the same shape as a real bridge quote (F-009: NEAR 1Click's withdrawFee). */
export function quoteSimulatedOut(amountZats: bigint, cfg = config.simulatedSwap): bigint {
  const afterSpread = (amountZats * BigInt(10_000 - cfg.spreadBps)) / 10_000n;
  return afterSpread > cfg.withdrawFeeZats ? afterSpread - cfg.withdrawFeeZats : 0n;
}

async function buildSignedBurn(amountZats: bigint): Promise<{ ref: string; rawTxBase64: string; rawTx: Uint8Array }> {
  const conn = getConnection();
  const keeper = loadKeeperKeypair();
  const quoteMint = config.solana.dbc.quoteMint;
  const mintInfo = await getMint(conn, quoteMint, "confirmed", TOKEN_PROGRAM_ID);
  const ata = (
    await getOrCreateAssociatedTokenAccount(conn, keeper, quoteMint, keeper.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)
  ).address;
  const balance = (await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  if (balance < amountZats) throw new Error(`keeper Solana ZEC balance ${balance} < requested swap ${amountZats}`);

  const burnIx = createBurnCheckedInstruction(ata, quoteMint, keeper.publicKey, amountZats, mintInfo.decimals, [], TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(burnIx);
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper); // local, no network write: the signature (and hence the ref) is now fixed
  const rawTx = tx.serialize();
  return { ref: bs58.encode(tx.signature!), rawTxBase64: Buffer.from(rawTx).toString("base64"), rawTx };
}

/** Runs the treasury-side settlement exactly once for `ref`, recording it so a later call is a no-op. */
async function settle(ref: string, amountInZats: bigint): Promise<SwapSettlement> {
  if (!config.isLocal) return settleOnTestnet(ref, amountInZats, quoteSimulatedOut(amountInZats));
  const amountOutZats = quoteSimulatedOut(amountInZats);
  syncWallet(FUNDING_DIR);
  const treasuryUA = defaultUnifiedAddress(TREASURY_DIR);
  const payTxid = amountOutZats > 0n ? payBatch(FUNDING_DIR, FUNDING_IDENTITY, [{ address: treasuryUA, zats: amountOutZats }]) : "no-payout-zero-output";
  // Mine to spendability before returning: the epoch engine spends this same
  // treasury balance right after the swap, in the batched Orchard payout.
  await mineBlocks(10);
  await syncToTip(TREASURY_DIR);
  db.recordSwapSettled(ref, amountOutZats, payTxid);
  return { status: "settled", amountOutZats };
}

/** The simulated swap exists on the local chain and on devnet (test money on both); never on mainnet. */
function assertSimulatedModeAllowed(): void {
  if (config.mode === "mainnet") throw new Error("simulated swap adapter is local/devnet only");
}

export const simulatedSwapAdapter: SwapAdapter = {
  provider: "simulated",

  async quote(amountZats: bigint) {
    return { outZats: quoteSimulatedOut(amountZats) };
  },

  /**
   * The only funds-moving step. Any rejection here is BEFORE the burn is
   * durably recorded (balance check, or signing itself, both local/read-only)
   * -- safe for the caller to treat as "no funds moved". Once this resolves,
   * `swap_progress` already holds the signed bytes even if the broadcast
   * inside this call fails or the process crashes mid-await: resuming via
   * status(ref) will find the pending row and re-broadcast the same bytes.
   */
  async submit(amountZats: bigint): Promise<SwapSubmission> {
    assertSimulatedModeAllowed();
    const { ref, rawTxBase64, rawTx } = await buildSignedBurn(amountZats);
    db.recordSwapSubmitted(ref, amountZats, rawTxBase64); // durable, BEFORE broadcasting
    try {
      await broadcastAndConfirm(rawTx, ref);
    } catch (err) {
      // The burn is signed and may be in flight (audit S2-08): never a plain rejection, which the engine reads as "safe to fall back".
      throw new SwapFundsMayHaveMoved(ref, `burn ${ref} not confirmed: ${(err as Error)?.message ?? err}`);
    }
    return { ref };
  },

  /**
   * Idempotent: replays swap_progress's recorded settlement if there is one;
   * otherwise checks whether the burn has landed (re-broadcasting the exact
   * signed bytes we persisted if not, which can never double-burn), then
   * settles exactly once.
   */
  async status(ref: string): Promise<SwapSettlement> {
    const row = db.getSwapProgress(ref);
    if (!row) return { status: "pending" }; // unknown ref: nothing to resume from
    if (row.status === "settled") return { status: "settled", amountOutZats: BigInt(row.amountOutZats!) };
    assertSimulatedModeAllowed();

    if (!(await isSignatureLanded(ref))) {
      const rawTx = new Uint8Array(Buffer.from(row.rawTxBase64!, "base64"));
      try {
        await broadcastAndConfirm(rawTx, ref);
      } catch {
        return { status: "pending" }; // still hasn't landed; caller polls again later
      }
    }
    return settle(ref, BigInt(row.amountInZats));
  },
};
