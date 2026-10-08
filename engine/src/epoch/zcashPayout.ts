// Shielded holder payouts: ONE batched shielded (Ironwood-pool) transaction per chunk, from the
// pad's treasury, never one transaction per holder (see ai/senior-review K2).
// Chunked at config.epoch.maxShieldedRecipientsPerTx.
//
// Resumable (finding 1): the instant devtool's `pay` returns a txid, the
// caller persists it as pending BEFORE moving to the next chunk (via
// onPending) -- never waiting until every chunk in the batch is done. A crash
// mid-batch resumes by checking that txid's chain status (mined/mempool/
// unknown) instead of blindly resending: see checkZcashTxLanded.
//
// Chunk-to-chunk spend safety (finding 1): chunk 2 must not spend chunk 1's
// still-unconfirmed change. On regtest we mine to the wallet's own
// spendability policy between chunks (mineBlocks + syncToTip already do this,
// well past 1 confirmation); on a real network the chosen policy is
// `config.epoch.zcashChunkConfirmations` (documented in engine/README.md
// "Multi-chunk shielded payouts").
import { config } from "../config";
import { payBatch, syncWallet, type Payment } from "../zcash/devtool";
import { chunk } from "./math";

export interface ZcashPayoutTarget {
  wallet: string;
  zcashAddress: string;
  amount: bigint;
  /** Memo shown with the note in the recipient's wallet. */
  memo?: string;
}

export interface ZcashPayoutHooks {
  /** Called before each chunk is marked as intended, and again right before devtool runs (it broadcasts inside `pay`): throw to stop before anything is sent. */
  beforeChunk?: () => void | Promise<void>;
  /**
   * Called right before devtool runs for a chunk (audit O-4): persist that these rows may be sent from now on. devtool
   * broadcasts inside `pay` and runs as its own process, so a keeper that dies here leaves it running; the restarted
   * keeper must look in the treasury wallet for what it sent instead of treating the rows as fresh.
   */
  onIntent?: (wallets: string[]) => void | Promise<void>;
  /** Called the instant devtool's `pay` returns a txid, BEFORE the next chunk is sent. */
  onPending: (wallets: string[], txid: string) => void | Promise<void>;
  /** Called once the chunk is confirmed to have landed. */
  onSent: (wallets: string[], txid: string) => void | Promise<void>;
}

export interface ZcashPayoutResult {
  txids: string[];
  perWallet: Map<string, string>; // wallet -> txid
  feeZats: bigint; // network fees of those transactions, read back from the node (local mode only; 0 elsewhere)
}

export async function sendZcashPayouts(
  targets: ZcashPayoutTarget[],
  treasuryDir: string,
  treasuryIdentity: string,
  hooks: ZcashPayoutHooks,
): Promise<ZcashPayoutResult> {
  const perWallet = new Map<string, string>();
  const txids: string[] = [];
  let feeZats = 0n;
  if (targets.length === 0) return { txids, perWallet, feeZats };

  // Local-only helpers, loaded lazily so test/main-mode code paths never touch
  // the regtest module.
  const regtest = config.isLocal ? await import("../zcash/regtest") : null;
  const chunks = chunk(targets, config.epoch.maxShieldedRecipientsPerTx);

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i]!;
    const payments: Payment[] = batch.map((t) => ({ address: t.zcashAddress, zats: t.amount, memo: t.memo }));
    await hooks.beforeChunk?.();
    const wallets = batch.map((t) => t.wallet);
    await hooks.onIntent?.(wallets);
    // Synced right before paying (stress run, audit/STRESS-REPORT.md D4): a wallet that last synced before the chain
    // moved past devtool's expiry delta (~40 blocks) builds transactions the node rejects as expired, run after run.
    syncWallet(treasuryDir);
    // Checked again right before devtool runs (stress chaos round 32, D11): a keeper frozen after marking the intent
    // must not pay once it wakes if another run has taken the lock over and handled these rows meanwhile.
    await hooks.beforeChunk?.();
    const txid = payBatch(treasuryDir, treasuryIdentity, payments);
    await hooks.onPending(wallets, txid); // durable, before this chunk is considered done or the next chunk starts

    if (regtest) {
      feeZats += await regtest.shieldedTxFeeZats(txid);
      // 10 confirmations before this wallet's default policy calls a received
      // note spendable; 1 is enough for it to
      // show up in the recipient's total balance. This also satisfies
      // zcashChunkConfirmations (regtest default policy exceeds it) for every
      // chunk, including a following one that would otherwise spend this
      // chunk's unconfirmed change.
      await regtest.mineBlocks(10);
      await regtest.syncToTip(treasuryDir);
    } else if (i < chunks.length - 1) {
      // Real network, and there IS a next chunk: never let it spend this
      // chunk's unconfirmed change (see file header).
      // config.epoch.zcashChunkConfirmations is the policy (mainnet default:
      // 1 block); enforcing it needs a real lightwalletd/zebrad RPC path,
      // which this build never wires for test/main mode (same "written but
      // never run" boundary as the rest of non-local mode -- see
      // engine/README.md). Failing loudly here is deliberate: silently
      // skipping the wait would risk exactly the unconfirmed-change bug this
      // exists to prevent.
      throw new Error(
        `zcashChunkConfirmations enforcement is not wired for PAD_MODE=${config.mode}: ` +
          "only regtest (local mode) has a working confirmation check, and this payout needs more than one chunk.",
      );
    }

    await hooks.onSent(wallets, txid);
    txids.push(txid);
    for (const t of batch) perWallet.set(t.wallet, txid);
  }
  return { txids, perWallet, feeZats };
}
