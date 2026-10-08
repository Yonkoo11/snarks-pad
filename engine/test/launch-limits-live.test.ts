// S4-05 against the real local validator (skipped when it is not reachable): a launch writes its metadata file and its coin row only once its transaction has
// been built, so a launch that cannot be built leaves nothing behind, and one that is built from an address counts against that address's cap on unconfirmed
// launches until it is confirmed or dropped (src/dbc/launch.ts, src/api/launchLimits.ts, docs/API.md v2.8.2.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from "../src/api";
import { CAP_RETRY_AFTER_S, MAX_PENDING_PER_IP, clearLaunchLimits, reserveLaunch } from "../src/api/launchLimits";
import * as db from "../src/db";
import { buildLaunchTx } from "../src/dbc/launch";
import { ensureDbcConfig } from "../src/dbc/setup";
import { removeMetadata } from "../src/publicFiles/metadata";
import { metadataDir } from "../src/publicFiles/paths";
import { ChainUnavailableError } from "../src/rpcGuard";
import { getConnection } from "../src/solana";
import { validatorUp } from "./helpers/validator-up";

const B = "http://pad.test/api";
const key = () => Keypair.generate().publicKey.toBase58();
const made: string[] = [];
const filesIn = (dir: string): number => (existsSync(dir) ? readdirSync(dir).length : 0);
const launch = { name: "Order", symbol: "ORD", description: "", imageUrl: "" };

afterEach(() => {
  clearLaunchLimits();
  for (const m of made.splice(0)) {
    db.deleteUnconfirmedCoin(m);
    removeMetadata(m);
  }
});

describe.if(await validatorUp())("a launch that is not built leaves nothing behind (live validator)", () => {
  // A creator with SOL: since contract v2.9.1 the engine simulates a launch before answering and refuses a wallet that cannot pay (needs_sol), so the
  // launches these tests build need a funded creator. What they test (rows, files, caps) is unchanged.
  let funded = "";
  beforeAll(async () => {
    const kp = Keypair.generate();
    const conn = getConnection();
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL), "confirmed");
    funded = kp.publicKey.toBase58();
  });

  /** Runs `body` with the connection's blockhash read replaced: `onAsk` runs when the transaction asks for it (while it is being built), then it answers or throws. */
  async function withBlockhash<T>(onAsk: () => void, fail: Error | null, body: () => Promise<T>): Promise<T> {
    const conn = getConnection();
    const original = conn.getLatestBlockhash.bind(conn);
    conn.getLatestBlockhash = (async (...args: Parameters<typeof original>) => {
      onAsk();
      if (fail) throw fail;
      return original(...args);
    }) as typeof original;
    try {
      return await body();
    } finally {
      conn.getLatestBlockhash = original;
    }
  }

  test("the metadata file and the coin row appear only after the transaction is built: none exists while it is still being built", async () => {
    await ensureDbcConfig();
    const dir = metadataDir();
    const filesBefore = filesIn(dir);
    const pendingBefore = db.countPendingCoins();
    let during = { files: -1, pending: -1 };
    const out = await withBlockhash(() => (during = { files: filesIn(dir), pending: db.countPendingCoins() }), null, () => buildLaunchTx({ creator: funded, ...launch }));
    made.push(out.mint);
    expect(during).toEqual({ files: filesBefore, pending: pendingBefore }); // before: the file was written first, so it was already there
    expect(existsSync(join(dir, `${out.mint}.json`))).toBe(true);
    expect(db.getCoin(out.mint)?.status).toBe("pending");
    expect(filesIn(dir)).toBe(filesBefore + 1);
  });

  test("a transaction that cannot be built (the chain does not answer) leaves no file and no row", async () => {
    await ensureDbcConfig();
    const dir = metadataDir();
    const filesBefore = filesIn(dir);
    const pendingBefore = db.countPendingCoins();
    const down = new ChainUnavailableError("rate_limited", "HTTP 429 Too Many Requests");
    await expect(withBlockhash(() => undefined, down, () => buildLaunchTx({ creator: funded, ...launch }))).rejects.toBe(down);
    expect(filesIn(dir)).toBe(filesBefore);
    expect(db.countPendingCoins()).toBe(pendingBefore);
  });

  test("through the API: a launch that is built takes one of its address's 20 places until it is confirmed; the 21st call is refused 429 with retry-after, nothing built", async () => {
    await ensureDbcConfig();
    const ip = "203.0.113.50";
    for (let i = 0; i < MAX_PENDING_PER_IP - 1; i++) {
      const r = reserveLaunch(ip);
      if (!r.ok) throw new Error("refused early");
      const mint = key();
      made.push(mint);
      db.upsertCoin({ mint, name: "Held", symbol: "HLD", imageUrl: "", description: "", creator: key(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
      r.slot.built(mint);
    }
    const ask = () => handleRequest(new Request(`${B}/coins/launch-tx`, { method: "POST", body: JSON.stringify({ creator: funded, ...launch }), headers: { "content-type": "application/json" } }), { ip });
    const ok = await ask();
    expect(ok.status).toBe(200);
    made.push(((await ok.json()) as { mint: string }).mint);
    const filesAfterOk = filesIn(metadataDir());
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(CAP_RETRY_AFTER_S));
    expect(filesIn(metadataDir())).toBe(filesAfterOk); // refused before anything was built or written
  });
});
