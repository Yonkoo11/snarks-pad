// One alert per flood episode (audit S6, product decisions 4 and 5): a pad-wide cap that refuses records an alert the keeper's health
// check forwards (the alerts table), keeps it open while refusals go on, and resolves it once the cap has been quiet for `quietMs`,
// so a flood is one message when it starts and one line when it ends, not a message per refused call and not a flap per minute.
import * as db from "../db";

export const FLOOD_ALERT_QUIET_MS = 10 * 60_000;

export interface FloodAlert {
  /** A cap refused a call now. */
  refused(nowMs: number, detail: string): void;
  /** Called on any pass: resolves the alert once the last refusal is older than the quiet time. */
  settle(nowMs: number): void;
  /** For tests: forget the episode and resolve the alert. */
  reset(): void;
}

export function makeFloodAlert(kind: string, quietMs: number = FLOOD_ALERT_QUIET_MS): FloodAlert {
  let lastRefusedAt: number | null = null;
  return {
    refused(nowMs, detail) {
      lastRefusedAt = nowMs;
      if (db.recordAlert(kind, "", detail)) console.error(`ALERT ${detail}`);
    },
    settle(nowMs) {
      if (lastRefusedAt === null || nowMs - lastRefusedAt <= quietMs) return;
      lastRefusedAt = null;
      db.resolveAlerts(kind, "");
    },
    reset() {
      lastRefusedAt = null;
      db.resolveAlerts(kind, "");
    },
  };
}
