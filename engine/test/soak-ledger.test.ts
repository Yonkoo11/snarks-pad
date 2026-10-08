// Server soak attempt 1 (2026-10-03): the reconciliation counted claims only of epochs created after the start and
// still present, and reported "keeper ZEC moved 29862844; DB: claimed 0" while every one of the 5 keeper transactions
// was a recorded claim (a pre-start draft whose proposals were approved after the start, and a discarded soak draft).
// The ledger now counts rows by key against a snapshot taken while nothing is in flight. Own in-memory DB, no chain.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isQuiet, ledgerSince, snapshotLedger } from "../stress/soak-ledger";

function fresh(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE claim_progress (epochId TEXT, mint TEXT, kind TEXT, sig TEXT, status TEXT, amountZats TEXT, at TEXT, PRIMARY KEY (epochId, mint, kind))`);
  d.run(`CREATE TABLE payouts (epochId TEXT, wallet TEXT, kind TEXT, amountZats TEXT, sig TEXT, sentAt TEXT, PRIMARY KEY (epochId, wallet, kind))`);
  d.run(`CREATE TABLE swap_progress (ref TEXT PRIMARY KEY, amountInZats TEXT)`);
  d.run(`CREATE TABLE epochs (id TEXT PRIMARY KEY, status TEXT)`);
  return d;
}
const claim = (d: Database, e: string, m: string, status: string, amt: string | null, at: string) =>
  d.query("INSERT OR REPLACE INTO claim_progress VALUES (?,?,'trading','sig-'||?,?,?,?)").run(e, m, e + m, status, amt, at);

describe("devnet soak ledger", () => {
  test("attempt 1 replay: a pre-start draft's late claims and a discarded soak draft's claims are counted", () => {
    const d = fresh();
    d.run("INSERT INTO epochs VALUES ('old','ok')");
    claim(d, "old", "A", "confirmed", "1000", "2026-10-01T00:00:00Z");
    d.run("INSERT INTO payouts VALUES ('old','h1','solana','750','s1','2026-10-01T00:01:00Z')");
    // A draft awaiting the owner's Squads approval at the start: not quiet, the start must wait.
    d.run("INSERT INTO epochs VALUES ('pre','harvesting')");
    claim(d, "pre", "A", "signed", null, "2026-10-03T17:40:00Z");
    expect(isQuiet(d)).toBe(false);
    // The old harness snapshotted here anyway; this is what it would have recorded. Then the approval lands,
    // the claim is confirmed, the draft is discarded (row deleted), and a soak draft is claimed and discarded too.
    const early = snapshotLedger(d);
    claim(d, "pre", "A", "confirmed", "5492399", "2026-10-03T17:40:00Z"); // execute signed before the start
    d.run("DELETE FROM epochs WHERE id = 'pre'");
    claim(d, "soak1", "A", "confirmed", "24370445", "2026-10-03T17:54:58Z");
    expect(ledgerSince(d, early).claimed).toBe(29_862_844n); // = the keeper's chain movement in attempt 1
  });

  test("a snapshot taken when quiet excludes everything before it and counts everything after", () => {
    const d = fresh();
    d.run("INSERT INTO epochs VALUES ('old','ok')");
    claim(d, "old", "A", "confirmed", "1000", "2026-10-01T00:00:00Z");
    d.run("INSERT INTO payouts VALUES ('old','h1','solana','750','s1','2026-10-01T00:01:00Z')");
    d.run("INSERT INTO swap_progress VALUES ('sw-old','100')");
    expect(isQuiet(d)).toBe(true);
    const s = snapshotLedger(d);
    d.run("INSERT INTO epochs VALUES ('e1','ok')");
    claim(d, "e1", "A", "confirmed", "2000", "2026-10-03T18:10:00Z");
    claim(d, "e1", "B", "confirmed", "3000", "2026-10-03T18:10:05Z");
    d.run("INSERT INTO payouts VALUES ('e1','h1','solana','1500','s2','2026-10-03T18:11:00Z')");
    d.run("INSERT INTO payouts VALUES ('e1','h2','shielded','900',NULL,NULL)");
    d.run("INSERT INTO swap_progress VALUES ('sw-e1','400')");
    const l = ledgerSince(d, s);
    expect(l.claimed).toBe(5_000n);
    expect(l.sent.map((p) => p.amountZats)).toEqual(["1500"]);
    expect(l.unsent).toBe(1);
    expect(l.swapped).toBe(400n);
  });

  test("an epoch marked ok whose payout rows are not all sent is still in flight", () => {
    // finalizeHarvest sets "ok" when it plans the payouts; the legs send them afterwards (run 3, epoch 5).
    const d = fresh();
    d.run("INSERT INTO epochs VALUES ('e1','ok')");
    d.run("INSERT INTO payouts VALUES ('e1','h1','solana','1500',NULL,NULL)");
    expect(isQuiet(d)).toBe(false);
    d.run("UPDATE payouts SET sig = 's', sentAt = '2026-10-04T04:23:30Z'");
    expect(isQuiet(d)).toBe(true);
  });
});
