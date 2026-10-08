#!/usr/bin/env bun
// Scenario 5 (audit/STRESS-REPORT.md): open-loop load on the engine API (every public route, the trade-tx and launch-tx
// builders, the confirm routes) plus the static web on `vite preview`, stepping 50 -> 500 requests/s, 30 s per step.
// Per step: status counts per route, p50/p95/p99 latency, the API process's RSS; every 50th body is scanned for a full
// unified address or key material. Needs the API (PAD_DB_FILE with launched coins) on API_URL and the preview on WEB_URL.
// Contract v2.6 adds the trader routes (quote, holders, pot, fixed, trades, rewards, verify-memo, epochs.csv) to the mix, and a stream
// scenario: STREAMS (default 21, three per client address) Server-Sent Events connections stay open for the whole run while a writer
// (stress/api-load-trades.ts, started here when PAD_DB_FILE is set) records a trade every 400 ms into the API's database, and the
// harness reports how long each trade took to reach each stream.
//   bun stress/api-load.ts <wallets.json> <api pid>
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { STRESS_DIR } from "./lib";

const API = Bun.env.API_URL ?? "http://127.0.0.1:8794/api";
const WEB = Bun.env.WEB_URL ?? "http://127.0.0.1:4174";
const W = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { mints: Record<string, string>; holders: string[]; optins: { wallet: string }[] };
const apiPid = Number(process.argv[3]);
const STEPS = (Bun.env.STEPS ?? "50,100,200,300,500").split(",").map(Number);
const STEP_S = Number(Bun.env.STEP_S ?? 30);
const mints = Object.values(W.mints);
const epochs = ((await (await fetch(`${API}/epochs`)).json()) as { epochs: { id: string }[] }).epochs.map((e) => e.id);
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const wallet = () => (Math.random() < 0.5 ? pick(W.holders) : Keypair.generate().publicKey.toBase58());

interface Req { route: string; read: boolean; method: string; url: string; body?: unknown }
// Weighted mix: mostly reads, like a page load; builders and writes at a realistic share.
const MIX: [number, () => Req][] = [
  [14, () => ({ route: "GET /coins", read: true, method: "GET", url: `${API}/coins` })],
  [14, () => ({ route: "GET /coins/:mint", read: true, method: "GET", url: `${API}/coins/${pick(mints)}` })],
  // Contract v2.5 (explore grid): the sorted, filtered and paged list, and the stats header. Added to the mix after the first four runs.
  [6, () => ({ route: "GET /coins?sort=volume", read: true, method: "GET", url: `${API}/coins?sort=volume&limit=24` })],
  [4, () => ({ route: "GET /coins?stage=curve&sort=progress", read: true, method: "GET", url: `${API}/coins?stage=curve&sort=progress&limit=24&offset=0` })],
  [3, () => ({ route: "GET /coins?q=", read: true, method: "GET", url: `${API}/coins?q=${pick(["snarks", "tier", "a", "vault"])}&sort=mcap` })],
  [6, () => ({ route: "GET /stats", read: true, method: "GET", url: `${API}/stats` })],
  [8, () => ({ route: "GET /coins/:mint/price-history", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/price-history` })],
  [5, () => ({ route: "GET /coins/:mint/creator-fees", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/creator-fees` })],
  [6, () => ({ route: "GET /tiers", read: true, method: "GET", url: `${API}/tiers` })],
  [8, () => ({ route: "GET /treasury", read: true, method: "GET", url: `${API}/treasury` })],
  [8, () => ({ route: "GET /epochs", read: true, method: "GET", url: `${API}/epochs` })],
  [4, () => ({ route: "GET /epochs/:id/snapshot", read: true, method: "GET", url: `${API}/epochs/${pick(epochs)}/snapshot` })],
  // v2.9: the status read needs a signature, so it is not a load row; the wallet profile (database only) takes its place.
  [6, () => ({ route: "GET /wallets/:wallet", read: true, method: "GET", url: `${API}/wallets/${Math.random() < 0.5 ? pick(W.optins).wallet : wallet()}` })],
  [6, () => ({ route: "GET /optin/nonce", read: false, method: "GET", url: `${API}/optin/nonce?wallet=${wallet()}` })],
  [7, () => ({ route: "POST /coins/:mint/trade-tx", read: false, method: "POST", url: `${API}/coins/${pick(mints)}/trade-tx`, body: { wallet: pick(W.holders), side: pick(["buy", "sell"]), amount: String(1_000_000 + Math.floor(Math.random() * 5e6)), slippageBps: 300 } })],
  [3, () => ({ route: "POST /coins/launch-tx", read: false, method: "POST", url: `${API}/coins/launch-tx`, body: { creator: wallet(), name: "Load", symbol: "LOAD", description: "", imageUrl: "", initialBuyZec: "20000000" } })],
  [2, () => ({ route: "POST /optin (bad signature)", read: false, method: "POST", url: `${API}/optin`, body: { wallet: wallet(), zcashAddress: "u1" + "q".repeat(100), nonce: "n", signature: "1111" } })],
  [1, () => ({ route: "POST /coins/:mint/trade-confirm (unknown sig)", read: false, method: "POST", url: `${API}/coins/${pick(mints)}/trade-confirm`, body: { sig: "5".repeat(88) } })],
  [8, () => ({ route: "GET web /", read: true, method: "GET", url: `${WEB}/` })],
  // Contract v2.6 (trader panel): chain-backed views are cached per window, so these must hold the same budgets as the pool views above.
  [8, () => ({ route: "GET /coins/:mint/quote", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/quote?side=${pick(["buy", "sell"])}&amount=${1_000_000 + Math.floor(Math.random() * 90_000_000)}&slippageBps=${pick([50, 100, 300])}` })],
  [6, () => ({ route: "GET /coins/:mint/holders", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/holders?limit=${pick([10, 20, 50])}&offset=${pick([0, 0, 10])}` })],
  [6, () => ({ route: "GET /coins/:mint/pot", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/pot` })],
  [3, () => ({ route: "GET /coins/:mint/fixed", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/fixed` })],
  [6, () => ({ route: "GET /trades", read: true, method: "GET", url: `${API}/trades?limit=${pick([30, 100])}&all=1` })],
  [4, () => ({ route: "GET /coins/:mint/trades", read: true, method: "GET", url: `${API}/coins/${pick(mints)}/trades` })],
  [4, () => ({ route: "GET /rewards/:wallet", read: true, method: "GET", url: `${API}/rewards/${Math.random() < 0.5 ? pick(W.holders) : wallet()}` })],
  [2, () => ({ route: "POST /rewards/verify-memo", read: false, method: "POST", url: `${API}/rewards/verify-memo`, body: { memo: `SNARKS pad reward, epoch ${pick(epochs)}`, txid: "a".repeat(64) } })],
  [2, () => ({ route: "GET /epochs.csv", read: true, method: "GET", url: `${API}/epochs.csv` })],
];
// SKIP_V26=1: leave out the contract v2.6 routes (the mix of the v2.5 runs), to compare the same host and the same hour with and without them.
const V26 = ["/quote", "/holders", "/pot", "/fixed", "GET /trades", "/trades", "/rewards/", "/epochs.csv"];
if (Bun.env.SKIP_V26) MIX.splice(0, MIX.length, ...MIX.filter(([, f]) => !V26.some((v) => f().route.includes(v))));
// ONLY=<substring>: keep only the routes whose name contains it (to tell a slow server from a saturated client).
if (Bun.env.ONLY) MIX.splice(0, MIX.length, ...MIX.filter(([, f]) => f().route.includes(Bun.env.ONLY!)));
const totalW = MIX.reduce((a, [w]) => a + w, 0);
function next(): Req {
  let r = Math.random() * totalW;
  for (const [w, f] of MIX) if ((r -= w) < 0) return f();
  return MIX[0]![1]();
}

const U1 = /\bu(?:regtest|test)?1[0-9a-z]{60,}|uregtest1loadtest/; // the seed's opt-in address is short and fake: match its text too
const KEYISH = /\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]|secretKey|BEGIN (?:EC |RSA )?PRIVATE KEY|AGE-SECRET-KEY/;
const rss = () => Number(new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(apiPid)]).stdout).trim() || 0);
const fds = () => new TextDecoder().decode(Bun.spawnSync(["lsof", "-p", String(apiPid)]).stdout).split("\n").filter(Boolean).length - 1;
const pct = (a: number[], p: number) => (a.length ? a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0);

const steps: unknown[] = [];
const leaks: string[] = [];
let sampled = 0;

// ---- the stream scenario (contract v2.6): long-lived event streams while the writer records trades and the routes above are hit ----
const STREAMS = Number(Bun.env.STREAMS ?? 21);
const streamLatencies: number[] = [];
let streamEvents = 0;
let streamsOpened = 0;
let streamsRefused = 0;
const streamCtl = new AbortController();
async function holdStream(i: number): Promise<void> {
  const ip = `198.51.100.${1 + Math.floor(i / 3)}`; // three streams per client address, under the limit of four
  try {
    const res = await fetch(`${API}/events/trades?all=1`, { headers: { "x-forwarded-for": ip }, signal: streamCtl.signal });
    if (res.status === 429) { streamsRefused++; return; }
    streamsOpened++;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (let buf = ""; ;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      for (let cut = buf.indexOf("\n\n"); cut >= 0; cut = buf.indexOf("\n\n")) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        streamEvents++;
        streamLatencies.push(Date.now() - Date.parse((JSON.parse(data) as { at: string }).at));
      }
    }
  } catch { /* aborted at the end */ }
}
const holders = Array.from({ length: STREAMS }, (_, i) => holdStream(i));
const writer = Bun.env.PAD_DB_FILE ? Bun.spawn(["bun", join(import.meta.dir, "api-load-trades.ts")], { env: { ...Bun.env }, stdout: "ignore", stderr: "inherit" }) : null;
const rssStart = rss();
const fdsStart = fds();
for (const rate of STEPS) {
  const per = new Map<string, { lat: number[]; status: Record<number, number>; read: boolean; codes: Record<string, number> }>();
  const pending: Promise<void>[] = [];
  const start = performance.now();
  let sent = 0;
  let errors = 0;
  while (performance.now() - start < STEP_S * 1000) {
    const due = Math.floor(((performance.now() - start) / 1000) * rate);
    while (sent < due) {
      sent++;
      const req = next();
      const t = performance.now();
      pending.push((async () => {
        const s = per.get(req.route) ?? { lat: [], status: {}, read: req.read, codes: {} };
        per.set(req.route, s);
        try {
          const res = await fetch(req.url, { method: req.method, headers: req.body ? { "content-type": "application/json" } : undefined, body: req.body ? JSON.stringify(req.body) : undefined, signal: AbortSignal.timeout(60_000) });
          const text = await res.text();
          s.lat.push(performance.now() - t);
          s.status[res.status] = (s.status[res.status] ?? 0) + 1;
          if (res.status >= 400) {
            const code = /"error":"([a-z_]+)"/.exec(text)?.[1] ?? "?";
            s.codes[`${res.status} ${code}`] = (s.codes[`${res.status} ${code}`] ?? 0) + 1;
          }
          if (sent % 50 === 0) {
            sampled++;
            if (U1.test(text)) leaks.push(`${req.route}: a full unified address in the body`);
            if (KEYISH.test(text)) leaks.push(`${req.route}: key-like material in the body`);
          }
        } catch (e) {
          errors++;
          s.status[0] = (s.status[0] ?? 0) + 1;
        }
      })());
    }
    await Bun.sleep(2);
  }
  await Promise.all(pending);
  const routes = Object.fromEntries([...per].map(([k, v]) => [k, { n: v.lat.length, p50: Math.round(pct(v.lat, 0.5)), p95: Math.round(pct(v.lat, 0.95)), p99: Math.round(pct(v.lat, 0.99)), status: v.status, codes: v.codes }]));
  const all = [...per.values()].flatMap((v) => v.lat);
  const reads = [...per.values()].filter((v) => v.read).flatMap((v) => v.lat);
  const s500 = [...per.values()].reduce((a, v) => a + (v.status[500] ?? 0), 0);
  const rec = { rate, sent, achievedRps: +(sent / STEP_S).toFixed(1), errors, http500: s500, p50: Math.round(pct(all, 0.5)), p95: Math.round(pct(all, 0.95)), readP95: Math.round(pct(reads, 0.95)), apiRssKb: rss(), apiFds: fds(), routes };
  steps.push(rec);
  appendFileSync(join(STRESS_DIR, "api-load.log"), JSON.stringify(rec) + "\n");
  console.log(`rate ${rate}: sent ${sent}, 500s ${s500}, client errors ${errors}, p50 ${rec.p50} ms, p95 ${rec.p95} ms, read p95 ${rec.readP95} ms, API RSS ${rec.apiRssKb} KB, fds ${rec.apiFds}`);
  await Bun.sleep(5000);
}
await Bun.sleep(30_000);
writer?.kill();
streamCtl.abort();
await Promise.all(holders);
const stream = { wanted: STREAMS, opened: streamsOpened, refused: streamsRefused, events: streamEvents, latencyMs: { p50: Math.round(pct(streamLatencies, 0.5)), p95: Math.round(pct(streamLatencies, 0.95)), p99: Math.round(pct(streamLatencies, 0.99)) } };
console.log(`streams: ${JSON.stringify(stream)}`);
const out = { rssStartKb: rssStart, rssAfterCooldownKb: rss(), fdsStart, fdsAfter: fds(), sampledBodies: sampled, leaks, stream, steps };
writeFileSync(join(STRESS_DIR, "api-load-result.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ rssStartKb: out.rssStartKb, rssAfterCooldownKb: out.rssAfterCooldownKb, fdsStart, fdsAfter: out.fdsAfter, sampledBodies: sampled, leaks: leaks.slice(0, 5) }));
process.exit(0);
