// Every Solana RPC call of the engine goes through this guard: src/solana.ts hands `rpcGuard.fetch` to web3.js as its `fetch`, with web3.js's own
// retry-on-429 turned off. That retry (four more tries per call, 0.5 + 1 + 2 + 4 s apart) held every coin list for about 20 s on 2026-10-05 when the RPC
// key's credits ran out, and logged a line per try docs/API.md "Changes in v2.8.1"). What the guard does instead:
//  - one attempt per call, with a timeout: PAD_RPC_TIMEOUT_MS (2.5 s), a getProgramAccounts scan PAD_RPC_SCAN_TIMEOUT_MS (20 s), a send or a simulation
//    PAD_RPC_SEND_TIMEOUT_MS (10 s);
//  - an answer that is not 2xx (a 429, a 5xx), no answer in time, or a network error is a ChainUnavailableError, thrown at once;
//  - a circuit breaker: after PAD_RPC_BREAKER_FAILURES (3) failures in a row every call fails at once, without touching the network, for
//    PAD_RPC_BREAKER_OPEN_MS (30 s); then one call goes through as a probe: an answer closes the breaker, a failure keeps it open another 30 s.
//    Only the probe decides: a call admitted before the breaker opened neither closes it nor counts when it completes (S4 stress ST-RG-01: with 429s
//    on two of every three calls, in-flight answers closed the breaker at once and it opened 86 times in 12 s, one log line each way).
//  - optional pacing, off unless set: PAD_RPC_MAX_PER_SECOND for every call and PAD_RPC_SCAN_MAX_PER_SECOND for getProgramAccounts, each a most-per-second
//    this process starts. A provider's own per-second cap answers 429 beyond it (QuickNode's free plan: 15 a second, 3 for getProgramAccounts), and three
//    of those in a row would open the breaker for 30 s; paced, a burst (the keeper sampling every coin at once) is spread out instead. A call waits for its
//    turn before its attempt starts, so the wait is not part of its timeout. The API and the keeper pace themselves, so their caps add up.
//    A burst larger than the cap can serve inside a call's own timeout is not queued: a call whose turn would come later than its timeout fails at
//    once as `paced`, taking no turn and not counting toward the breaker (the chain did not fail), so the queue never holds more than timeout x cap
//    calls and a view falls back to the database instead of waiting minutes (S4 stress ST-RG-06: 350 queued calls and a 50 s wait after 30 s of list load).
//    The breaker is checked twice: before a call takes a turn (an open breaker fails it at once) and again after it has waited for it (a burst admitted while the breaker
//    was closed finds it open once its first calls have failed, instead of reaching the provider through it: S4-04).
// It logs one line when the breaker opens and one when it closes, never a line per call. Nothing here reads or prints the RPC address.
// Each request that leaves the process is counted per method, calls and failures, for the plan's credit budget (src/rpcUsage.ts, flushed hourly by src/rpcBudget.ts);
// a call the guard refuses before it leaves (breaker open, no pacing turn) is not counted: it cost nothing.

import { makeRpcUsage, type RpcUsage } from "./rpcUsage";

export type ChainFailure = "rate_limited" | "http_error" | "timeout" | "network" | "breaker_open" | "paced";

/** The chain could not be read: the RPC answered 429 or another error status, did not answer in time, could not be reached, or the breaker is open. */
export class ChainUnavailableError extends Error {
  constructor(
    readonly reason: ChainFailure,
    detail: string,
  ) {
    super(`chain unavailable (${reason}): ${detail}`);
    this.name = "ChainUnavailableError";
  }
}

// web3.js re-throws some failures as a new Error with the old one in its text ("failed to get info about account X: ChainUnavailableError: chain unavailable (...)").
const CHAIN_UNAVAILABLE_TEXT = /chain unavailable \((rate_limited|http_error|timeout|network|breaker_open|paced)\)/;

/** True when `err`, or an error it wraps (`cause`, a few levels), says the chain could not be read; also when a wrapper kept only its message. */
export function isChainUnavailable(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 4; depth++) {
    if (e instanceof ChainUnavailableError || CHAIN_UNAVAILABLE_TEXT.test(e.message)) return true;
    e = e.cause;
  }
  return false;
}

export interface RpcGuardOptions {
  timeoutMs: number;
  scanTimeoutMs: number;
  sendTimeoutMs: number;
  failuresToOpen: number;
  openMs: number;
  now: () => number;
  log: (line: string) => void;
  /** Most calls started per second, 0 or unset for no cap. */
  maxPerSecond?: number;
  /** Most getProgramAccounts calls started per second, 0 or unset for no cap. */
  scanMaxPerSecond?: number;
  /** Resolves after `ms`; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Counts each request that leaves the process, by method (calls and failures); none when unset. */
  usage?: RpcUsage;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RpcGuard {
  /** A `fetch` for web3.js's Connection: one bounded attempt behind the breaker. */
  fetch: typeof fetch;
  /** False while the breaker is open or its one probe is out: a caller that can answer without the chain should not wait for it. */
  available(): boolean;
}

const METHOD = /"method"\s*:\s*"([A-Za-z]+)"/;
const SENDS = new Set(["sendTransaction", "simulateTransaction", "requestAirdrop"]);

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 200);
}

/** The request and its whole body. A non-2xx answer and a network error are ChainUnavailableErrors. */
async function exchange(base: FetchLike, input: string | URL | Request, init: RequestInit): Promise<Response> {
  let res: Response;
  let text: string;
  try {
    res = await base(input, init);
    text = await res.text();
  } catch (err) {
    throw new ChainUnavailableError("network", messageOf(err));
  }
  if (!res.ok) throw new ChainUnavailableError(res.status === 429 ? "rate_limited" : "http_error", `HTTP ${res.status} ${text.slice(0, 300)}`);
  return new Response(text, { status: res.status, statusText: res.statusText });
}

/** One request with a timeout that covers the body too. At the timeout the request is aborted and the call fails, whether or not the fetch honours the abort. */
async function attempt(base: FetchLike, input: string | URL | Request, init: RequestInit | undefined, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new ChainUnavailableError("timeout", `no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([exchange(base, input, { ...init, signal: ctrl.signal }), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hands out start times at least 1000 / `perSecond` ms apart, so a caller waits for its turn and a burst is spread out. A turn that would come later than
 * `maxWaitMs` (the call's own timeout) is refused at once as `paced` and takes no turn, so the queue never holds more than maxWaitMs x perSecond calls.
 * No cap when `perSecond` is not above 0.
 */
function makePacer(perSecond: number | undefined, now: () => number, sleep: (ms: number) => Promise<void>): (maxWaitMs: number) => Promise<void> {
  if (!perSecond || !(perSecond > 0)) return async () => undefined;
  const gapMs = 1000 / perSecond;
  let nextFreeMs = 0;
  return async (maxWaitMs) => {
    const t = now();
    const at = Math.max(t, nextFreeMs);
    if (at - t > maxWaitMs) throw new ChainUnavailableError("paced", `the next free turn is ${Math.round(at - t)} ms away, past this call's ${maxWaitMs} ms timeout`);
    nextFreeMs = at + gapMs;
    if (at > t) await sleep(at - t);
  };
}

export function makeRpcGuard(base: FetchLike, opts: RpcGuardOptions): RpcGuard {
  let phase: "closed" | "open" | "probing" = "closed";
  let failures = 0;
  let openedAtMs = 0;
  /** Bumped each time the breaker opens: a call admitted under an older generation completes as stale evidence and is ignored. */
  let generation = 0;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paceCalls = makePacer(opts.maxPerSecond, opts.now, sleep);
  const paceScans = makePacer(opts.scanMaxPerSecond, opts.now, sleep);

  const breakerOpen = () => new ChainUnavailableError("breaker_open", `${failures} failures in a row; the next probe is at most ${opts.openMs / 1000} s away`);

  /** Lets a call through, or throws breaker_open. The first call after the open period is the probe (true); the others keep failing until it answers. */
  function admit(): boolean {
    if (phase === "closed") return false;
    if (phase === "open" && opts.now() - openedAtMs >= opts.openMs) {
      phase = "probing";
      return true;
    }
    throw breakerOpen();
  }

  function succeeded(gen: number): void {
    if (gen !== generation) return; // admitted before the breaker opened: says nothing about the chain since
    if (phase !== "closed") opts.log("[rpc] the chain answers again: circuit breaker closed");
    phase = "closed";
    failures = 0;
  }

  function failed(err: ChainUnavailableError, gen: number): void {
    if (gen !== generation) return;
    failures++;
    const opens = phase === "probing" || (phase === "closed" && failures >= opts.failuresToOpen);
    if (!opens) return;
    if (phase === "closed") opts.log(`[rpc] ${err.message}; ${failures} failures in a row: circuit breaker open, failing fast, one probe every ${opts.openMs / 1000} s`);
    phase = "open";
    openedAtMs = opts.now();
    generation++;
  }

  const methodOf = (init: RequestInit | undefined): string | undefined => (typeof init?.body === "string" ? METHOD.exec(init.body)?.[1] : undefined);

  function timeoutFor(method: string | undefined): number {
    if (method === "getProgramAccounts") return opts.scanTimeoutMs;
    return method && SENDS.has(method) ? opts.sendTimeoutMs : opts.timeoutMs;
  }

  async function guarded(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const probe = admit(); // a call that finds the breaker open does not wait for a turn it will not use
    const method = methodOf(init);
    const timeoutMs = timeoutFor(method);
    if (method === "getProgramAccounts") await paceScans(timeoutMs); // the scan's own turn first, so it holds no general turn while it waits
    await paceCalls(timeoutMs); // throws `paced` before the try: a refused turn is not a chain failure and never counts toward the breaker
    if (!probe && phase !== "closed") throw breakerOpen(); // it may have opened while this call waited for its turn: a burst admitted while it was closed must not go through it (S4-04)
    const gen = generation;
    let answered = false;
    try {
      const res = await attempt(base, input, init, timeoutMs);
      succeeded(gen);
      answered = true;
      return res;
    } catch (err) {
      const e = err instanceof ChainUnavailableError ? err : new ChainUnavailableError("network", messageOf(err));
      failed(e, gen);
      throw e;
    } finally {
      opts.usage?.record(method ?? "unknown", !answered);
    }
  }

  return { fetch: Object.assign(guarded, { preconnect: fetch.preconnect }), available: () => phase === "closed" };
}

/** A positive number from the environment, else `fallback`. */
function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const RPC_TIMEOUT_MS = envNumber("PAD_RPC_TIMEOUT_MS", 2_500);
export const RPC_BREAKER_OPEN_MS = envNumber("PAD_RPC_BREAKER_OPEN_MS", 30_000);

/** What this process's guard has counted since its last flush into the database (src/rpcBudget.ts). */
export const rpcUsage = makeRpcUsage();

/** The guard of this process's Connection (src/solana.ts). */
export const rpcGuard = makeRpcGuard(fetch, {
  timeoutMs: RPC_TIMEOUT_MS,
  scanTimeoutMs: envNumber("PAD_RPC_SCAN_TIMEOUT_MS", 20_000),
  sendTimeoutMs: envNumber("PAD_RPC_SEND_TIMEOUT_MS", 10_000),
  failuresToOpen: envNumber("PAD_RPC_BREAKER_FAILURES", 3),
  openMs: RPC_BREAKER_OPEN_MS,
  now: () => performance.now(), // monotonic: a step of the wall clock must not stretch the breaker's open time or a pacing turn
  log: (line) => console.error(line),
  maxPerSecond: envNumber("PAD_RPC_MAX_PER_SECOND", 0),
  scanMaxPerSecond: envNumber("PAD_RPC_SCAN_MAX_PER_SECOND", 0),
  usage: rpcUsage,
});

/** `p`, or a ChainUnavailableError once `ms` have passed: a route that needs the chain answers inside its budget even when a read behind it is still waiting
 * (that read is left to its own timeout, not cancelled). */
export function withinDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ChainUnavailableError("timeout", `no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export type Settled<T> = { ok: true; value: T } | { ok: false };

/** Waits for `p` at most `ms`: its value when it resolves in time, else `{ ok: false }` (it rejected, or the wait ran out; it keeps running either way). */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  const settled = p.then((value): Settled<T> => ({ ok: true, value }), (): Settled<T> => ({ ok: false }));
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}
