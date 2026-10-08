// Audit S2 PoCs on unauthenticated cost (hypothesis H10).
//   S2-09  GET /optin/nonce writes a DB row per call, forever
//   S2-10  two concurrent faucet requests for one wallet both pass the cooldown
//   S2-11  caller-chosen signature waits and the holder count each spend the shared RPC quota without a bound
import { afterEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as api from "../src/api";
import * as db from "../src/db";
import { faucetFund } from "../src/faucet";
import { getConnection } from "../src/solana";

const BASE = "http://pad.test";
const conn = getConnection();
const realStatuses = conn.getSignatureStatuses.bind(conn);
const realGpa = conn.getProgramAccounts.bind(conn);
const realInfo = conn.getAccountInfo.bind(conn);
afterEach(() => {
  conn.getSignatureStatuses = realStatuses;
  conn.getProgramAccounts = realGpa;
  conn.getAccountInfo = realInfo;
});

const nonceRows = (wallet: string) => (db.getDb().query("SELECT COUNT(*) AS n FROM nonces WHERE wallet = $w").get({ $w: wallet }) as { n: number }).n;

describe("audit S2: unauthenticated cost (H10)", () => {
  test("S2-09: nonces for one wallet are bounded, and expired nonces are dropped", async () => {
    // Audit S6 (lens 1-02): no per-wallet rule any more (an eviction let a stranger's five requests in a victim's name make the
    // victim's nonce stale; a per-wallet cap would let them lock the victim out). The bounds are the 10-minute life, the
    // per-address limit on the route and the table-wide cap.
    const wallet = Keypair.generate().publicKey.toBase58();
    for (let i = 0; i < 50; i++) expect((await api.handleRequest(new Request(`${BASE}/api/optin/nonce?wallet=${wallet}`))).status).toBe(200);
    expect(nonceRows(wallet)).toBe(50);

    const old = Keypair.generate().publicKey.toBase58();
    db.getDb().query("INSERT INTO nonces (wallet,nonce,message,issuedAt) VALUES ($w,'n-old','m',$at)").run({ $w: old, $at: new Date(Date.now() - 24 * 3600_000).toISOString() });
    await api.handleRequest(new Request(`${BASE}/api/optin/nonce?wallet=${wallet}`));
    expect(nonceRows(old)).toBe(0);
  });

  test("S2-10: concurrent faucet requests for one wallet: at most one gets past the cooldown", async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const results = await Promise.all([faucetFund(wallet), faucetFund(wallet)].map((p) => p.then(() => "ok", (e: Error & { code?: string }) => e.code ?? e.message)));
    expect(results.filter((r) => r === "faucet_cooldown").length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("S2-11a: signature waits on POST /coins/confirm are capped; the excess is refused at once", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    db.upsertCoin({ mint, name: "A", symbol: "A", imageUrl: "", description: "", creator: mint, createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending", configId: Keypair.generate().publicKey.toBase58() });
    // An RPC that never finds the signature: each request would poll it for 20 s.
    conn.getSignatureStatuses = (async () => ({ context: { slot: 0 }, value: [null] })) as unknown as typeof conn.getSignatureStatuses;
    const sig = "1".repeat(64);
    const t0 = Date.now();
    const requests = Array.from({ length: 20 }, () =>
      api.handleRequest(new Request(`${BASE}/api/coins/confirm`, { method: "POST", body: JSON.stringify({ sig, mint }) })).then((r) => r.status),
    );
    const quick = await Promise.all(requests.map((r) => Promise.race([r, Bun.sleep(1_500).then(() => "still waiting")])));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(quick.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
    await Promise.all(requests); // let the admitted waits finish so later tests start with free slots
  }, 60_000);

  test("S2-11b: the holder count is read from the chain at most once per window per coin", async () => {
    let scans = 0;
    conn.getAccountInfo = (async () => ({ owner: new (await import("@solana/web3.js")).PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data: Buffer.alloc(82), lamports: 1, executable: false })) as unknown as typeof conn.getAccountInfo;
    conn.getProgramAccounts = (async () => {
      scans++;
      return [];
    }) as unknown as typeof conn.getProgramAccounts;
    const mint = Keypair.generate().publicKey.toBase58();
    const count = (api as unknown as { countHolders?: (m: string) => Promise<number> }).countHolders;
    expect(typeof count).toBe("function");
    for (let i = 0; i < 10; i++) await count!(mint);
    expect(scans).toBe(1);
  });
});
