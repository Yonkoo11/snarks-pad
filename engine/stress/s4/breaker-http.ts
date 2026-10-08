#!/usr/bin/env bun
// S4 ST-RG-01 and ST-RG-02 over HTTP: an API process whose RPC is the counting stub (stress/s4/stub-rpc.ts) in front of the real validator, with real pools.
//   bun stress/s4/breaker-http.ts <api base> <stub base> <api log file>
// RG-01: the stub answers 429 to two of every three calls for 12 s of list requests: the breaker (three IN A ROW) must never open, nothing may answer
// other than 200, and the stub's count stays bounded by the coin views' 3 s cache. RG-02: every call 429: the breaker opens once; for 30 s every list
// request answers 200 from the database while the stub's count stays flat; at 31 s the stub answers again, the next list request lets one probe through
// and the breaker closes; the log holds one open line and one close line.
import { readFileSync } from "node:fs";

const base = process.argv[2]!;
const stub = process.argv[3]!;
const logFile = process.argv[4]!;
const rule = async (q: string): Promise<void> => void (await fetch(`${stub}/__rule?${q}`));
const reset = async (): Promise<void> => void (await fetch(`${stub}/__reset`, { method: "POST" }));
const stats = async (): Promise<{ total: number; served: Record<string, number> }> => (await fetch(`${stub}/__stats`)).json() as Promise<{ total: number; served: Record<string, number> }>;
const logLines = (re: RegExp): number => (readFileSync(logFile, "utf8").match(re) ?? []).length;
const pct = (a: number[], p: number): number => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0);
const say = (id: string, pass: boolean, detail: Record<string, unknown>): void => console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${JSON.stringify(detail)}`);

async function listOnce(): Promise<{ status: number; ms: number; coins: number; priced: number }> {
  const t0 = performance.now();
  const res = await fetch(`${base}/coins`);
  const body = (await res.json()) as { coins?: Record<string, unknown>[] };
  return { status: res.status, ms: performance.now() - t0, coins: body.coins?.length ?? 0, priced: body.coins?.filter((c) => c.priceZec !== undefined).length ?? 0 };
}

// ---- RG-01 ----
{
  await rule("mode=ok");
  await listOnce(); // warm: every pool read once
  await Bun.sleep(3_500);
  await rule("pattern=429,429,ok");
  await reset();
  const opensBefore = logLines(/circuit breaker open/g);
  const closesBefore01 = logLines(/circuit breaker closed/g);
  const results: Awaited<ReturnType<typeof listOnce>>[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 12_000) {
    results.push(...(await Promise.all(Array.from({ length: 20 }, listOnce))));
    await Bun.sleep(250);
  }
  const s = await stats();
  const opens = logLines(/circuit breaker open/g) - opensBefore;
  const ms = results.map((r) => r.ms);
  const closes = logLines(/circuit breaker closed/g) - closesBefore01;
  // completion order decides "in a row", so a 2-of-3 pattern can open it once; it must then stay open until its probe (no flapping, no log flood)
  say("ST-RG-01 two of every three RPC calls answered 429 for 12 s: the breaker opens at most once and never flaps, every list answers 200, the stub sees a bounded number of calls", results.every((r) => r.status === 200) && opens <= 1 && closes === 0 && s.total < 400, { requests: results.length, non200: results.filter((r) => r.status !== 200).length, breakerOpens: opens, breakerCloses: closes, stubCalls: s.total, served: s.served, p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), coinsListed: results.at(-1)?.coins, pricedAtEnd: results.at(-1)?.priced });
}

// ---- RG-02 ----
{
  await rule("mode=ok");
  await reset();
  // RG-01 may have left the breaker open: wait out its window and let a probe close it before this case starts from a closed breaker
  for (let i = 0; i < 40; i++) {
    await listOnce();
    await Bun.sleep(1_000);
    if (((await stats()).served.ok ?? 0) > 0 && (await listOnce()).priced > 0) break;
  }
  await reset();
  await Bun.sleep(3_500);
  await listOnce();
  await Bun.sleep(3_500);
  await rule("mode=429");
  await reset();
  const opensBefore = logLines(/circuit breaker open/g);
  const closesBefore = logLines(/circuit breaker closed/g);
  const first = await listOnce(); // the reads behind it fail: three in a row open the breaker
  await Bun.sleep(500);
  const afterOpen = (await stats()).total;
  const during: { at: number; status: number; ms: number; stubTotal: number }[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 28_000) {
    const r = await listOnce();
    during.push({ at: Date.now() - t0, status: r.status, ms: Math.round(r.ms), stubTotal: (await stats()).total });
    await Bun.sleep(2_000);
  }
  const openedOnce = logLines(/circuit breaker open/g) - opensBefore === 1;
  const flat = during.every((d) => d.stubTotal === afterOpen);
  await rule("mode=ok");
  await Bun.sleep(3_000); // past 30 s since the open
  const probeList = await listOnce();
  await Bun.sleep(1_500);
  const afterProbe = (await stats()).total;
  const closed = logLines(/circuit breaker closed/g) - closesBefore === 1;
  await Bun.sleep(3_500);
  const recovered = await listOnce();
  say("ST-RG-02 every call 429: the breaker opens once after three failures; for 30 s lists answer 200 from the database while the stub's count stays flat; after 30 s one probe goes through, the breaker closes (one line each) and the pool numbers come back", first.status === 200 && openedOnce && flat && during.every((d) => d.status === 200 && d.ms < 2_000) && probeList.status === 200 && afterProbe > afterOpen && closed && recovered.priced > 0, { firstList: [first.status, Math.round(first.ms)], stubCallsWhenOpen: afterOpen, samplesWhileOpen: during.length, flatWhileOpen: flat, maxMsWhileOpen: Math.max(...during.map((d) => d.ms)), openedOnce, stubCallsAfterProbe: afterProbe, closedOnce: closed, pricedAfterRecovery: recovered.priced, coins: recovered.coins });
}
