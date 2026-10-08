// How the keeper's recorded epochs are read for the public views: which rail a payout row really moved money on, an epoch's split and
// snapshot summary, and what each coin's holders were paid (GET /api/epochs, /api/coins `rewards`, /api/coins/:mint/pot `lastPayout`,
// /api/rewards, /api/epochs.csv). Read-only: it only reads rows the keeper already wrote, and imports nothing from the keeper side.
import * as db from "../db";

/**
 * Classifies a payout row by which RAIL actually moved the money, which is
 * not always the same as its `kind` (finding 10): a "shielded"-kind row that
 * fell back to Solana ZEC (sig prefixed "fallback_solana:") really did move
 * over the Solana rail, and belongs in solanaPayouts, not the shielded
 * total/count. A row with no real signature yet ("carried:...",
 * "zero_after_fee") moved no money at all this epoch, on either rail.
 */
export function payoutRail(p: db.PayoutRow): "solana" | "shielded" | "none" {
  if (!p.sentAt || !p.sig) return "none";
  if (p.sig.startsWith("carried:") || p.sig === "zero_after_fee") return "none"; // never real money, regardless of kind
  if (p.kind === "solana") return "solana";
  if (p.sig.startsWith("fallback_solana:")) return "solana";
  if (/^[0-9a-f]{64}$/.test(p.sig)) return "shielded";
  return "none";
}

/** The real signature/txid for a row, with any "fallback_solana:" bookkeeping prefix stripped. */
export function railSig(p: db.PayoutRow): string {
  return p.sig!.startsWith("fallback_solana:") ? p.sig!.slice("fallback_solana:".length) : p.sig!;
}

export interface CoinRewards {
  paidSolanaZec: string;
  paidShieldedZec: string;
  epochs: number;
}

/** Each of an epoch's coins' summed holder shares (the weights the payouts are split by); empty when none were recorded. */
function coinShareWeights(epochId: string, mints: string[]): Map<string, bigint> {
  const w = new Map<string, bigint>();
  for (const r of db.listEpochCoinShares(epochId)) {
    if (mints.includes(r.mint)) w.set(r.mint, (w.get(r.mint) ?? 0n) + BigInt(r.amountZats));
  }
  return w;
}

/**
 * What one epoch paid each of its coins' holders on each rail. Payouts are one row per wallet per epoch (combined across the coins
 * that wallet holds), so an epoch with several coins splits every rail's total between them in proportion to each coin's holder
 * shares for that epoch (epoch_coin_shares). An epoch with one coin, or with no recorded shares, attributes the whole epoch to its
 * coins unchanged. Rounding is floor, so the parts never add up to more than was paid.
 */
export function epochPayoutsByCoin(e: db.EpochRow): Map<string, { solana: bigint; shielded: bigint }> {
  const mints = JSON.parse(e.coinMints) as string[];
  let solana = 0n;
  let shielded = 0n;
  for (const p of db.getPayouts(e.id)) {
    const rail = payoutRail(p);
    if (rail === "solana") solana += BigInt(p.amountZats);
    else if (rail === "shielded") shielded += BigInt(p.amountZats);
  }
  const weights = coinShareWeights(e.id, mints);
  const total = [...weights.values()].reduce((a, w) => a + w, 0n);
  const out = new Map<string, { solana: bigint; shielded: bigint }>();
  for (const mint of mints) {
    const w = weights.get(mint) ?? 0n;
    const [num, den] = mints.length === 1 || total === 0n ? [1n, 1n] : [w, total];
    out.set(mint, { solana: (solana * num) / den, shielded: (shielded * num) / den });
  }
  return out;
}

/** What each coin's holders were actually paid, per coin, over every published epoch. */
export function computeAllCoinRewards(): Map<string, CoinRewards> {
  const out = new Map<string, { solana: bigint; shielded: bigint; epochs: number }>();
  for (const e of db.listEpochs()) {
    for (const [mint, paid] of epochPayoutsByCoin(e)) {
      const s = out.get(mint) ?? out.set(mint, { solana: 0n, shielded: 0n, epochs: 0 }).get(mint)!;
      s.solana += paid.solana;
      s.shielded += paid.shielded;
      s.epochs += 1;
    }
  }
  return new Map([...out].map(([m, v]) => [m, { paidSolanaZec: v.solana.toString(), paidShieldedZec: v.shielded.toString(), epochs: v.epochs }]));
}

export interface LastPayout {
  epochId: string;
  at: string;
  /** What that epoch paid this coin's holders in all, on both rails. */
  totalZats: string;
  /** Of it, what went the shielded way. */
  shieldedZats: string;
}

/**
 * The newest published epoch that moved money to each coin's holders (an epoch whose payouts for the coin were all carried or are
 * still unsent does not count: nothing was paid yet), keyed by mint. Same per-coin attribution as `rewards`.
 */
export function computeAllLastPayouts(): Map<string, LastPayout> {
  const out = new Map<string, LastPayout>();
  for (const e of db.listEpochs()) {
    for (const [mint, paid] of epochPayoutsByCoin(e)) {
      if (out.has(mint) || paid.solana + paid.shielded === 0n) continue;
      out.set(mint, { epochId: e.id, at: e.at, totalZats: (paid.solana + paid.shielded).toString(), shieldedZats: paid.shielded.toString() });
    }
  }
  return out;
}

/** Everything a coin's holders were paid, per coin: the sums of `computeAllCoinRewards` for one mint. */
export function computeCoinRewards(mint: string): CoinRewards {
  return computeAllCoinRewards().get(mint) ?? { paidSolanaZec: "0", paidShieldedZec: "0", epochs: 0 };
}

/** The published snapshot of an epoch: its sha256, and the Solana memo that carries the same hash once the keeper has written it. */
export function snapshotSummary(epochId: string) {
  const snap = db.getEpochSnapshot(epochId);
  if (!snap) return null;
  return { sha256: snap.sha256, memoSig: snap.memoAt ? snap.memoSig : null, url: `/api/epochs/${epochId}/snapshot` };
}

/**
 * Where an epoch's claimed fee went (owner policy 2026-10-02): holders, the team, and what delivering shielded
 * rewards cost the team. `deliveryCostZats` and `teamNetZats` are null until the epoch's swap is resolved.
 */
export function epochSplit(e: db.EpochRow) {
  const teamZats = BigInt(e.teamGrossZats ?? "0");
  const resolved = e.teamSolanaZats != null;
  const cost = resolved ? BigInt(e.deliveryCostZats ?? "0") : null;
  return {
    holdersZats: (BigInt(e.harvestedZats) - teamZats).toString(),
    teamZats: teamZats.toString(),
    deliveryCostZats: cost === null ? null : (cost > 0n ? cost : 0n).toString(),
    teamNetZats: resolved ? (BigInt(e.teamSolanaZats!) + BigInt(e.teamNativeZats ?? "0")).toString() : null,
    holderShortfallZats: (e.holderShortfallZats ?? "0"),
  };
}

/** One rail's count, total and transaction ids of an epoch (the shapes of GET /api/epochs `solanaPayouts` and `shielded`). */
export function summarizePayouts(epochId: string, rail: "solana" | "shielded") {
  const rows = db.getPayouts(epochId).filter((p) => payoutRail(p) === rail);
  const totalZats = rows.reduce((acc, r) => acc + BigInt(r.amountZats), 0n).toString();
  const sigs = rail === "solana" ? [...new Set(rows.map(railSig))] : undefined;
  const zcashTxids = rail === "shielded" ? [...new Set(rows.map(railSig))] : undefined;
  return { count: rows.length, totalZats, ...(sigs ? { sigs } : {}), ...(zcashTxids ? { zcashTxids } : {}) };
}

/**
 * What holders were paid so far on each rail, over every published epoch. It sums the rows GET /epochs sums, with the same
 * classification (payoutRail), so the two always agree; it holds totals only, never a recipient.
 */
export function totalPaidToHolders(): { paidSolanaZats: string; paidShieldedZats: string } {
  let solana = 0n;
  let shielded = 0n;
  for (const e of db.listEpochs()) {
    for (const p of db.getPayouts(e.id)) {
      const rail = payoutRail(p);
      if (rail === "solana") solana += BigInt(p.amountZats);
      else if (rail === "shielded") shielded += BigInt(p.amountZats);
    }
  }
  return { paidSolanaZats: solana.toString(), paidShieldedZats: shielded.toString() };
}
