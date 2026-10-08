#!/usr/bin/env bun
// A JSON-RPC stand-in for the S4 runs (audit/STRESS-TEST-PLAN-S4.md F5, F6). Every call is counted per method and per second, and what it
// answers follows a rule set the test changes at runtime:
//   bun stress/s4/stub-rpc.ts <port> [upstream]     upstream = a real RPC that answers the calls the rules let through; without one the
//                                                   answers are canned (getSlot, getBlockTime, getLatestBlockhash, getVersion; null accounts)
//   GET  /__stats   -> { total, byMethod, served: { ok, 429, 500, hang }, maxPerSecond: { all, scans }, buckets }
//   POST /__reset   -> zero the counters
//   GET  /__rule?mode=ok|429|500|hang&pattern=429,429,ok&methods=getProgramAccounts&after=4&hangMs=5000&cap=7&scanCap=1
//        mode: the answer for matching calls (default ok); pattern: a cyclic list applied per matching call, which overrides mode;
//        methods: only these methods match (default all); after: the fault starts with the N+1th matching call; hangMs: how long a hang
//        holds before a 504 (default 60 s); cap / scanCap: 429 beyond that many calls (all / getProgramAccounts) started in one second,
//        whatever the rule says (a provider's own per-second cap).
// Test-only. Nothing here reads or prints a key.
const port = Number(process.argv[2] ?? 18901);
const upstream = process.argv[3] ?? null;

interface Rule { mode: "ok" | "429" | "500" | "hang"; pattern: string[] | null; methods: Set<string> | null; after: number; hangMs: number; cap: number; scanCap: number }
let rule: Rule = { mode: "ok", pattern: null, methods: null, after: 0, hangMs: 60_000, cap: 0, scanCap: 0 };
let matched = 0;
const stats = { total: 0, byMethod: {} as Record<string, number>, served: { ok: 0, "429": 0, "500": 0, hang: 0 }, buckets: {} as Record<string, { all: number; scans: number }> };
let slot = 100_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const err429 = (id: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" }, id }), { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } });

function canned(method: string, id: unknown, params: unknown[]): unknown {
  const ctx = { context: { slot } };
  switch (method) {
    case "getVersion": return { "solana-core": "2.0.0-stub", "feature-set": 1 };
    case "getSlot": return ++slot;
    case "getBlockHeight": return slot - 10;
    case "getBlockTime": return Math.floor(Date.now() / 1000);
    case "getLatestBlockhash": return { ...ctx, value: { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: slot + 150 } };
    case "getAccountInfo": return { ...ctx, value: null };
    case "getMultipleAccounts": return { ...ctx, value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
    case "getProgramAccounts": return [];
    case "getSignatureStatuses": return { ...ctx, value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
    case "getBalance": return { ...ctx, value: 0 };
    default: return null;
  }
}

function bucket(method: string): { all: number; scans: number } {
  const key = String(Math.floor(Date.now() / 1000));
  const b = (stats.buckets[key] ??= { all: 0, scans: 0 });
  b.all++;
  if (method === "getProgramAccounts") b.scans++;
  return b;
}

interface RpcCall { method?: string; id?: unknown; params?: unknown[] }

async function answer(req: Request, bodyText: string): Promise<Response> {
  let body: RpcCall | null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    body = (Array.isArray(parsed) ? parsed[0] : parsed) as RpcCall;
  } catch {
    body = null;
  }
  const method = String(body?.method ?? "?");
  const id = body?.id ?? 1;
  stats.total++;
  stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
  const b = bucket(method);
  if ((rule.cap > 0 && b.all > rule.cap) || (rule.scanCap > 0 && method === "getProgramAccounts" && b.scans > rule.scanCap)) {
    stats.served["429"]++;
    return err429(id);
  }
  let mode: Rule["mode"] = "ok";
  if (!rule.methods || rule.methods.has(method)) {
    matched++;
    if (matched > rule.after) mode = rule.pattern ? (rule.pattern[(matched - rule.after - 1) % rule.pattern.length] as Rule["mode"]) : rule.mode;
  }
  if (mode === "429") {
    stats.served["429"]++;
    return err429(id);
  }
  if (mode === "500") {
    stats.served["500"]++;
    return new Response("bad gateway (stub)", { status: 502 });
  }
  if (mode === "hang") {
    stats.served.hang++;
    await sleep(rule.hangMs, req.signal);
    return new Response("gateway timeout (stub)", { status: 504 });
  }
  stats.served.ok++;
  if (upstream) {
    const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: bodyText, signal: req.signal });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  }
  return Response.json({ jsonrpc: "2.0", result: canned(method, id, body?.params ?? []), id });
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__stats") {
      const all = Object.values(stats.buckets);
      return Response.json({ ...stats, maxPerSecond: { all: Math.max(0, ...all.map((x) => x.all)), scans: Math.max(0, ...all.map((x) => x.scans)) }, rule: { ...rule, methods: rule.methods ? [...rule.methods] : null } });
    }
    if (url.pathname === "/__reset") {
      stats.total = 0;
      stats.byMethod = {};
      stats.served = { ok: 0, "429": 0, "500": 0, hang: 0 };
      stats.buckets = {};
      matched = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__rule") {
      const p = url.searchParams;
      const m = p.get("methods");
      rule = {
        mode: (p.get("mode") as Rule["mode"]) ?? "ok",
        pattern: p.get("pattern") ? p.get("pattern")!.split(",") : null,
        methods: m ? new Set(m.split(",")) : null,
        after: Number(p.get("after") ?? 0),
        hangMs: Number(p.get("hangMs") ?? 60_000),
        cap: Number(p.get("cap") ?? 0),
        scanCap: Number(p.get("scanCap") ?? 0),
      };
      matched = 0;
      return Response.json({ ok: true, rule: { ...rule, methods: m ? m.split(",") : null } });
    }
    if (req.method !== "POST") return new Response("stub rpc", { status: 200 });
    return answer(req, await req.text());
  },
});
console.log(`stub rpc on 127.0.0.1:${port}${upstream ? ` -> ${upstream}` : " (canned answers)"}`);

export {}; // a module, so its top-level names never share a scope with stress/fault-proxy.ts under tsc
