// The RPC guard (src/rpcGuard.ts, contract v2.8.1): every Solana RPC call is one attempt with a timeout behind a circuit breaker, never web3.js's own
// retry-on-429, which on 2026-10-05 held every coin list for about 20 s when the RPC key's credits ran out. Each test builds its own guard with a fake fetch
// and a fake clock (the process's own guard is shared by every test file in this run and is never tripped here); one test goes through a real web3.js
// Connection to a local stub server that answers every call 429.
import { describe, expect, test } from "bun:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { ChainUnavailableError, isChainUnavailable, makeRpcGuard, settleWithin, withinDeadline, type RpcGuardOptions } from "../src/rpcGuard";
import { makeRpcUsage, type RpcUsageRow } from "../src/rpcUsage";

const BODY = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });
const OK = () => new Response('{"jsonrpc":"2.0","id":1,"result":7}', { status: 200 });
const TOO_MANY = () => new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}', { status: 429, statusText: "Too Many Requests" });

/** A fake fetch whose answers the test sets, counting what reached it; and a guard over it with a clock the test moves. */
function rig(over: Partial<RpcGuardOptions> = {}) {
  const clock = { now: 1_000_000 };
  const seen: string[] = [];
  const logs: string[] = [];
  let answer: (init?: RequestInit) => Promise<Response> = async () => OK();
  const base = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push(String(init?.body ?? ""));
    return answer(init);
  };
  const guard = makeRpcGuard(base, { timeoutMs: 50, scanTimeoutMs: 400, sendTimeoutMs: 200, failuresToOpen: 3, openMs: 30_000, now: () => clock.now, log: (l) => logs.push(l), ...over });
  const call = (method = "getSlot") => guard.fetch("http://rpc.test", { method: "POST", body: BODY(method) });
  return { clock, seen, logs, guard, call, setAnswer: (f: (init?: RequestInit) => Promise<Response>) => (answer = f) };
}

/** A fetch that answers only when its signal aborts (an RPC that never answers): what a hung connection looks like to the guard. */
const never = (init?: RequestInit): Promise<Response> =>
  new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

async function failure(p: Promise<unknown>): Promise<ChainUnavailableError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ChainUnavailableError);
  return err as ChainUnavailableError;
}

describe("one bounded attempt per call", () => {
  test("a 429 is one request, failed at once as rate_limited; a 5xx is http_error; a 2xx passes through unchanged", async () => {
    const r = rig();
    r.setAnswer(async () => TOO_MANY());
    expect((await failure(r.call())).reason).toBe("rate_limited");
    expect(r.seen.length).toBe(1);
    r.setAnswer(async () => new Response("bad gateway", { status: 502 }));
    expect((await failure(r.call())).reason).toBe("http_error");
    r.setAnswer(async () => OK());
    const res = await r.call();
    expect([res.status, await res.text()]).toEqual([200, '{"jsonrpc":"2.0","id":1,"result":7}']);
  });

  test("no answer within the timeout fails as timeout, even from a fetch that never honours the abort; a scan and a send get their longer timeouts", async () => {
    const r = rig();
    r.setAnswer(never);
    let t0 = performance.now();
    expect((await failure(r.call())).reason).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(300);
    r.setAnswer(() => new Promise<Response>(() => undefined)); // ignores its signal entirely
    t0 = performance.now();
    expect((await failure(r.call())).message).toContain("no answer within 50 ms");
    expect(performance.now() - t0).toBeLessThan(300);
    r.setAnswer(async () => {
      await Bun.sleep(120);
      return OK();
    });
    expect((await r.call("getProgramAccounts")).status).toBe(200); // 120 ms is inside the 400 ms scan timeout
    expect((await r.call("sendTransaction")).status).toBe(200); // and inside the 200 ms send timeout
  });

  test("a network error is a network failure", async () => {
    const r = rig();
    r.setAnswer(async () => {
      throw new TypeError("connection refused");
    });
    expect((await failure(r.call())).reason).toBe("network");
  });
});

describe("the circuit breaker", () => {
  test("three failures in a row open it: every call fails at once without reaching the RPC, for 30 s", async () => {
    const r = rig();
    r.setAnswer(async () => TOO_MANY());
    for (let i = 0; i < 3; i++) await failure(r.call());
    expect(r.guard.available()).toBe(false);
    for (let i = 0; i < 50; i++) expect((await failure(r.call())).reason).toBe("breaker_open");
    r.clock.now += 29_999;
    expect((await failure(r.call())).reason).toBe("breaker_open");
    expect(r.seen.length).toBe(3); // the 51 calls after it opened never reached the RPC
  });

  test("failures must be in a row: an answer in between starts the count again", async () => {
    const r = rig();
    for (const ok of [false, false, true, false, false, true, false, false]) {
      r.setAnswer(async () => (ok ? OK() : TOO_MANY()));
      await r.call().catch(() => undefined);
    }
    expect(r.guard.available()).toBe(true);
  });

  test("after 30 s exactly one call goes through as the probe; while it is out the others fail fast; its answer closes the breaker", async () => {
    const r = rig();
    r.setAnswer(async () => TOO_MANY());
    for (let i = 0; i < 3; i++) await failure(r.call());
    r.clock.now += 30_000;
    let release: () => void = () => undefined;
    r.setAnswer(() => new Promise<Response>((resolve) => (release = () => resolve(OK()))));
    const probe = r.call();
    for (let i = 0; i < 5; i++) expect((await failure(r.call())).reason).toBe("breaker_open");
    expect(r.seen.length).toBe(4); // the probe only
    release();
    expect((await probe).status).toBe(200);
    expect(r.guard.available()).toBe(true);
    r.setAnswer(async () => OK());
    expect((await r.call()).status).toBe(200);
  });

  test("a failed probe keeps it open for another 30 s, then probes once more", async () => {
    const r = rig();
    r.setAnswer(async () => TOO_MANY());
    for (let i = 0; i < 3; i++) await failure(r.call());
    r.clock.now += 30_000;
    expect((await failure(r.call())).reason).toBe("rate_limited"); // the probe reached the RPC and failed
    expect((await failure(r.call())).reason).toBe("breaker_open");
    r.clock.now += 30_000;
    r.setAnswer(async () => OK());
    expect((await r.call()).status).toBe(200);
    expect(r.seen.length).toBe(5);
  });

  test("a call admitted before the breaker opened neither closes it nor counts when it completes: only the probe decides (S4 ST-RG-01)", async () => {
    const r = rig();
    let calls = 0;
    r.setAnswer(async () => {
      if (calls++ === 0) {
        await Bun.sleep(40); // the first call is slow and will answer OK after the three fast 429s have opened the breaker
        return OK();
      }
      return TOO_MANY();
    });
    const slow = r.call();
    for (let i = 0; i < 3; i++) await failure(r.call());
    expect(r.guard.available()).toBe(false);
    expect((await slow).status).toBe(200); // the stale answer arrives
    expect(r.guard.available()).toBe(false); // and does not close the breaker
    expect(r.logs.filter((l) => l.includes("closed")).length).toBe(0);
    expect((await failure(r.call())).reason).toBe("breaker_open"); // still failing fast
    r.clock.now += 30_000;
    r.setAnswer(async () => OK());
    expect((await r.call()).status).toBe(200); // the probe
    expect(r.guard.available()).toBe(true);
    expect(r.logs.filter((l) => l.includes("open")).length).toBe(1);
    expect(r.logs.filter((l) => l.includes("closed")).length).toBe(1);
  });

  test("with 429s on two of every three calls completing out of order the breaker opens once and stays open until its probe, never flapping (S4 ST-RG-01)", async () => {
    const r = rig();
    let n = 0;
    r.setAnswer(async () => {
      const i = n++;
      if (i % 3 === 2) {
        await Bun.sleep(15); // the OK answers come back later than the instant 429s
        return OK();
      }
      return TOO_MANY();
    });
    const results = await Promise.allSettled(Array.from({ length: 60 }, () => r.call()));
    expect(results.some((x) => x.status === "rejected")).toBe(true);
    expect(r.logs.filter((l) => l.includes("breaker open")).length).toBe(1);
    expect(r.logs.filter((l) => l.includes("closed")).length).toBe(0);
    expect(r.guard.available()).toBe(false);
  });

  test("one log line when it opens and one when it closes, never one per call", async () => {
    const r = rig();
    r.setAnswer(async () => TOO_MANY());
    for (let i = 0; i < 40; i++) await r.call().catch(() => undefined);
    for (let probe = 0; probe < 5; probe++) {
      r.clock.now += 30_000;
      await r.call().catch(() => undefined);
    }
    r.clock.now += 30_000;
    r.setAnswer(async () => OK());
    await r.call();
    expect(r.logs.length).toBe(2);
    expect(r.logs[0]).toContain("circuit breaker open");
    expect(r.logs[0]).toContain("rate_limited");
    expect(r.logs[1]).toContain("circuit breaker closed");
  });
});

// A provider's own per-second cap (QuickNode's free plan: 15 a second, 3 for getProgramAccounts) answers 429 beyond it, and three in a row open the breaker. On
// 2026-10-05 the keeper's first holder sampling after a restart (36 coins, about 70 calls in one second) did exactly that. Paced, the same burst is spread out.
describe("pacing under a provider's per-second cap", () => {
  /** A rig whose sleeps are recorded and end at once while the fake clock stands still: a call's recorded wait is how far behind the first call of the burst it starts. */
  function paced(over: Partial<RpcGuardOptions>) {
    const slept: number[] = [];
    const r = rig({ sleep: async (ms) => void slept.push(ms), ...over });
    return { ...r, slept };
  }

  test("off unless set: a burst waits for nothing", async () => {
    const r = paced({});
    await Promise.all(Array.from({ length: 30 }, (_, i) => r.call(i % 2 ? "getSlot" : "getProgramAccounts")));
    expect(r.slept).toEqual([]);
  });

  test("a cap of 5 a second starts calls 200 ms apart: the sixth of a burst waits a whole second; after a quiet spell the next call starts at once", async () => {
    const r = paced({ maxPerSecond: 5, timeoutMs: 5_000 }); // a timeout the waits fit in: a wait past the timeout is refused (tested below)
    await Promise.all(Array.from({ length: 6 }, () => r.call()));
    expect(r.slept).toEqual([200, 400, 600, 800, 1000]);
    r.clock.now += 5_000;
    await r.call();
    expect(r.slept.length).toBe(5);
  });

  test("getProgramAccounts has its own cap; other calls are not held up by it", async () => {
    const r = paced({ scanMaxPerSecond: 1, scanTimeoutMs: 5_000 });
    await Promise.all([r.call("getProgramAccounts"), r.call("getSlot"), r.call("getProgramAccounts"), r.call("getSlot"), r.call("getProgramAccounts")]);
    expect([...r.slept].sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  test("a scan waiting for its turn holds no general turn: a getSlot behind three scans starts at once, the scans at 0, 0.5 and 1 s (real clock)", async () => {
    const r = rig({ now: Date.now, maxPerSecond: 10, scanMaxPerSecond: 2, scanTimeoutMs: 5_000 });
    const t0 = performance.now();
    const after = (p: Promise<unknown>) => p.then(() => performance.now() - t0);
    const [first, second, third, slot] = await Promise.all([after(r.call("getProgramAccounts")), after(r.call("getProgramAccounts")), after(r.call("getProgramAccounts")), after(r.call("getSlot"))]);
    expect(slot).toBeLessThan(150); // behind the scans' general turns it would have waited 300 ms
    expect(first).toBeLessThan(150);
    expect(second).toBeGreaterThanOrEqual(450);
    expect(third).toBeGreaterThanOrEqual(950);
  });

  test("the wait for a turn is not part of the call's timeout", async () => {
    const r = rig({ now: Date.now, maxPerSecond: 10, timeoutMs: 350 }); // 100 ms apart: the fourth waits 300 ms, inside the 350 ms a wait may be
    r.setAnswer(async () => {
      await Bun.sleep(200); // the attempt itself takes 200 ms: wait + attempt is 500 ms, past the timeout, and the attempt alone is not
      return OK();
    });
    const statuses = (await Promise.all(Array.from({ length: 4 }, () => r.call()))).map((res) => res.status);
    expect(statuses).toEqual([200, 200, 200, 200]);
  });

  test("an open breaker still fails at once: a call does not wait for a turn it will not use", async () => {
    const r = paced({ maxPerSecond: 1, timeoutMs: 5_000 });
    r.setAnswer(async () => TOO_MANY());
    for (let i = 0; i < 3; i++) await failure(r.call());
    const before = r.slept.length;
    expect((await failure(r.call())).reason).toBe("breaker_open");
    expect(r.slept.length).toBe(before);
  });

  test("a burst admitted while the breaker was closed does not reach the provider after the breaker has opened: a call checks it again after its wait (S4-04)", async () => {
    const r = rig({ now: Date.now, maxPerSecond: 20, timeoutMs: 1_000 }); // real clock and real waits: turns 50 ms apart, so the calls fail one after another while the rest still wait
    r.setAnswer(async () => TOO_MANY());
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => r.call()));
    const reasons = results.map((x) => (x as PromiseRejectedResult).reason.reason as string);
    expect(r.seen.length).toBe(3); // the three that opened it, and no more: before the fix all 12 reached the provider
    expect(reasons).toEqual(["rate_limited", "rate_limited", "rate_limited", ...Array<string>(9).fill("breaker_open")]);
    expect(r.logs.length).toBe(1);
  });

  test("a burst past what the cap serves inside a call's own timeout is refused at once as paced: no turn taken, nothing sent, the breaker untouched (S4 ST-RG-06)", async () => {
    const r = paced({ maxPerSecond: 4, timeoutMs: 1_000 }); // turns 250 ms apart: the turns at 0, 250, 500, 750 and 1000 ms fit a 1 s timeout, the sixth would come at 1250 ms
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => r.call()));
    const refused = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(refused.length).toBe(5);
    for (const x of refused) expect((x.reason as ChainUnavailableError).reason).toBe("paced");
    expect(refused.map((x) => (x.reason as Error).message)[0]).toContain("past this call's 1000 ms timeout");
    expect(r.seen.length).toBe(5); // the admitted five reached the RPC, the refused five did not
    expect(r.slept).toEqual([250, 500, 750, 1000]); // the refused ones took no turn
    expect(r.guard.available()).toBe(true);
    expect(isChainUnavailable(new Error("failed to get info about account: ChainUnavailableError: chain unavailable (paced): the next free turn is 1250 ms away"))).toBe(true);
    // the refusals did not count toward the breaker: it still takes three real failures in a row
    r.clock.now += 5_000;
    r.setAnswer(async () => TOO_MANY());
    expect((await failure(r.call())).reason).toBe("rate_limited");
    expect((await failure(r.call())).reason).toBe("rate_limited");
    expect(r.guard.available()).toBe(true);
    expect((await failure(r.call())).reason).toBe("rate_limited");
    expect(r.guard.available()).toBe(false);
  });

  test("a scan's longer timeout lets it wait longer for its turn than a plain call: the sixth scan at 1 a second waits 5 s inside a 20 s scan timeout", async () => {
    const r = paced({ scanMaxPerSecond: 1, maxPerSecond: 100, scanTimeoutMs: 20_000, timeoutMs: 2_500 });
    const scans = await Promise.allSettled(Array.from({ length: 6 }, () => r.call("getProgramAccounts")));
    expect(scans.every((x) => x.status === "fulfilled")).toBe(true);
    expect(r.slept.filter((ms) => ms >= 1000)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });
});

// The plan's credits are counted from here (src/rpcUsage.ts, src/rpcBudget.ts): each request that leaves the process is one call of its method.
describe("counting what leaves the process", () => {
  /** A rig whose guard counts into a counter on a fixed fake wall clock (hour 0 of 1970). */
  function counted(over: Partial<RpcGuardOptions> = {}) {
    const usage = makeRpcUsage(() => 1_000_000);
    return { usage, ...rig({ usage, ...over }) };
  }
  const totals = (rows: RpcUsageRow[]) => Object.fromEntries(rows.map((r) => [r.method, [r.calls, r.failures]]));

  test("every request that was sent is a call of its method; a 429, a 5xx, a timeout and a network error are calls and failures too", async () => {
    const r = counted({ failuresToOpen: 100 });
    await r.call("getSlot");
    await r.call("getSlot");
    await r.call("getProgramAccounts");
    r.setAnswer(async () => TOO_MANY());
    await failure(r.call("getSlot"));
    r.setAnswer(async () => new Response("bad gateway", { status: 502 }));
    await failure(r.call("getBalance"));
    r.setAnswer(never);
    await failure(r.call("getAccountInfo"));
    r.setAnswer(async () => {
      throw new TypeError("connection refused");
    });
    await failure(r.call("sendTransaction"));
    expect(totals(r.usage.take())).toEqual({ getSlot: [3, 1], getProgramAccounts: [1, 0], getBalance: [1, 1], getAccountInfo: [1, 1], sendTransaction: [1, 1] });
  });

  test("a request with no readable method is counted as unknown; a guard built without a counter counts nothing and works as before", async () => {
    const r = counted();
    await r.guard.fetch("http://rpc.test", { method: "POST", body: "not json at all" });
    expect(totals(r.usage.take())).toEqual({ unknown: [1, 0] });
    const plain = rig();
    expect((await plain.call()).status).toBe(200);
  });

  test("a call refused before it leaves costs nothing and is not counted: the breaker's fast failures, a refused pacing turn", async () => {
    const r = counted();
    r.setAnswer(async () => TOO_MANY());
    for (let i = 0; i < 3; i++) await failure(r.call());
    for (let i = 0; i < 10; i++) expect((await failure(r.call())).reason).toBe("breaker_open");
    expect(totals(r.usage.take())).toEqual({ getSlot: [3, 3] });

    const paced = counted({ maxPerSecond: 4, timeoutMs: 1_000, sleep: async () => undefined }); // turns 250 ms apart: five fit a 1 s timeout
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => paced.call()));
    expect(results.filter((x) => x.status === "rejected").length).toBe(5);
    expect(totals(paced.usage.take())).toEqual({ getSlot: [5, 0] });
  });

  test("through web3.js: its real request bodies give the method names, and a Connection makes exactly the calls the caller asked for", async () => {
    const results: Record<string, unknown> = { getSlot: 123, getAccountInfo: { context: { slot: 1 }, value: null }, getProgramAccounts: [] };
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body = (await req.json()) as { id: unknown; method: string };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: results[body.method] ?? null });
      },
    });
    const usage = makeRpcUsage(() => 1_000_000);
    const guard = makeRpcGuard(fetch, { timeoutMs: 2_000, scanTimeoutMs: 2_000, sendTimeoutMs: 2_000, failuresToOpen: 100, openMs: 30_000, now: Date.now, log: () => undefined, usage });
    const conn = new Connection(`http://127.0.0.1:${stub.port}`, { commitment: "confirmed", fetch: guard.fetch, disableRetryOnRateLimit: true });
    try {
      expect(await conn.getSlot()).toBe(123);
      expect(await conn.getAccountInfo(PublicKey.default)).toBeNull();
      expect(await conn.getProgramAccounts(PublicKey.default)).toEqual([]);
      expect(totals(usage.take())).toEqual({ getAccountInfo: [1, 0], getProgramAccounts: [1, 0], getSlot: [1, 0] });
    } finally {
      stub.stop(true);
    }
  });
});

describe("through web3.js: its own retry-on-429 is off, so a capped key costs one request per call", () => {
  test("getSlot against a server that answers every call 429: one request, a ChainUnavailableError at once, no 'Retrying after' line", async () => {
    let requests = 0;
    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (requests++, TOO_MANY()) });
    const guard = makeRpcGuard(fetch, { timeoutMs: 2_000, scanTimeoutMs: 2_000, sendTimeoutMs: 2_000, failuresToOpen: 100, openMs: 30_000, now: Date.now, log: () => undefined });
    const conn = new Connection(`http://127.0.0.1:${stub.port}`, { commitment: "confirmed", fetch: guard.fetch, disableRetryOnRateLimit: true });
    const printed: string[] = [];
    const saved = console.error;
    console.error = (...a: unknown[]) => void printed.push(a.join(" "));
    try {
      const t0 = performance.now();
      const err = await conn.getSlot().then(() => null, (e: unknown) => e);
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(isChainUnavailable(err)).toBe(true);
      expect(requests).toBe(1);
      const wrapped = await conn.getAccountInfo(PublicKey.default).then(() => null, (e: unknown) => e);
      expect(String((wrapped as Error).message)).toContain("failed to get info about account"); // web3.js re-wraps this one in a plain Error
      expect(isChainUnavailable(wrapped)).toBe(true); // and it is still recognised
      expect(requests).toBe(2);
      expect(printed.filter((l) => /Retrying after/.test(l))).toEqual([]);
    } finally {
      console.error = saved;
      stub.stop(true);
    }
  });
});

describe("telling a chain failure from any other error", () => {
  test("the error itself, one it caused, and a wrapper that kept only its text are chain failures; anything else is not", () => {
    const e = new ChainUnavailableError("timeout", "no answer within 2500 ms");
    expect(isChainUnavailable(e)).toBe(true);
    expect(isChainUnavailable(new Error("reading the pool failed", { cause: e }))).toBe(true);
    expect(isChainUnavailable(new Error(`failed to get info about account X: ${String(e)}`))).toBe(true);
    for (const other of [new Error("429 Too Many Requests"), new Error("Block not available for slot 5"), new Error("chain unavailable (made up)"), null, undefined, "chain unavailable (timeout)", 42]) {
      expect(isChainUnavailable(other)).toBe(false);
    }
  });
});

describe("waiting with a bound", () => {
  test("withinDeadline: the value in time, else a timeout ChainUnavailableError when the bound runs out; the late promise's failure is never unhandled", async () => {
    expect(await withinDeadline(Promise.resolve(5), 50)).toBe(5);
    const late = new Promise<number>((_, reject) => setTimeout(() => reject(new Error("late")), 80));
    expect((await failure(withinDeadline(late, 20))).reason).toBe("timeout");
    await Bun.sleep(100);
  });

  test("settleWithin: { ok, value } in time, { ok: false } on a rejection or when the wait runs out", async () => {
    expect(await settleWithin(Promise.resolve("v"), 50)).toEqual({ ok: true, value: "v" });
    expect(await settleWithin(Promise.reject(new Error("no")), 50)).toEqual({ ok: false });
    const t0 = performance.now();
    expect(await settleWithin(new Promise(() => undefined), 30)).toEqual({ ok: false });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
