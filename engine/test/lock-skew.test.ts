// Stress chaos round 21 (audit/STRESS-REPORT.md D10): a keeper whose clock ran 2 h fast was killed holding the epoch
// lock. The lock row said it was taken 2 h in the future, so every correctly-clocked run saw it as fresh and waited
// for the skew plus the stale time (here 2 h 1.5 min) before any epoch could run. A lock dated in the future by more
// than the stale time is now treated as stale. Safe: a holder that is in fact alive is stopped by the fence (it no
// longer holds the lock at its next money step, audit S2-02).
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";

describe("an epoch lock written by a keeper whose clock was wrong", () => {
  test("a lock dated 2 h in the future does not block a correctly-clocked run", () => {
    db.releaseLock("skew-test", "x");
    db.getDb().query("INSERT OR REPLACE INTO locks (name, holder, acquiredAt) VALUES ('skew-test', 'fast-clock', ?)").run(new Date(Date.now() + 2 * 3_600_000).toISOString());
    expect(db.tryAcquireLock("skew-test", "me", 90_000)).toBe(true);
    expect(db.refreshLock("skew-test", "fast-clock")).toBe(false); // the old holder is fenced out
  });
  test("a lock a few seconds in the future (ordinary clock jitter) is still fresh", () => {
    db.getDb().query("INSERT OR REPLACE INTO locks (name, holder, acquiredAt) VALUES ('skew-test', 'other', ?)").run(new Date(Date.now() + 5_000).toISOString());
    expect(db.tryAcquireLock("skew-test", "me", 90_000)).toBe(false);
  });
});
