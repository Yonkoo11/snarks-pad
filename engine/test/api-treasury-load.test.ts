// Stress API load (audit/STRESS-REPORT.md D6): every GET /treasury ran zcash-devtool synchronously (Bun.spawnSync)
// inside the API process. At about 100 requests/s the event loop spent its time waiting on devtool and every route
// slowed together (even GET /tiers, which reads no chain: p50 0.8 s at 100 rps, 27 s at 200 rps). It also let anyone
// start one treasury-wallet process per request, next to the keeper's own devtool on the same wallet.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";

async function regtestUp(): Promise<boolean> {
  if (!config.isLocal) return false;
  try {
    const r = await fetch(config.zcash.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getblockcount", params: [] }), signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe.if(await regtestUp())("GET /treasury under load", () => {
  test("40 concurrent requests read the treasury wallet at most twice and do not hold up other routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "treasury-load-"));
    writeFileSync(join(dir, "real-devtool"), config.paths.zcashDevtoolBin);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const api = Bun.spawn(["bun", "scripts/api.ts"], {
      env: { ...process.env, PAD_DB_FILE: join(dir, "t.sqlite"), PAD_API_PORT: String(port), PAD_API_HOST: "127.0.0.1", ZCASH_DEVTOOL_BIN: join(import.meta.dir, "helpers", "devtool-count.sh"), TMPDIR: dir },
      stdout: "ignore", stderr: "ignore",
    });
    try {
      const base = `http://127.0.0.1:${port}/api`;
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${base}/tiers`)).ok) break; } catch { /* starting */ }
        await Bun.sleep(100);
      }
      const t0 = performance.now();
      const treasury = Array.from({ length: 40 }, () => fetch(`${base}/treasury`).then((r) => r.status));
      await Bun.sleep(20);
      const tiers = await Promise.all(Array.from({ length: 10 }, async () => {
        const t = performance.now();
        await (await fetch(`${base}/tiers`)).text();
        return performance.now() - t;
      }));
      const statuses = await Promise.all(treasury);
      const calls = existsSync(join(dir, "devtool-calls")) ? readFileSync(join(dir, "devtool-calls"), "utf8").split("\n").filter((l) => l.includes(" balance")).length : 0;
      console.log(`treasury x40 in ${Math.round(performance.now() - t0)} ms, devtool balance calls ${calls}, /tiers max ${Math.round(Math.max(...tiers))} ms`);
      expect(statuses.every((s) => s === 200)).toBe(true);
      expect(calls).toBeLessThanOrEqual(2);
      expect(Math.max(...tiers)).toBeLessThan(250);
    } finally {
      api.kill();
    }
  }, 120_000);
});
