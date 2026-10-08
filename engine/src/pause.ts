// The kill switch (plan section 4 "Risks and kill switch"). Payouts are paused when PAYOUTS_PAUSED=1 is set in
// the environment OR the pause file exists (config.paths.pauseFile; `touch engine/data/PAUSED`, no restart
// needed). While paused, nothing claims, swaps or sends: every point that is about to move money checks
// this first (src/epoch/engine.ts assertLockHeld). Unclaimed fees stay in the pools, and anything half done
// resumes where it stopped once the switch is off (a pause never loses money).
//
// The keeper also uses `requestStop()` for a graceful shutdown: SIGINT/SIGTERM set it, the epoch in flight
// stops at its next safe point (before the next claim, swap or batch), and the next run resumes it.
//
// No secret is read here and nothing is signed: the HTTP API imports this file to report `paused`.
import { existsSync } from "node:fs";
import { config } from "./config";

export type PauseReason = "env" | "file" | "stop_requested";

let stopRequested = false;

/** Asks the epoch in flight to stop at its next safe point (graceful shutdown). */
export function requestStop(): void {
  stopRequested = true;
}

export function clearStopRequest(): void {
  stopRequested = false;
}

/** Whether the operator's kill switch is on (env or file). The HTTP API reports this one. */
export function payoutsPaused(): { paused: boolean; reason: "env" | "file" | null } {
  // Fails safe (audit S3-02): any value but unset, "", "0", "false", "no" or "off" pauses, so PAYOUTS_PAUSED=true is not ignored.
  const env = (process.env.PAYOUTS_PAUSED ?? "").trim().toLowerCase();
  if (env !== "" && !["0", "false", "no", "off"].includes(env)) return { paused: true, reason: "env" };
  if (existsSync(config.paths.pauseFile)) return { paused: true, reason: "file" };
  return { paused: false, reason: null };
}

/** Why the keeper must not move money right now, or null. */
export function haltReason(): PauseReason | null {
  const p = payoutsPaused();
  if (p.paused) return p.reason;
  return stopRequested ? "stop_requested" : null;
}

/** Thrown at a safe point when payouts are paused or a stop was requested: nothing is half done, the next run resumes. */
export class PayoutsPaused extends Error {
  constructor(readonly reason: PauseReason) {
    super(reason === "stop_requested" ? "stop requested: the epoch stops at a safe point and resumes on the next run" : `payouts are paused (${reason === "env" ? "PAYOUTS_PAUSED=1" : `pause file ${config.paths.pauseFile}`}): nothing was claimed or sent`);
    this.name = "PayoutsPaused";
  }
}

/** Throws PayoutsPaused if the kill switch is on or a stop was requested. */
export function assertNotPaused(): void {
  const reason = haltReason();
  if (reason) throw new PayoutsPaused(reason);
}
