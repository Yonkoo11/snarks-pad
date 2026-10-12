// Public treasury view (GET /treasury, docs/API.md. Never returns a
// per-recipient shielded amount, only aggregate treasury vs owed.
import { config } from "./config";
import * as db from "./db";
import { faucetStatusForView, type FaucetStatus } from "./faucet";
import { payoutsPaused } from "./pause";

/** Meta key under which the keeper loop records when the next epoch is due (src/scheduler.ts), for the API to read. */
export const NEXT_EPOCH_AT_META = "scheduler_next_epoch_at";
/** Meta key under which a due run that found nothing to claim records itself (src/scheduler.ts): no epoch row, the cycle still ended. The Payouts page says so (2026-10-12). */
export const SCHEDULER_NOOP_META = "scheduler_noop_at";

export interface TreasuryView {
  treasuryZats: string;
  owedZats: string;
  covered: boolean;
  /** Solana ZEC claimed for coins that had no eligible holder, held in the keeper account for their next distribution (audit S6, lens 2-4). */
  orphanedZats: string;
  /** The same per coin (audit S6, product decision 1): held since `sinceAt`; joins the first paying round after `releaseAt` unless the coin's own holders take it first. */
  orphaned: { mint: string; amountZats: string; sinceAt: string | null; releaseAt: string | null }[];
  lastEpochAt: string | null;
  nextEpochAt: string | null;
  /** The keeper's last due run, paying or not; `lastRunFoundNothing` when that run wrote no epoch because nothing was claimable (larpcheck 2026-10-12 read a quiet keeper as a broken cadence). */
  lastRunAt: string | null;
  lastRunFoundNothing: boolean;
  /** How often rounds run and how often the shielded share goes out, as configured (config.scheduler). */
  cadence: { roundEveryMs: number; shieldedEveryMs: number };
  zcashNetwork: typeof config.zcash.network;
  // The kill switch is on (PAYOUTS_PAUSED=1 or the pause file): the keeper is not claiming or paying. Nothing is lost by a pause.
  paused: boolean;
  // Epochs that stayed unfinished too long and are parked (audit O-2): their payouts are still owed and still counted above.
  epochsNeedingAttention: number;
  // The devnet test-money faucet: whether its key can pay another fill and how many it can still pay (from its balance, src/faucet.ts).
  // null where the route does not exist (local, mainnet).
  faucet: FaucetStatus | null;
  // The published fee policy and the team's running ledger. Aggregates only.
  policy: { holdersShareOfClaimedBps: number; teamShareOfClaimedBps: number; meteoraShareOfFeeBps: number };
  team: {
    wallet: string | null; // where the team's Solana ZEC is swept to; null = it stays in the keeper
    grossZats: string; // the team's share of everything claimed
    deliveryCostZats: string; // what delivering opted-in holders' rewards shielded cost, paid from the team share
    nativeZats: string; // native ZEC left in the treasury wallet after delivery: the team's
    heldInKeeperZats: string; // team Solana ZEC not yet sent to a team wallet
    sweptZats: string; // team Solana ZEC sent to the team wallet
  };
}

async function readTreasuryBalanceZats(): Promise<bigint> {
  const { getBalanceAsync } = await import("./zcash/devtool");
  if (config.isLocal) {
    const { TREASURY_DIR } = await import("./zcash/regtest");
    return (await getBalanceAsync(TREASURY_DIR)).spendableZats;
  }
  // Devnet/mainnet: the treasury wallet the keeper pays from, read from its local database (the keeper syncs it;
  // this makes no network call and needs no key). Without TREASURY_WALLET_DIR, 0 is honest, not a made-up number.
  const dir = config.near1click.treasuryWalletDir;
  if (!dir) return 0n;
  try {
    return (await getBalanceAsync(dir)).spendableZats;
  } catch (err) {
    console.error(`treasury balance unreadable, reporting 0: ${(err as Error).message}`);
    return 0n;
  }
}

// Stress API load (audit/STRESS-REPORT.md D6): GET /treasury is public, and reading the balance starts a devtool
// process on the treasury wallet. At most one read runs at a time, and a value younger than TREASURY_VIEW_MAX_AGE_MS
// is served from memory; the page is informational, the keeper's own checks never use this number.
const TREASURY_VIEW_MAX_AGE_MS = Number(process.env.PAD_TREASURY_VIEW_MAX_AGE_MS ?? 30_000);
let treasuryCache: { atMs: number; zats: bigint } | null = null;
let treasuryRead: Promise<bigint> | null = null;

async function treasuryBalanceForView(): Promise<bigint> {
  if (treasuryCache && Date.now() - treasuryCache.atMs < TREASURY_VIEW_MAX_AGE_MS) return treasuryCache.zats;
  treasuryRead ??= readTreasuryBalanceZats()
    .then((zats) => {
      treasuryCache = { atMs: Date.now(), zats };
      return zats;
    })
    .finally(() => {
      treasuryRead = null;
    });
  return treasuryRead;
}

/**
 * The keeper's last due run for the Payouts page: the newest of the last paying round and the last due run that found nothing to claim
 * (SCHEDULER_NOOP_META). A no-op newer than the last round is a run that found nothing; a no-op older than it, or none, is not reported.
 */
export function lastRunOf(lastEpochAt: string | null, noopAt: string | null): { lastRunAt: string | null; lastRunFoundNothing: boolean } {
  const noopMs = noopAt === null ? NaN : Date.parse(noopAt);
  const noopIsLatest = Number.isFinite(noopMs) && (lastEpochAt === null || noopMs > Date.parse(lastEpochAt));
  return { lastRunAt: noopIsLatest ? noopAt : lastEpochAt, lastRunFoundNothing: noopIsLatest };
}

export async function getTreasuryView(): Promise<TreasuryView> {
  const owedZats = db.sumUnsentShielded() + db.sumCarry("shielded");
  const [treasuryZats, faucet] = await Promise.all([treasuryBalanceForView(), faucetStatusForView()]);
  const epochs = db.listEpochs();
  const team = db.teamTotals();
  const lastEpochAt = epochs[0]?.at ?? null;
  const run = lastRunOf(lastEpochAt, db.getMeta(SCHEDULER_NOOP_META));
  return {
    treasuryZats: treasuryZats.toString(),
    owedZats: owedZats.toString(),
    covered: treasuryZats >= owedZats,
    orphanedZats: db.sumOrphanedZats().toString(),
    orphaned: db.listOrphanedCoinProceeds().map((o) => ({
      mint: o.mint, amountZats: o.amountZats, sinceAt: o.sinceAt,
      releaseAt: o.sinceAt === null ? null : new Date(Date.parse(o.sinceAt) + config.epoch.orphanReleaseDays * 86_400_000).toISOString(),
    })),
    lastEpochAt,
    nextEpochAt: db.getMeta(NEXT_EPOCH_AT_META), // written by the keeper loop (`bun run keeper`); null when none is running
    lastRunAt: run.lastRunAt,
    lastRunFoundNothing: run.lastRunFoundNothing,
    cadence: { roundEveryMs: config.scheduler.epochEveryMs, shieldedEveryMs: config.scheduler.shieldedEveryMs },
    zcashNetwork: config.zcash.network,
    paused: payoutsPaused().paused,
    epochsNeedingAttention: db.listParkedEpochs().length,
    faucet,
    policy: {
      holdersShareOfClaimedBps: 10_000 - config.epoch.team.shareBps,
      teamShareOfClaimedBps: config.epoch.team.shareBps,
      meteoraShareOfFeeBps: 10_000 - config.solana.dbc.holderShareBps,
    },
    team: {
      wallet: config.epoch.team.wallet,
      grossZats: team.grossZats.toString(),
      deliveryCostZats: team.deliveryCostZats.toString(),
      nativeZats: team.nativeZats.toString(),
      heldInKeeperZats: team.heldInKeeperZats.toString(),
      sweptZats: team.sweptZats.toString(),
    },
  };
}
