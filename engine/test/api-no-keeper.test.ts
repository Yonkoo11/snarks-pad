// INV-17 (audit/THREAT-MODEL.md): no public API route may load or use the
// keeper key. Before the DBC port, GET /api/coins/:mint could make the keeper
// sign. Two proofs:
//  1. static: nothing reachable from src/api.ts imports the keeper module or the
//     keeper-side modules (setup, claim, claimers, squads, epoch engine);
//  2. dynamic: every route is run in a subprocess whose keeper key path cannot
//     be created, so any attempt to load the keeper key turns into a 500.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { VersionedTransaction } from "@solana/web3.js";

const SRC = resolve(import.meta.dir, "../src");
const KEEPER_SIDE = ["keeper.ts", "dbc/setup.ts", "dbc/claim.ts", "dbc/claimers.ts", "dbc/squads.ts", "epoch/engine.ts", "epoch/solanaPayout.ts", "swap/simulated.ts"];

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(c)) return c;
  return null;
}

/** Every src file reachable from `entry` through static and dynamic relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) {
      const next = resolveImport(file, m[1]!);
      if (next) stack.push(next);
    }
  }
  return seen;
}

describe("INV-17: the HTTP API never touches the keeper key", () => {
  test("static: no keeper-side module is reachable from src/api.ts", () => {
    const files = [...reachable(join(SRC, "api.ts"))].map((f) => f.slice(SRC.length + 1));
    expect(files).toContain("dbc/launch.ts"); // the walk really covers the launch route
    expect(files).toContain("holders.ts");
    for (const forbidden of KEEPER_SIDE) expect(files).not.toContain(forbidden);
  });

  test("static: no file reachable from src/api.ts mentions loadKeeperKeypair", () => {
    for (const f of reachable(join(SRC, "api.ts"))) expect(readFileSync(f, "utf8")).not.toMatch(/loadKeeperKeypair/);
  });
});

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

describe.if(await validatorUp())("INV-17 dynamic: every route runs with a keeper key that cannot be loaded", () => {
  test("no route answers 500 when the keeper key path is unusable", async () => {
    // A launched coin so the coin routes have something real to read and trade.
    await ensureDbcConfig();
    const creator = Keypair.generate();
    await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
    const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Probe", symbol: "PRB", description: "", imageUrl: "", initialBuyZats: "20000000" });
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
    tx.sign([creator]);
    const sig = await getConnection().sendRawTransaction(tx.serialize());
    await getConnection().confirmTransaction(sig, "confirmed");
    await confirmLaunch(sig, mint);

    const proc = Bun.spawnSync(["bun", "test/helpers/api-routes-probe.ts"], {
      cwd: config.paths.engineRoot,
      env: { ...process.env, KEEPER_KEYPAIR_PATH: "/nonexistent-dir-for-inv17/keeper.json", PROBE_MINT: mint, PROBE_WALLET: creator.publicKey.toBase58() },
      stdout: "pipe", stderr: "pipe",
    });
    const rows = proc.stdout.toString().trim().split("\n").filter((l) => l.startsWith("[")).map((l) => JSON.parse(l) as [string, string, number]);
    expect(rows.length).toBe(23);
    expect(rows.filter(([, , status]) => status >= 500)).toEqual([]);
    const statusOf = (method: string, path: string) => rows.find(([m, p]) => m === method && p === path)![2];
    expect(statusOf("GET", "/api/coins")).toBe(200);
    expect(statusOf("GET", "/api/coins/:mint")).toBe(200); // the route that used to make the keeper sign
    expect(statusOf("POST", "/api/coins/launch-tx")).toBe(200);
    expect(statusOf("POST", "/api/coins/:mint/trade-tx")).toBe(200);
    expect(statusOf("POST", "/api/faucet")).toBe(404); // local mode has no faucet route
    // contract v2.6: every new view answers on a launched coin with the keeper key unusable
    for (const path of ["/api/coins/:mint/quote", "/api/coins/:mint/holders", "/api/coins/:mint/pot", "/api/coins/:mint/fixed", "/api/coins/:mint/trades", "/api/trades", "/api/rewards/:wallet", "/api/epochs.csv", "/api/events/trades"]) {
      expect([path, statusOf("GET", path)]).toEqual([path, 200]);
    }
    expect(statusOf("POST", "/api/rewards/verify-memo")).toBe(200);
    // contract v2.9: the signed status read refuses a signature that is not the wallet's (never a 500), the wallet's profile data is read from the database alone
    expect(statusOf("POST", "/api/optin/status")).toBe(400);
    expect(statusOf("GET", "/api/wallets/:wallet")).toBe(200);
  }, 120_000);
});
