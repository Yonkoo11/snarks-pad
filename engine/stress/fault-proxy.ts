#!/usr/bin/env bun
// Fault-injecting JSON-RPC proxy for the stress runs (audit/STRESS-REPORT.md). The engine is pointed at it with
// SOLANA_LOCAL_RPC=http://127.0.0.1:<port>; websockets (port+1) are passed through untouched to the validator's 8900.
// Counts every JSON-RPC method (batches included) and injects faults chosen at runtime:
//   GET  /__stats                         -> {"counts": {...}, "faults": n}
//   POST /__reset                         -> zero the counters
//   GET  /__fault?mode=M&rate=R&methods=a,b&delayMs=D
//        mode: none | http500 | rpcerror | timeout (hold delayMs, default 90 s, then 504) | slow (delay then forward)
//        rate: 0..1 share of matching requests that get the fault; methods: only these methods (default all)
// Usage: bun stress/fault-proxy.ts [port=18899] [upstream=http://127.0.0.1:8899]
const port = Number(process.argv[2] ?? 18899);
const upstream = process.argv[3] ?? "http://127.0.0.1:8899";
const upstreamWsPort = Number(new URL(upstream).port || 8899) + 1;

interface Fault { mode: string; rate: number; methods: Set<string> | null; delayMs: number }
let fault: Fault = { mode: "none", rate: 0, methods: null, delayMs: 90_000 };
const counts: Record<string, number> = {};
let faults = 0;

function methodsOf(body: unknown): string[] {
  const items = Array.isArray(body) ? body : [body];
  return items.map((i) => String((i as { method?: unknown })?.method ?? "?"));
}

function rpcErrorFor(body: unknown): unknown {
  const items = Array.isArray(body) ? body : [body];
  const errs = items.map((i) => ({ jsonrpc: "2.0", id: (i as { id?: unknown })?.id ?? null, error: { code: -32005, message: "Node is behind (injected)" } }));
  return Array.isArray(body) ? errs : errs[0];
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__stats") return Response.json({ counts, faults, fault: { ...fault, methods: fault.methods ? [...fault.methods] : null } });
    if (url.pathname === "/__reset") {
      for (const k of Object.keys(counts)) delete counts[k];
      faults = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__fault") {
      const m = url.searchParams.get("methods");
      fault = {
        mode: url.searchParams.get("mode") ?? "none",
        rate: Number(url.searchParams.get("rate") ?? 1),
        methods: m ? new Set(m.split(",")) : null,
        delayMs: Number(url.searchParams.get("delayMs") ?? 90_000),
      };
      return Response.json({ ok: true, fault: { ...fault, methods: m } });
    }
    const text = await req.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* forwarded as is */
    }
    const methods = methodsOf(body);
    for (const m of methods) counts[m] = (counts[m] ?? 0) + 1;
    const matches = fault.mode !== "none" && (!fault.methods || methods.some((m) => fault.methods!.has(m))) && Math.random() < fault.rate;
    if (matches) {
      faults++;
      if (fault.mode === "http500") return new Response("injected 500", { status: 500 });
      if (fault.mode === "rpcerror") return Response.json(rpcErrorFor(body));
      if (fault.mode === "timeout") {
        await Bun.sleep(fault.delayMs);
        return new Response("injected gateway timeout", { status: 504 });
      }
      if (fault.mode === "slow") await Bun.sleep(fault.delayMs);
    }
    const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: text });
    return new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": "application/json" } });
  },
});

// Websocket subscriptions (web3.js confirmTransaction): a plain TCP pass-through to the validator's pubsub port.
Bun.listen<{ upstream?: Awaited<ReturnType<typeof Bun.connect>>; pending: Uint8Array[] }>({
  hostname: "127.0.0.1",
  port: port + 1,
  socket: {
    async open(client) {
      client.data = { pending: [] };
      client.data.upstream = await Bun.connect({
        hostname: "127.0.0.1",
        port: upstreamWsPort,
        socket: {
          data(_s, chunk) { client.write(chunk); },
          close() { client.end(); },
          error() { client.end(); },
        },
      });
      for (const c of client.data.pending) client.data.upstream.write(c);
      client.data.pending = [];
    },
    data(client, chunk) {
      if (client.data.upstream) client.data.upstream.write(chunk);
      else client.data.pending.push(new Uint8Array(chunk));
    },
    close(client) { client.data.upstream?.end(); },
    error(client) { client.data.upstream?.end(); },
  },
});
console.log(`fault proxy on :${port} (ws :${port + 1}) -> ${upstream}`);
