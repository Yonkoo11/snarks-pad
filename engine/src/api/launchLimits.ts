// What a client address may ask of POST /api/coins/launch-tx docs/API.md v2.8.2, S4-05). The route is public and a call that gets as far as a
// transaction leaves a coin row and a metadata file behind whether or not anyone signs, so it is paid for twice: 10 calls per client address per minute
// (the same sliding window as uploads), and a cap on launches that are prepared and not yet confirmed, 20 per address and 2,000 in all. An unconfirmed
// launch is dropped by the sweep after an hour (src/publicFiles/sweep.ts).
// Audit S6, product decision 4: a prepared launch counts toward those caps only while its transaction can still land (PENDING_COUNTS_FOR_MS; a Solana
// blockhash is good for about a minute), so a flood of unsigned builds cannot hold the caps for the hour the rows live; and the pad as a whole builds at
// most PAD_BUILDS_PER_MINUTE a minute (each build is chain reads and a simulation on the API's RPC key), with one alert per episode when it refuses.
// The per-address count lives in memory, like the window: a restart forgets it, the database count and the sweep are what bound the rows. A launch is
// counted from the moment its transaction starts to be built, so a burst of calls at the edge of a cap cannot all pass the check before any of them counts.
import * as db from "../db";
import { makeFloodAlert } from "./floodAlert";
import { makeWindowLimiter } from "./windowLimiter";

export const LAUNCHES_PER_MINUTE = 10;
export const MAX_PENDING_PER_IP = 20;
export const MAX_PENDING_TOTAL = 2_000;
export const PAD_BUILDS_PER_MINUTE = 100;
/** How long a prepared, unsigned launch counts toward the caps: after this its blockhash has expired and nobody can land it. */
export const PENDING_COUNTS_FOR_MS = 3 * 60_000;
/**
 * What a client refused by a cap is told to wait, in seconds. The caps open as launches are confirmed and as prepared ones pass PENDING_COUNTS_FOR_MS,
 * so this is a place to retry from, not a promise.
 */
export const CAP_RETRY_AFTER_S = 600;
const PRUNE_ABOVE_ADDRESSES = 5_000;

export const launchLimiter = makeWindowLimiter(LAUNCHES_PER_MINUTE, 60_000);
let padNow = Date.now();
const padLimiter = makeWindowLimiter(PAD_BUILDS_PER_MINUTE, 60_000, () => padNow); // on the clock reserveLaunch is given, so a test can move it
const padAlert = makeFloodAlert("launch_cap");

/** A launch of one address that may still be waiting for its confirm; `mint` is null while its transaction is being built. */
interface Held {
  mint: string | null;
  /** When the build started: a prepared launch stops counting PENDING_COUNTS_FOR_MS after it. */
  at: number;
}
const held = new Map<string, Held[]>();
let building = 0;

/** The launches of `ip` that still count: being built, or prepared within PENDING_COUNTS_FOR_MS and still unconfirmed in the database. */
function liveHeld(ip: string, now: number): Held[] {
  const live = (held.get(ip) ?? []).filter((h) => h.mint === null || (now - h.at < PENDING_COUNTS_FOR_MS && db.getCoin(h.mint)?.status === "pending"));
  if (live.length > 0) held.set(ip, live);
  else held.delete(ip);
  return live;
}

export interface LaunchSlot {
  /** The transaction was built and the launch recorded under `mint`: it counts until it is confirmed, dropped or too old to land. */
  built(mint: string): void;
  /** No launch came of it (the build failed or ran out of time): nothing is held. */
  abandon(): void;
}

export type Reservation = { ok: true; slot: LaunchSlot } | { ok: false; status: 429 | 503; error: "rate_limited" | "busy"; retryAfter: number };

/** A place for one more unconfirmed launch from `ip`, or what to answer instead: 429 for this address being at its cap, 503 for the pad being at its. */
export function reserveLaunch(ip: string, now: number = Date.now()): Reservation {
  if (held.size > PRUNE_ABOVE_ADDRESSES) for (const known of [...held.keys()]) liveHeld(known, now);
  const mine = liveHeld(ip, now);
  if (mine.length >= MAX_PENDING_PER_IP) return { ok: false, status: 429, error: "rate_limited", retryAfter: CAP_RETRY_AFTER_S };
  padAlert.settle(now);
  if (db.countPendingCoinsSince(new Date(now - PENDING_COUNTS_FOR_MS).toISOString()) + building >= MAX_PENDING_TOTAL) {
    padAlert.refused(now, `the pad holds ${MAX_PENDING_TOTAL} launches prepared in the last ${PENDING_COUNTS_FOR_MS / 60_000} minutes and still unsigned; new launches answer 503`);
    return { ok: false, status: 503, error: "busy", retryAfter: CAP_RETRY_AFTER_S };
  }
  padNow = now;
  const wait = padLimiter.take("pad");
  if (wait !== null) {
    padAlert.refused(now, `the pad built ${PAD_BUILDS_PER_MINUTE} launch transactions in a minute; new launches answer 503 for ${wait} s`);
    return { ok: false, status: 503, error: "busy", retryAfter: wait };
  }
  const entry: Held = { mint: null, at: now };
  held.set(ip, [...mine, entry]);
  building += 1;
  let open = true;
  const settle = (): void => {
    if (open) building -= 1;
    open = false;
  };
  return {
    ok: true,
    slot: {
      built(mint) {
        entry.mint = mint;
        settle();
      },
      abandon() {
        settle();
        const rest = (held.get(ip) ?? []).filter((h) => h !== entry);
        if (rest.length > 0) held.set(ip, rest);
        else held.delete(ip);
      },
    },
  };
}

/** For tests: forget every count. */
export function clearLaunchLimits(): void {
  launchLimiter.clear();
  padLimiter.clear();
  padAlert.reset();
  held.clear();
  building = 0;
}
