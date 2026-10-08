#!/usr/bin/env bun
// S4 ST-RG-06, in-process half: the RPC guard's pacer (PAD_RPC_MAX_PER_SECOND) under the API's own demand pattern. 40 coins, each read through
// a makeReadCache of 3 s (what dbc/read.ts does per coin view: two RPC calls per read), asked for every 50 ms for 30 s as 200 list requests a
// second would. The guard paces at 7 calls a second. Printed per second: calls started, finished, waiting (admitted but not yet attempted), and
// at the end how long a fresh call waits for its turn and how long the backlog takes to drain. A wait that grows with time is the defect.
//   bun stress/s4/pacer-backlog.ts [perSecond=7] [coins=40] [seconds=30]
import { makeReadCache } from "../../src/dbc/read";
import { makeRpcGuard } from "../../src/rpcGuard";

const perSecond = Number(process.argv[2] ?? 7);
const coins = Number(process.argv[3] ?? 40);
const seconds = Number(process.argv[4] ?? 30);
let started = 0;
let finished = 0;
const base = async (): Promise<Response> => {
  await Bun.sleep(30);
  return new Response('{"jsonrpc":"2.0","result":1,"id":1}', { status: 200 });
};
const guard = makeRpcGuard(base, { timeoutMs: 2_500, scanTimeoutMs: 20_000, sendTimeoutMs: 10_000, failuresToOpen: 3, openMs: 30_000, now: () => performance.now(), log: (l) => console.error(l), maxPerSecond: perSecond });
const call = async (): Promise<void> => {
  started++;
  try {
    await guard.fetch("http://rpc.test", { method: "POST", body: '{"jsonrpc":"2.0","method":"getAccountInfo","params":[],"id":1}' });
  } finally {
    finished++;
  }
};
const read = makeReadCache(async (_coin: number) => {
  await call();
  await call();
  return true;
}, String, 3_000);

const t0 = performance.now();
let lastLine = 0;
while (performance.now() - t0 < seconds * 1000) {
  for (let c = 0; c < coins; c++) void read(c).catch(() => undefined);
  await Bun.sleep(50);
  const sec = Math.floor((performance.now() - t0) / 1000);
  if (sec > lastLine) {
    lastLine = sec;
    console.log(JSON.stringify({ second: sec, started, finished, waiting: started - finished }));
  }
}
const waitingAtEnd = started - finished;
const f0 = performance.now();
await call();
const freshWaitMs = Math.round(performance.now() - f0);
while (started - finished > 0) await Bun.sleep(100);
const drainMs = Math.round(performance.now() - f0);
console.log(JSON.stringify({ perSecond, coins, seconds, waitingAtEnd, freshCallWaitMs: freshWaitMs, drainMs, verdict: freshWaitMs <= 2_500 ? "bounded" : "UNBOUNDED: a fresh call waited longer than its own timeout" }));
