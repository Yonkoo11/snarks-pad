// The 2026-10-05 incident docs/API.md "Changes in v2.8.1"): the RPC key's credits ran out, every call was answered 429, and GET /api/coins hung for
// about 20 s while web3.js retried each call, so the proxy answered 502. Now the views a page needs come from the database within 2 s whatever the chain
// does, and the routes that need the chain answer 503 chain_unavailable within 5 s. The API runs in its own process (its own RPC circuit breaker and its own
// database: nothing here touches the shared test database or this process's breaker), pointed at a stub RPC that answers every call 429, then at one that
// never answers. Every request is timed from this side, over HTTP.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { windowScheduleOf } from "../src/dbc/reviewed";

const ROOT = config.paths.engineRoot;
const files: string[] = [];
afterAll(() => {
  for (const f of files) rmSync(f, { recursive: true, force: true });
});

type Mode = "429" | "hang";

function stubRpc(mode: Mode) {
  const seen = { requests: 0 };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      seen.requests++;
      await req.text();
      if (mode === "hang") await Bun.sleep(60_000);
      return new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}', { status: 429, statusText: "Too Many Requests" });
    },
  });
  if (server.port === undefined) throw new Error("the stub RPC has no port");
  return { server, port: server.port, seen };
}

/** Reads the helper's stdout until its READY line. */
async function ready(stdout: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stdout.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the API process ended before it was ready: ${text}`);
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.startsWith("READY "));
    if (line) {
      reader.releaseLock();
      return line.trim().split(" ").slice(1);
    }
  }
}

async function startApi(mode: Mode, rpcPort: number) {
  const dbFile = join(ROOT, "data", `test-chain-down-${mode}-${process.pid}.sqlite`);
  const publicDir = join(ROOT, "data", `public-test-chain-down-${mode}-${process.pid}`);
  files.push(dbFile, `${dbFile}-wal`, `${dbFile}-shm`, publicDir);
  const proc = Bun.spawn(["bun", "test/helpers/api-chain-down.ts"], {
    cwd: ROOT,
    env: { ...process.env, PAD_MODE: "local", SOLANA_LOCAL_RPC: `http://127.0.0.1:${rpcPort}`, PAD_DB_FILE: dbFile, PUBLIC_DIR: publicDir, PAD_FEATURED_MINTS: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const [port, withFacts, older, wallet, pending] = (await ready(proc.stdout)) as [string, string, string, string, string];
  return { proc, base: `http://127.0.0.1:${port}/api`, withFacts, older, wallet, pending };
}

async function timed(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, ms: performance.now() - t0 };
}

const POOL_FIELDS = ["priceZec", "marketCapZec", "curveProgress"];
const STEPS = windowScheduleOf(100).feeByPeriodBps; // 9900, 7940, 5980, 4020, 2060, 100

describe.each(["429", "hang"] as const)("the chain cannot be read (an RPC that %s)", (mode) => {
  test(`views answer 200 from the database within 2 s; chain routes answer 503 chain_unavailable within 5 s; no retry storm (${mode})`, async () => {
    const rpc = stubRpc(mode);
    const api = await startApi(mode, rpc.port);
    try {
      // the coin page first, while the coin's window is still open: the window and the fee now come from the stored facts and the clock, not the chain
      const page = await timed(api.base, "GET", `/coins/${api.withFacts}`);
      expect([page.status, page.ms < 2_000]).toEqual([200, true]);
      expect(page.body.launchWindow).toMatchObject({ cliffBps: 9900, endBps: 100, periods: 5, periodSeconds: 1 });
      const left = Number(page.body.windowSecondsLeft);
      expect(left).toBeGreaterThan(0);
      expect(page.body.feeNowBps).toBe(STEPS[Math.max(0, 5 - left)]); // the step of the second the countdown is in
      expect(page.body.holders).toBe(2); // the keeper's sample
      for (const f of POOL_FIELDS) expect(page.body).not.toHaveProperty(f); // never read, so absent (not 0)
      expect([page.body.stage, page.body.venue, page.body.priceChange24hBps, page.body.trades24h]).toEqual(["curve", "meteora-dbc", null, 1]);

      const list = await timed(api.base, "GET", "/coins");
      expect([list.status, list.ms < 2_000, list.body.total]).toEqual([200, true, 2]);
      const listed = new Map((list.body.coins as Record<string, unknown>[]).map((c) => [c.mint as string, c]));
      expect(listed.get(api.withFacts)).toMatchObject({ holders: 2, launchWindow: page.body.launchWindow });
      expect(listed.get(api.older)).not.toHaveProperty("launchWindow"); // no stored facts and no chain read: not known, so not sent

      const old = await timed(api.base, "GET", `/coins/${api.older}`);
      expect([old.status, old.ms < 2_000, old.body.feeNowBps, old.body.windowSecondsLeft, old.body.holders]).toEqual([200, true, null, 0, null]);

      for (const path of ["/stats", "/tiers", "/epochs", "/trades", `/coins/${api.withFacts}/trades`, `/coins/${api.withFacts}/price-history`, `/rewards/${api.wallet}`]) {
        const r = await timed(api.base, "GET", path);
        expect([path, r.status, r.ms < 2_000]).toEqual([path, 200, true]);
      }

      const chainRoutes: [string, string, unknown?][] = [
        ["GET", `/coins/${api.withFacts}/quote?side=buy&amount=1000000`],
        ["GET", `/coins/${api.withFacts}/pot`],
        ["GET", `/coins/${api.withFacts}/fixed`],
        ["POST", `/coins/${api.withFacts}/trade-tx`, { wallet: api.wallet, side: "buy", amount: "1000000", slippageBps: 100 }],
        ["POST", "/coins/launch-tx", { creator: api.wallet, name: "Probe", symbol: "PRB", description: "", imageUrl: "", initialBuyZec: "1000000" }],
      ];
      for (const [method, path, body] of chainRoutes) {
        const r = await timed(api.base, method, path, body);
        expect([path, r.status, r.body.error, r.ms < 5_000]).toEqual([path, 503, "chain_unavailable", true]);
      }
      // the routes that wait on a signature or read the pool's creator: 503 chain_unavailable, never a bare 500
      const sig = "1".repeat(64); // 64 zero bytes in base58: a well-formed signature no transaction has
      for (const [method, path, body] of [
        ["POST", "/coins/confirm", { sig, mint: api.pending }], // a launch not confirmed yet: confirm reads the chain
        ["POST", `/coins/${api.withFacts}/trade-confirm`, { sig }],
        ["GET", `/coins/${api.withFacts}/creator-fees`],
        ["POST", `/coins/${api.withFacts}/creator-claim-tx`, { wallet: api.wallet }],
      ] as [string, string, unknown?][]) {
        const r = await timed(api.base, method, path, body);
        expect([path, r.status, r.body.error]).toEqual([path, 503, "chain_unavailable"]);
      }
      // holders: the wallets come from the keeper's sample; only the pool vault part needs the chain, and it is left out
      const holders = await timed(api.base, "GET", `/coins/${api.withFacts}/holders`);
      expect([holders.status, holders.ms < 5_000, holders.body.holdersCount, holders.body.poolPct]).toEqual([200, true, 2, null]);

      // one attempt per call and a breaker that opened after three: a handful of requests reached the RPC, not one per retry
      expect(rpc.seen.requests).toBeLessThanOrEqual(8);
    } finally {
      api.proc.kill();
      rpc.server.stop(true);
    }
    const stderr = await new Response(api.proc.stderr).text();
    expect(stderr).not.toContain("Retrying after");
    expect(stderr.match(/circuit breaker open/g)?.length).toBe(1);
  }, 60_000);
});
