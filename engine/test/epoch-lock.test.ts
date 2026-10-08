// Fixes verified defect (review finding 5): no lock existed between epoch
// runs, so a second concurrent `bun run epoch` (or a resumed run racing a
// fresh one) could harvest+sell the same coin twice and measure proceeds off
// the same shared quote-asset account. src/db.ts's tryAcquireLock/releaseLock
// back src/epoch/engine.ts's runEpoch.
import { describe, expect, test } from "bun:test";
import * as db from "../src/db";

function lockName(): string {
  return `epoch-test-${crypto.randomUUID()}`;
}

describe("DB-backed exclusive lock (finding 5)", () => {
  test("a free lock can be acquired", () => {
    const name = lockName();
    expect(db.tryAcquireLock(name, "holder-a", 60_000)).toBe(true);
  });

  test("a fresh lock held by someone else cannot be acquired -- this is what stops a second concurrent epoch run", () => {
    const name = lockName();
    expect(db.tryAcquireLock(name, "holder-a", 60_000)).toBe(true);
    expect(db.tryAcquireLock(name, "holder-b", 60_000)).toBe(false);
  });

  test("the same holder re-acquiring its own lock succeeds (idempotent within one process)", () => {
    const name = lockName();
    expect(db.tryAcquireLock(name, "holder-a", 60_000)).toBe(true);
    expect(db.tryAcquireLock(name, "holder-a", 60_000)).toBe(true);
  });

  test("releasing the lock lets someone else acquire it", () => {
    const name = lockName();
    db.tryAcquireLock(name, "holder-a", 60_000);
    db.releaseLock(name, "holder-a");
    expect(db.tryAcquireLock(name, "holder-b", 60_000)).toBe(true);
  });

  test("release only works for the holder that actually holds it (a crashed run's stale release call can't steal a live lock)", () => {
    const name = lockName();
    db.tryAcquireLock(name, "holder-a", 60_000);
    db.releaseLock(name, "holder-b"); // holder-b never held it; must be a no-op
    expect(db.tryAcquireLock(name, "holder-b", 60_000)).toBe(false); // still held by holder-a
  });

  test("a stale lock (older than staleMs) can be taken over -- this is what recovers from a crashed epoch run", async () => {
    const name = lockName();
    expect(db.tryAcquireLock(name, "holder-a-crashed", 20)).toBe(true);
    expect(db.tryAcquireLock(name, "holder-b", 20)).toBe(false); // still fresh

    await Bun.sleep(40); // older than the 20ms staleMs now

    expect(db.tryAcquireLock(name, "holder-b", 20)).toBe(true);
    // holder-a-crashed's original hold is gone; holder-b now owns it.
    expect(db.tryAcquireLock(name, "holder-c", 20)).toBe(false);
  });
});
