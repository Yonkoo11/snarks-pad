// The DB side of the devnet soak's reconciliation (stress/devnet-soak.ts): which money the keeper's rows say moved
// since the soak's start snapshot. Kept apart from the script so it can be tested without a chain.
//
// Money is counted by ROW, not by epoch. Server soak attempt 1 (2026-10-03) counted only the claims of epochs created
// after the start and still present, and reported "keeper ZEC moved 29862844; DB: claimed 0". Chain history of the
// keeper's ZEC account showed 5 transactions, each a confirmed claim row: 3 of a draft epoch created before the start
// whose Squads proposals the soak approved 40 s after it, and 2 of a soak epoch discarded as a draft (no eligible
// holder; the claim is kept as orphaned proceeds and the epoch row deleted). Nothing moved unrecorded; the harness
// looked in the wrong place. So: the start waits until nothing is in flight (quiet), records the keys of every
// confirmed claim, sent payout and swap, and everything not in those sets is this soak's.
import type { Database } from "bun:sqlite";

export type LedgerBefore = { claimsBefore: string[]; payoutsBefore: string[]; swapsBefore: string[] };
export type Ledger = { claimed: bigint; sent: { epochId: string; wallet: string; kind: string; amountZats: string; sig: string }[]; unsent: number; swapped: bigint };

const claimKey = (r: { epochId: string; mint: string; kind: string }) => `${r.epochId}|${r.mint}|${r.kind}`;
const payoutKey = (r: { epochId: string; wallet: string; kind: string }) => `${r.epochId}|${r.wallet}|${r.kind}`;

/** Nothing in flight: no claim signed but unconfirmed, no payout row unsent, no epoch unfinished. Snapshot only then. */
export function isQuiet(d: Database): boolean {
  const n = (sql: string) => (d.query(sql).get() as { n: number }).n;
  return n("SELECT count(*) n FROM claim_progress WHERE status != 'confirmed'") === 0
    && n("SELECT count(*) n FROM payouts WHERE sentAt IS NULL") === 0
    && n("SELECT count(*) n FROM epochs WHERE status NOT IN ('ok','fallback_solana','needs_attention')") === 0;
}

export function snapshotLedger(d: Database): LedgerBefore {
  return {
    claimsBefore: (d.query("SELECT epochId, mint, kind FROM claim_progress WHERE status = 'confirmed'").all() as { epochId: string; mint: string; kind: string }[]).map(claimKey),
    payoutsBefore: (d.query("SELECT epochId, wallet, kind FROM payouts WHERE sentAt IS NOT NULL").all() as { epochId: string; wallet: string; kind: string }[]).map(payoutKey),
    swapsBefore: (d.query("SELECT ref FROM swap_progress").all() as { ref: string }[]).map((r) => r.ref),
  };
}

export function ledgerSince(d: Database, s: LedgerBefore): Ledger {
  const cb = new Set(s.claimsBefore), pb = new Set(s.payoutsBefore), sb = new Set(s.swapsBefore);
  const claimed = (d.query("SELECT epochId, mint, kind, amountZats FROM claim_progress WHERE status = 'confirmed' AND amountZats IS NOT NULL").all() as { epochId: string; mint: string; kind: string; amountZats: string }[])
    .filter((r) => !cb.has(claimKey(r))).reduce((a, r) => a + BigInt(r.amountZats), 0n);
  const sent = (d.query("SELECT epochId, wallet, kind, amountZats, sig FROM payouts WHERE sentAt IS NOT NULL").all() as Ledger["sent"]).filter((p) => !pb.has(payoutKey(p)));
  const unsent = (d.query("SELECT count(*) n FROM payouts WHERE sentAt IS NULL").get() as { n: number }).n;
  const swapped = (d.query("SELECT ref, amountInZats FROM swap_progress").all() as { ref: string; amountInZats: string }[])
    .filter((r) => !sb.has(r.ref)).reduce((a, r) => a + BigInt(r.amountInZats), 0n);
  return { claimed, sent, unsent, swapped };
}
