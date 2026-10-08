#!/usr/bin/env bun
// S4 ST-LD-01/02 and the HTTP half of ST-RG-06: parallel list requests against an API process whose chain is a stub or is paced.
//   bun stress/s4/load-lists.ts <api base> <seed.json> <api pid> [rounds=10] [parallel=200] [--quote] [--seconds=N]
// Each round fires `parallel` GET /coins at once, waits for all, then `parallel` GET /coins/:mint (a random seeded mint). Prints one JSON
// line per route with status counts, p50/p95/p99/max latency, and the API process's RSS before and after. With --quote, after the rounds a
// GET /coins/:mint/quote is timed once a second until it answers within 1 s (how long the paced queue takes to drain), up to 90 s. With
// --seconds=N the rounds are repeated for N seconds instead of a fixed count (the load half of ST-RG-06).
import { readFileSync } from "node:fs";

const base = process.argv[2]!;
const seed = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as { mints: string[] };
const pid = Number(process.argv[4]);
const rounds = Number(process.argv[5] ?? 10);
const parallel = Number(process.argv[6] ?? 200);
const wantQuote = process.argv.includes("--quote");
const seconds = Number((process.argv.find((a) => a.startsWith("--seconds=")) ?? "--seconds=0").split("=")[1]);
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const rss = (): number => Number(new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout).trim() || 0);
const pct = (a: number[], p: number): number => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0);

interface Tally { ms: number[]; status: Record<string, number>; bodies: number; errors: number; errorKinds: Record<string, number> }
const tallies: Record<string, Tally> = {};
const tally = (route: string): Tally => (tallies[route] ??= { ms: [], status: {}, bodies: 0, errors: 0, errorKinds: {} });

async function one(route: string, url: string): Promise<void> {
  const t = tally(route);
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    const text = await res.text();
    t.ms.push(performance.now() - t0);
    t.status[res.status] = (t.status[res.status] ?? 0) + 1;
    if (res.status === 200 && text.length > 2) t.bodies++;
  } catch (err) {
    t.ms.push(performance.now() - t0);
    t.errors++;
    const kind = `${(err as Error)?.name ?? "Error"}: ${String((err as { code?: string })?.code ?? (err as Error)?.message ?? err).slice(0, 60)}`;
    t.errorKinds[kind] = (t.errorKinds[kind] ?? 0) + 1;
  }
}

async function round(): Promise<void> {
  await Promise.all(Array.from({ length: parallel }, () => one("GET /coins", `${base}/coins`)));
  await Promise.all(Array.from({ length: parallel }, () => one("GET /coins/:mint", `${base}/coins/${pick(seed.mints)}`)));
}

const rssBefore = rss();
const started = Date.now();
if (seconds > 0) {
  let n = 0;
  while (Date.now() - started < seconds * 1000) {
    await round();
    n++;
  }
  console.log(JSON.stringify({ rounds: n, seconds }));
} else {
  for (let i = 0; i < rounds; i++) await round();
}
const elapsed = Date.now() - started;
for (const [route, t] of Object.entries(tallies)) {
  console.log(JSON.stringify({ route, requests: t.ms.length, status: t.status, errors: t.errors, errorKinds: t.errorKinds, p50: Math.round(pct(t.ms, 0.5)), p95: Math.round(pct(t.ms, 0.95)), p99: Math.round(pct(t.ms, 0.99)), max: Math.round(Math.max(...t.ms)) }));
}
console.log(JSON.stringify({ elapsedMs: elapsed, rssBeforeKb: rssBefore, rssAfterKb: rss() }));

if (wantQuote) {
  const mint = pick(seed.mints);
  const t0 = Date.now();
  for (let i = 0; i < 90; i++) {
    const q0 = performance.now();
    const res = await fetch(`${base}/coins/${mint}/quote?side=buy&amount=1000000`);
    const ms = performance.now() - q0;
    const body = (await res.json()) as Record<string, unknown>;
    console.log(JSON.stringify({ quote: i, afterLoadMs: Date.now() - t0, status: res.status, error: body.error ?? null, ms: Math.round(ms) }));
    if (res.status === 200 && ms < 1000) break;
    await Bun.sleep(Math.max(0, 1000 - ms));
  }
}
