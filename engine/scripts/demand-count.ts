#!/usr/bin/env bun
// Demand counts: active shielded opt-ins, unique buyers,
// and trades per day, for each mode's database (local, devnet, mainnet).
// Read-only: every database is opened with { readonly: true }, so this script
// cannot create, migrate or change a row. It prints counts only, never a wallet
// or a Zcash address.
//
// What "trades" means here: rows in the pad's trades table, i.e. trades the pad
// itself recorded (POST /coins/:mint/trade-confirm). A trade made through another
// front end (Jupiter, a bot) is not in it, so on mainnet this is a floor.
//
// Usage: bun scripts/demand-count.ts [--data-dir <dir>] [--since YYYY-MM-DD]
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const MODES = ["local", "devnet", "mainnet"] as const;
export type Mode = (typeof MODES)[number];

export interface DemandCount {
  mode: Mode;
  optinsActive: number;
  optinsEver: number;
  uniqueBuyers: number;
  tradesTotal: number;
  tradesPerDay: { day: string; trades: number; buyers: number }[];
}

function hasTable(d: Database, name: string): boolean {
  return d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=$n").get({ $n: name }) !== null;
}

function num(d: Database, sql: string, params: Record<string, string>): number {
  const row = d.query(sql).get(params) as { n: number } | null;
  return row?.n ?? 0;
}

export function countDb(d: Database, mode: Mode, since = "0000-00-00"): DemandCount {
  const p = { $since: since };
  const out: DemandCount = { mode, optinsActive: 0, optinsEver: 0, uniqueBuyers: 0, tradesTotal: 0, tradesPerDay: [] };
  if (hasTable(d, "optins")) {
    out.optinsActive = num(d, "SELECT COUNT(*) AS n FROM optins WHERE active = 1 AND registeredAt >= $since", p);
    out.optinsEver = num(d, "SELECT COUNT(*) AS n FROM optins WHERE registeredAt >= $since", p);
  }
  if (hasTable(d, "trades")) {
    out.uniqueBuyers = num(d, "SELECT COUNT(DISTINCT wallet) AS n FROM trades WHERE side = 'buy' AND at >= $since", p);
    out.tradesTotal = num(d, "SELECT COUNT(*) AS n FROM trades WHERE at >= $since", p);
    out.tradesPerDay = d
      .query(
        `SELECT substr(at,1,10) AS day, COUNT(*) AS trades,
                COUNT(DISTINCT CASE WHEN side='buy' THEN wallet END) AS buyers
         FROM trades WHERE at >= $since GROUP BY day ORDER BY day`,
      )
      .all(p) as DemandCount["tradesPerDay"];
  }
  return out;
}

export function countMode(dataDir: string, mode: Mode, since?: string): DemandCount | null {
  const file = join(dataDir, `${mode}.sqlite`);
  if (!existsSync(file)) return null;
  const d = new Database(file, { readonly: true });
  try {
    return countDb(d, mode, since);
  } finally {
    d.close();
  }
}

export function format(c: DemandCount): string {
  const lines = [
    `${c.mode}: opt-ins active ${c.optinsActive} (ever ${c.optinsEver}), unique buyers ${c.uniqueBuyers}, trades ${c.tradesTotal}`,
  ];
  for (const r of c.tradesPerDay) lines.push(`  ${r.day}  trades ${r.trades}  buyers ${r.buyers}`);
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const dataDir = arg("--data-dir") ?? join(import.meta.dir, "..", "data");
  const since = arg("--since");
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error("--since must be YYYY-MM-DD");
    process.exit(2);
  }
  console.log(`demand count ${new Date().toISOString()}${since ? ` since ${since}` : ""} (pad-recorded trades only)`);
  for (const mode of MODES) {
    const c = countMode(dataDir, mode, since);
    console.log(c ? format(c) : `${mode}: no database`);
  }
}
