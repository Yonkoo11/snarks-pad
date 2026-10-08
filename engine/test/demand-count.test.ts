import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDb, countMode, format } from "../scripts/demand-count";

function makeDb(file: string): void {
  const d = new Database(file, { create: true });
  d.exec(`CREATE TABLE optins (wallet TEXT PRIMARY KEY, zcashAddress TEXT NOT NULL, registeredAt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE trades (sig TEXT PRIMARY KEY, mint TEXT NOT NULL, side TEXT NOT NULL, wallet TEXT NOT NULL, amountToken TEXT NOT NULL, amountZec TEXT NOT NULL, at TEXT NOT NULL);`);
  const o = d.query("INSERT INTO optins VALUES ($w,$a,$t,$x)");
  o.run({ $w: "W1", $a: "u1secretaddressone", $t: "2026-10-05T10:00:00Z", $x: 1 });
  o.run({ $w: "W2", $a: "u1secretaddresstwo", $t: "2026-10-06T10:00:00Z", $x: 0 });
  o.run({ $w: "W3", $a: "u1secretaddressthree", $t: "2026-10-06T11:00:00Z", $x: 1 });
  const t = d.query("INSERT INTO trades VALUES ($s,'M',$side,$w,'1','1',$at)");
  t.run({ $s: "s1", $side: "buy", $w: "W1", $at: "2026-10-06T01:00:00Z" });
  t.run({ $s: "s2", $side: "buy", $w: "W1", $at: "2026-10-06T02:00:00Z" });
  t.run({ $s: "s3", $side: "sell", $w: "W2", $at: "2026-10-06T03:00:00Z" });
  t.run({ $s: "s4", $side: "buy", $w: "W2", $at: "2026-10-07T03:00:00Z" });
  d.close();
}

describe("demand-count", () => {
  test("counts active opt-ins, unique buyers and trades per day", () => {
    const dir = mkdtempSync(join(tmpdir(), "demand-"));
    try {
      makeDb(join(dir, "devnet.sqlite"));
      const c = countMode(dir, "devnet")!;
      expect(c.optinsActive).toBe(2);
      expect(c.optinsEver).toBe(3);
      expect(c.uniqueBuyers).toBe(2);
      expect(c.tradesTotal).toBe(4);
      expect(c.tradesPerDay).toEqual([
        { day: "2026-10-06", trades: 3, buyers: 1 },
        { day: "2026-10-07", trades: 1, buyers: 1 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--since filters by date", () => {
    const dir = mkdtempSync(join(tmpdir(), "demand-"));
    try {
      makeDb(join(dir, "mainnet.sqlite"));
      const c = countMode(dir, "mainnet", "2026-10-07")!;
      expect(c.optinsActive).toBe(0);
      expect(c.tradesTotal).toBe(1);
      expect(c.uniqueBuyers).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never prints a wallet or a Zcash address", () => {
    const dir = mkdtempSync(join(tmpdir(), "demand-"));
    try {
      makeDb(join(dir, "local.sqlite"));
      const text = format(countMode(dir, "local")!);
      expect(text).not.toContain("u1secret");
      expect(text).not.toMatch(/\bW[123]\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opens read-only: the file is unchanged and writes are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "demand-"));
    try {
      const file = join(dir, "devnet.sqlite");
      makeDb(file);
      const before = readFileSync(file);
      const mtime = statSync(file).mtimeMs;
      countMode(dir, "devnet");
      expect(readFileSync(file).equals(before)).toBe(true);
      expect(statSync(file).mtimeMs).toBe(mtime);
      const ro = new Database(file, { readonly: true });
      expect(() => ro.exec("DELETE FROM trades")).toThrow();
      ro.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing database or empty schema gives zeros, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "demand-"));
    try {
      expect(countMode(dir, "mainnet")).toBeNull();
      const d = new Database(":memory:");
      expect(countDb(d, "mainnet")).toEqual({ mode: "mainnet", optinsActive: 0, optinsEver: 0, uniqueBuyers: 0, tradesTotal: 0, tradesPerDay: [] });
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
