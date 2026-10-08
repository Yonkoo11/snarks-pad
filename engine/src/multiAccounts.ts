// Bulk account reads (getMultipleAccounts) in chunks the provider accepts. The public limit is 100 keys a call; a provider may allow fewer and
// answer HTTP 413 with code -32615 "getMultipleAccounts is limited to N" (QuickNode devnet, 2026-10-07: the test site's payout round parked on
// it while reading recipients' token accounts 100 at a time). The reader starts at PAD_RPC_MULTI_ACCOUNT_MAX (default 100), takes the number the
// provider names when it names one and halves otherwise, retries the same chunk, and keeps the smaller size for the rest of the process. Any
// other failure is thrown as it came.
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { getConnection } from "./solana";

export type BulkRead = (keys: PublicKey[]) => Promise<(AccountInfo<Buffer> | null)[]>;
const defaultRead: BulkRead = (keys) => getConnection().getMultipleAccountsInfo(keys, "confirmed");
// QuickNode's wording on its trial plan (devnet, 2026-10-07): "getMultipleAccounts is limited to a 5 range, upgrade from discover plan"
const LIMIT_TEXT = /getMultipleAccounts is limited to (?:a )?(\d+)/i;
let learned: number | null = null;

/** The limit a "too many keys" answer names, 0 when it names none, null when the error is something else. */
export function tooManyKeys(err: unknown): number | null {
  const m = String((err as Error)?.message ?? err);
  if (!/chain unavailable \(http_error\)/.test(m) || !(/HTTP 413\b/.test(m) || /-32615\b/.test(m) || LIMIT_TEXT.test(m))) return null;
  const named = LIMIT_TEXT.exec(m);
  return named ? Number(named[1]) : 0;
}

/** For tests: the next read starts from the configured size again. */
export function forgetLearnedLimit(): void {
  learned = null;
}

/** The accounts behind `keys`, in order, read as many at a time as the provider allows. */
export async function readAccountsInfo(keys: PublicKey[], read: BulkRead = defaultRead, maxPerCall: number = config.rpc.multiAccountMax): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  let size = Math.max(1, Math.min(maxPerCall, learned ?? maxPerCall));
  let i = 0;
  while (i < keys.length) {
    const batch = keys.slice(i, i + size);
    try {
      const answer = await read(batch);
      // One account per key, in order, or the caller would pair keys with the wrong accounts (audit S6, lens 4-5).
      if (answer.length !== batch.length) throw new Error(`getMultipleAccounts answered ${answer.length} accounts for ${batch.length} keys`);
      out.push(...answer);
      i += batch.length;
    } catch (err) {
      const limit = tooManyKeys(err);
      if (limit === null || batch.length <= 1) throw err;
      // the refused call held batch.length keys (the cap, or what was left): halve that, not the cap
      const next = limit > 0 && limit < batch.length ? limit : Math.floor(batch.length / 2);
      if (next < 1) throw err;
      console.error(`[rpc] getMultipleAccounts refused ${batch.length} keys; reading ${next} at a time from now on (${String((err as Error)?.message ?? err).slice(0, 160)})`);
      size = next;
      learned = next;
    }
  }
  return out;
}
