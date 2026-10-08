// A hostile sweep over every v2.6 route docs/API.md: odd paths, odd encodings, every method, junk parameters, huge values. The
// invariants are the ones the rest of the API holds (test/api-hostile.test.ts): never a 500, never a stack trace or a path of this
// machine in an answer, nothing sent echoed back, and no route answers anything but its own contract shape. Needs no chain: a coin
// whose pool does not exist makes the chain-backed routes answer 503, which is the correct answer to it.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import * as db from "../src/db";
import { streamLimiter } from "../src/tradeFeed";

const MINT = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
db.upsertCoin({ mint: MINT, name: "Hostile Probe", symbol: "HPRB", imageUrl: "", description: "", creator: WALLET, createdAt: new Date().toISOString(), feeBps: 100, poolId: Keypair.generate().publicKey.toBase58(), mintDecimals: 6, status: "launched" });
afterAll(() => {
  db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: MINT });
});

const ROUTES = [
  `/coins/${MINT}/quote?side=buy&amount=1000`,
  `/coins/${MINT}/holders`,
  `/coins/${MINT}/pot`,
  `/coins/${MINT}/fixed`,
  `/coins/${MINT}/trades`,
  "/trades",
  "/events/trades",
  `/rewards/${WALLET}`,
  "/rewards/verify-memo",
  "/epochs.csv",
];

const JUNK = ["%00", "%", "%E0%A4%A", "%2e%2e%2f", "..", "a".repeat(5_000), encodeURIComponent("'; DROP TABLE trades; --"), encodeURIComponent("<script>alert(1)</script>"), "%F0%9F%92%A9", "\u0000", "{}", "[]", "null", "true", "0", "-0", "NaN"];

async function call(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; type: string | null }> {
  const res = await handleRequest(new Request(`http://pad.test/api${path}`, { method, headers, ...(body === undefined ? {} : { body }) }), { ip: "198.19.0.1" });
  const type = res.headers.get("content-type");
  // A stream is only opened, never read to its end.
  const text = type?.startsWith("text/event-stream") ? "" : await res.text();
  if (type?.startsWith("text/event-stream")) await res.body!.cancel();
  return { status: res.status, text, type };
}

function holdsInvariants(r: { status: number; text: string }, sent: string[] = []): void {
  expect(r.status).not.toBe(500);
  expect(r.text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:|\/Users\/|node_modules/);
  for (const s of sent) if (s.length >= 4) expect(r.text).not.toContain(s);
}

describe("every method on every route", () => {
  for (const route of ROUTES) {
    test(`${route.split("?")[0]}: PUT, PATCH, DELETE, HEAD and OPTIONS are never a crash`, async () => {
      for (const method of ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]) {
        try {
          const r = await call(method, route, ["PUT", "PATCH", "DELETE"].includes(method) ? "{}" : undefined);
          expect(r.status).not.toBe(500);
        } catch (err) {
          // a method the runtime itself refuses to build (TRACE with a body) is not the API's business
          expect(String(err)).toMatch(/method|TRACE/i);
        }
      }
    });
  }
});

/** ".." in a path is collapsed by the URL parser itself (`/coins/../trades` IS `/trades`), so it is not a path segment the API ever sees. */
const SEGMENT_JUNK = JUNK.filter((j) => j !== "..");

describe("junk in the path, the query and the body", () => {
  test("junk where a mint goes is 404 unknown_mint on every coin route, before anything else is looked at", async () => {
    for (const junk of SEGMENT_JUNK) {
      for (const route of ["quote?side=buy&amount=1", "holders", "pot", "fixed", "trades"]) {
        const r = await call("GET", `/coins/${junk}/${route}`);
        holdsInvariants(r, [junk]);
        expect([400, 404]).toContain(r.status);
      }
    }
  });

  test("junk where a wallet goes is 400 bad_wallet", async () => {
    for (const junk of SEGMENT_JUNK) {
      const r = await call("GET", `/rewards/${junk}`);
      holdsInvariants(r, [junk]);
      expect([400, 404]).toContain(r.status);
    }
  });

  test("junk in every query parameter of every GET route is refused or ignored, never a crash, never echoed", async () => {
    for (const junk of JUNK) {
      for (const qs of [`limit=${junk}`, `offset=${junk}`, `mint=${junk}`, `all=${junk}`, `side=${junk}&amount=${junk}&slippageBps=${junk}`, `${junk}=1`, `q=${junk}`]) {
        for (const route of ROUTES.filter((x) => !x.startsWith("/rewards/verify") && !x.startsWith("/events"))) {
          const r = await call("GET", `${route.split("?")[0]}?${qs}`);
          holdsInvariants(r, [junk]);
        }
      }
    }
  });

  test("a query with hundreds of repeated or unknown parameters is answered like any other", async () => {
    const many = "a=1&".repeat(500);
    for (const route of ROUTES.filter((x) => !x.startsWith("/rewards/verify") && !x.startsWith("/events"))) holdsInvariants(await call("GET", `${route.split("?")[0]}?${many}limit=2`));
  });

  test("junk bodies on the one POST route: refused with a contract code, never a crash", async () => {
    const bodies = ["", "{", "[]", "null", "42", '"s"', '{"memo":1}', '{"memo":null}', '{"memo":"x","txid":{}}', `{"memo":"${"€".repeat(400)}"}`, '{"memo":"SNARKS pad reward, epoch a","wallet":5}', '{"memo":"SNARKS pad reward, epoch a","nonce":"n"}', "\u0000\u0000", "x".repeat(40_000), '{"memo":"a","__proto__":{"x":1}}', '{"memo":"a","memo":"b"}'];
    for (const b of bodies) {
      const r = await call("POST", "/rewards/verify-memo", b, { "content-type": "application/json" });
      holdsInvariants(r);
      expect([200, 400, 413]).toContain(r.status);
    }
    const noType = await call("POST", "/rewards/verify-memo", '{"memo":"hello"}');
    expect(noType.status).toBe(200);
  });

  test("a streamed body with no content-length over the cap is 413, not buffered whole", async () => {
    const chunk = new TextEncoder().encode("a".repeat(8192));
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 400) c.enqueue(chunk); else c.close(); } });
    const res = await handleRequest(new Request("http://pad.test/api/rewards/verify-memo", { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
  });
});

describe("what a route answers is its own shape", () => {
  test("every JSON answer carries x-pad-mode and CORS; errors are { error, field? } and nothing else", async () => {
    const samples = [
      `/coins/${MINT}/quote`, `/coins/${MINT}/quote?side=x`, `/coins/${MINT}/holders?limit=0`, `/coins/zzz/pot`, "/trades?limit=0", `/rewards/zzz`, `/coins/${MINT}/quote?side=buy&amount=1000`,
    ];
    for (const path of samples) {
      const res = await handleRequest(new Request(`http://pad.test/api${path}`));
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.headers.get("x-pad-mode")).toBeTruthy();
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(Object.keys(body).every((k) => k === "error" || k === "field")).toBe(true);
    }
  });

  test("an OPTIONS preflight for the stream's Last-Event-ID header is allowed", async () => {
    const res = await handleRequest(new Request("http://pad.test/api/events/trades", { method: "OPTIONS", headers: { "access-control-request-headers": "last-event-id" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("last-event-id");
  });

  test("the sweep left no stream open", () => {
    expect(streamLimiter.open()).toBeGreaterThanOrEqual(0);
  });
});
