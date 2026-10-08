#!/usr/bin/env bun
// S4 F7: the trades event stream over real sockets against an API process (ST-SSE-01..05, audit/STRESS-TEST-PLAN-S4.md). Streams are opened
// with X-Forwarded-For (the API believes it from a loopback peer, as behind Caddy); the writer is a separate process on the same database
// (stress/s4/sse-writer.ts), as the keeper is; the lock holder is another process holding a write transaction.
//   bun stress/s4/sse.ts <api base> <db file> <seed.json> <api pid>
import { readFileSync } from "node:fs";

const base = process.argv[2]!;
const dbFile = process.argv[3]!;
const seed = JSON.parse(readFileSync(process.argv[4]!, "utf8")) as { mints: string[]; creators: number[][] };
const pid = Number(process.argv[5]);
const ROOT = new URL("../..", import.meta.url).pathname;
const out: Record<string, unknown>[] = [];
const say = (id: string, pass: boolean, detail: Record<string, unknown>): void => {
  out.push({ id, pass, ...detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${JSON.stringify(detail)}`);
};
const alive = (): boolean => Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0;

interface Ev { id: number; sig: string; atMs: number }
interface Stream { status: number; retryAfter: string | null; events: Ev[]; close: () => void; done: Promise<void>; raw: string }

async function open(ip: string, o: { mint?: string; lastEventId?: string; all?: boolean } = {}): Promise<Stream> {
  const ctrl = new AbortController();
  const q = new URLSearchParams();
  if (o.mint) q.set("mint", o.mint);
  if (o.all) q.set("all", "1");
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (o.lastEventId !== undefined) headers["last-event-id"] = o.lastEventId;
  const res = await fetch(`${base}/events/trades?${q}`, { headers, signal: ctrl.signal });
  const s: Stream = { status: res.status, retryAfter: res.headers.get("retry-after"), events: [], close: () => ctrl.abort(), done: Promise.resolve(), raw: "" };
  if (res.status !== 200 || !res.body) {
    s.raw = await res.text().catch(() => "");
    return s;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  s.done = (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          s.raw += block + "\n\n";
          const id = /^id: (\d+)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (id && data && block.includes("event: trade")) s.events.push({ id: Number(id[1]), sig: (JSON.parse(data[1]!) as { sig: string }).sig, atMs: Date.now() });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return s;
}

const pct = (a: number[], p: number): number => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0);
const sleep = (ms: number) => Bun.sleep(ms);
const mint = seed.mints[0]!;
const wallet = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

function writer(count: number, gapMs: number, which = mint): { proc: ReturnType<typeof Bun.spawn>; rows: Promise<Map<string, number>> } {
  const proc = Bun.spawn(["bun", "stress/s4/sse-writer.ts", which, wallet, String(count), String(gapMs)], { cwd: ROOT, env: { ...process.env, PAD_MODE: "local", PAD_DB_FILE: dbFile }, stdout: "pipe", stderr: "inherit" });
  const rows = new Response(proc.stdout).text().then((t) => new Map(t.trim().split("\n").filter(Boolean).map((l) => { const [, sig, at] = l.split(" "); return [sig!, Number(at)] as [string, number]; })));
  return { proc, rows };
}

// ---- ST-SSE-01: 4 per address, 400 in all ----
{
  const ip = "198.51.100.1";
  const four = await Promise.all([1, 2, 3, 4].map(() => open(ip)));
  const fifth = await open(ip);
  const other = await open("198.51.100.2");
  say("ST-SSE-01a 4 per address, the 5th is 429 with retry-after 5, another address is fine", four.every((s) => s.status === 200) && fifth.status === 429 && fifth.retryAfter === "5" && other.status === 200, { statuses: four.map((s) => s.status), fifth: fifth.status, retryAfter: fifth.retryAfter, other: other.status, body: fifth.raw });
  four[0]!.close();
  await sleep(300);
  const again = await open(ip);
  say("ST-SSE-01b a closed stream frees its slot", again.status === 200, { status: again.status });
  for (const s of [...four, other, again]) s.close();
  await sleep(300);
  const many: Stream[] = [];
  for (let i = 0; i < 100; i++) many.push(...(await Promise.all([1, 2, 3, 4].map(() => open(`203.0.113.${i}`)))));
  const openCount = many.filter((s) => s.status === 200).length;
  const beyond = await open("203.0.113.200");
  say("ST-SSE-01c 400 streams open across 100 addresses; the 401st is 429", openCount === 400 && beyond.status === 429, { open: openCount, beyond: beyond.status, apiAlive: alive() });
  many[7]!.close();
  await sleep(500);
  const freed = await open("203.0.113.201");
  say("ST-SSE-01d closing one of the 400 frees one", freed.status === 200, { status: freed.status });
  for (const s of [...many, freed]) s.close();
  await sleep(500);
}

// ---- ST-SSE-02: cross-process delivery to 20 streams over 5 addresses ----
{
  const streams: Stream[] = [];
  for (let i = 0; i < 5; i++) streams.push(...(await Promise.all([1, 2, 3, 4].map(() => open(`198.51.100.${10 + i}`, { mint })))));
  await sleep(300);
  const w = writer(100, 200);
  const rows = await w.rows;
  await w.proc.exited;
  await sleep(2_500);
  const sigs = [...rows.keys()];
  const latencies: number[] = [];
  let complete = 0;
  let ordered = 0;
  let duplicates = 0;
  for (const s of streams) {
    const got = s.events.filter((e) => rows.has(e.sig));
    const seen = new Set<string>();
    for (const e of got) {
      if (seen.has(e.sig)) duplicates++;
      seen.add(e.sig);
      latencies.push(e.atMs - rows.get(e.sig)!);
    }
    if (seen.size === sigs.length) complete++;
    const ids = got.map((e) => e.id);
    if (ids.every((n, i) => i === 0 || n > ids[i - 1]!)) ordered++;
  }
  say("ST-SSE-02 every stream hears every trade of the other process once, in arrival order, within ~1 s", complete === 20 && ordered === 20 && duplicates === 0 && pct(latencies, 0.95) <= 1_300, { streams: streams.length, complete, ordered, duplicates, written: sigs.length, latencyP50: Math.round(pct(latencies, 0.5)), latencyP95: Math.round(pct(latencies, 0.95)), latencyMax: Math.round(Math.max(0, ...latencies)) });
  for (const s of streams) s.close();
  await sleep(300);
}

// ---- ST-SSE-03: Last-Event-ID over HTTP ----
{
  const ip = "198.51.100.30";
  const first = await open(ip, { mint });
  await sleep(300);
  const w1 = writer(5, 50);
  await w1.rows;
  await w1.proc.exited;
  await sleep(1_500);
  const lastId = first.events.at(-1)?.id ?? null;
  first.close();
  await sleep(200);
  const w2 = writer(30, 10);
  const missed = await w2.rows;
  await w2.proc.exited;
  const re = await open(ip, { mint, lastEventId: String(lastId) });
  await sleep(1_500);
  const w3 = writer(3, 50);
  const live = await w3.rows;
  await w3.proc.exited;
  await sleep(1_500);
  const replayed = re.events.filter((e) => missed.has(e.sig)).map((e) => e.id);
  const liveGot = re.events.filter((e) => live.has(e.sig)).length;
  const dup = re.events.length !== new Set(re.events.map((e) => e.sig)).size;
  say("ST-SSE-03a reconnecting with the last id replays the 30 missed trades oldest first, then live trades follow, none twice", first.events.length === 5 && replayed.length === 30 && replayed.every((n, i) => i === 0 || n > replayed[i - 1]!) && liveGot === 3 && !dup, { before: first.events.length, lastId, replayed: replayed.length, live: liveGot, duplicates: dup });
  re.close();
  const w4 = writer(70, 5);
  const seventy = await w4.rows;
  await w4.proc.exited;
  const re2 = await open(ip, { mint, lastEventId: String(lastId) });
  await sleep(1_500);
  const got70 = re2.events.filter((e) => seventy.has(e.sig));
  const newest50 = [...seventy.keys()].slice(-50);
  say("ST-SSE-03b a gap of 70 gives back the newest 50 only, oldest first", got70.length === 50 && got70.every((e, i) => e.sig === newest50[i]), { replayed: got70.length, firstReplayed: got70[0]?.sig, expectedFirst: newest50[0] });
  re2.close();
  const future = await open(ip, { mint, lastEventId: "999999999999" });
  await sleep(1_000);
  say("ST-SSE-03c an id from the future replays nothing", future.status === 200 && future.events.length === 0, { events: future.events.length });
  future.close();
  const other = seed.mints[1]!;
  const w5 = writer(4, 5, other);
  await w5.rows;
  await w5.proc.exited;
  const filtered = await open(ip, { mint: other, lastEventId: String(lastId) });
  await sleep(1_000);
  say("ST-SSE-03d a replay with a mint filter holds only that coin's trades", filtered.events.length === 4 && filtered.events.every((e) => e.sig.startsWith("s4-")), { events: filtered.events.length });
  filtered.close();
  await sleep(300);
}

// ---- ST-SSE-04: another process holds a write lock for 3 s ----
{
  const ip = "198.51.100.40";
  const s = await open(ip, { mint });
  const holder = Bun.spawn(["bun", "-e", `
    const { Database } = await import("bun:sqlite");
    const d = new Database(${JSON.stringify(dbFile)});
    d.exec("BEGIN IMMEDIATE"); d.exec("INSERT INTO meta (key, value) VALUES ('s4-lock', '1') ON CONFLICT(key) DO UPDATE SET value = '2'");
    console.log("holding"); await Bun.sleep(3000); d.exec("ROLLBACK"); console.log("released");
  `], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
  const reader = holder.stdout.getReader();
  await reader.read();
  const t0 = performance.now();
  const list = await fetch(`${base}/coins`);
  const listMs = Math.round(performance.now() - t0);
  const trades = await fetch(`${base}/trades?all=1`);
  const w = writer(3, 100);
  const during = performance.now();
  await w.proc.exited;
  const writerMs = Math.round(performance.now() - during);
  await holder.exited;
  const rows = await w.rows;
  await sleep(1_500);
  const got = s.events.filter((e) => rows.has(e.sig)).length;
  say("ST-SSE-04 a 3 s write lock in another process: lists still answer, the writer waits it out, the stream stays open and hears the trades after", alive() && list.status === 200 && trades.status === 200 && got === 3, { apiAlive: alive(), list: list.status, listMs, trades: trades.status, writerWaitedMs: writerMs, heardAfter: got });
  s.close();
  await sleep(300);
}

// ---- ST-SSE-05: a client that never reads ----
{
  const ip = "198.51.100.50";
  const sock = await Bun.connect({
    hostname: "127.0.0.1", port: Number(new URL(base).port),
    socket: { data() { /* never read: the kernel buffer fills */ }, open(s) { s.write(`GET /api/events/trades?mint=${mint} HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${ip}\r\nAccept: text/event-stream\r\n\r\n`); }, close() {}, error() {} },
  });
  const watcher = await open("198.51.100.51", { mint });
  await sleep(500);
  const BURST = Number(process.env.S4_BURST ?? 20_000);
  const w = writer(BURST, 0);
  const rows = await w.rows;
  await w.proc.exited;
  await sleep(8_000);
  const three = await Promise.all([1, 2, 3].map(() => open(ip, { mint })));
  const fourth = await open(ip, { mint });
  const heard = watcher.events.filter((e) => rows.has(e.sig)).length;
  const deadSlotFreed = fourth.status === 200;
  say(`ST-SSE-05 a reading stream hears all ${BURST} trades of one burst (nothing dropped for reading slowly); the stream nobody reads holds its slot until the socket's buffers are full, then goes`, alive() && heard === BURST && three.every((s) => s.status === 200), { apiAlive: alive(), watcherHeard: heard, burst: BURST, deadSlotFreed, reopened: [...three.map((s) => s.status), fourth.status], rssKb: Number(new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout).trim() || 0) });
  for (const s of [watcher, ...three, fourth]) s.close();
  sock.end();
}
console.log(JSON.stringify({ summary: { pass: out.filter((o) => o.pass).length, fail: out.filter((o) => !o.pass).length } }));
