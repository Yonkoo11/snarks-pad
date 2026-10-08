// GET /api/epochs.csv docs/API.md v2.6: one row per published round, public numbers only: no wallet, no address, no per-recipient
// amount. The same totals GET /api/epochs reports, through the same helpers, so the two cannot disagree.
import type { EpochRow } from "./db";
import { epochSplit, snapshotSummary, summarizePayouts } from "./epoch/publicView";

export const EPOCH_CSV_COLUMNS = [
  "epochId", "at", "status", "coinMints", "claimedZats", "holdersZats", "teamZats", "deliveryCostZats", "teamNetZats", "holderShortfallZats",
  "zcashNetworkFeeZats", "solanaPayoutCount", "solanaPayoutZats", "shieldedCount", "shieldedZats", "snapshotSha256", "snapshotMemoSig",
] as const;

/**
 * One cell. Text that a spreadsheet would read as a formula (it starts with = + - @, a tab or a carriage return) gets a leading
 * quote mark, then anything holding a comma, a quote or a line break is quoted with its quotes doubled.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?[0-9]+$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function epochRow(e: EpochRow): (string | number | null)[] {
  const split = epochSplit(e);
  const solana = summarizePayouts(e.id, "solana");
  const shielded = summarizePayouts(e.id, "shielded");
  const snapshot = snapshotSummary(e.id);
  return [
    e.id, e.at, e.status, (JSON.parse(e.coinMints) as string[]).join(";"), e.harvestedZats, split.holdersZats, split.teamZats, split.deliveryCostZats,
    split.teamNetZats, split.holderShortfallZats, e.feeZats, solana.count, solana.totalZats, shielded.count, shielded.totalZats,
    snapshot?.sha256 ?? null, snapshot?.memoSig ?? null,
  ];
}

/** The CSV of `epochs` (already newest first), header line first, every line ending in a line feed. */
export function epochsCsv(epochs: EpochRow[]): string {
  const lines = [EPOCH_CSV_COLUMNS.join(","), ...epochs.map((e) => epochRow(e).map(csvCell).join(","))];
  return `${lines.join("\n")}\n`;
}
