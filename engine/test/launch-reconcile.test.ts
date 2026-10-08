// the design notes section 13: a launch that landed but that no browser confirmed is recorded by the engine (F3); a launch is refused before any wallet sees it
// when its address is taken or the simulation says the wallet is short (contract v2.9.1).
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as db from "../src/db";
import { config } from "../src/config";
import { LaunchTxError, launchShortfall } from "../src/dbc/launch";
import { RECONCILE_AFTER_MS, lookForPool, lookForPools, reconcilePendingLaunches, type ReadAccounts } from "../src/dbc/reconcile";

const NOW = Date.parse("2026-10-06T20:00:00Z");
const CONFIG = Keypair.generate().publicKey.toBase58();
const made: string[] = [];
afterAll(() => { for (const m of made) db.deleteUnconfirmedCoin(m); });

const key = () => Keypair.generate().publicKey.toBase58();
const poolOf = (mint: string) => deriveDbcPoolAddress(config.solana.dbc.quoteMint, new PublicKey(mint), new PublicKey(CONFIG));
const account = (owner: PublicKey): AccountInfo<Buffer> => ({ data: Buffer.alloc(8), executable: false, lamports: 1, owner, rentEpoch: 0 });

function pending(ageMs: number, configId: string | null = CONFIG): string {
  const mint = key();
  made.push(mint);
  db.upsertCoin({
    mint, name: "T", symbol: "T", imageUrl: "", description: "", creator: key(), createdAt: new Date(NOW - ageMs).toISOString(), feeBps: 100,
    poolId: null, mintDecimals: 6, status: "pending", configId,
  });
  return mint;
}

/** A chain where `landed` mints have their pool (owned by the DBC program) and `funded` ones only a system account at the pool address. */
function chain(landed: string[], funded: string[] = []): ReadAccounts & { calls: number[] } {
  const pools = new Map<string, AccountInfo<Buffer>>();
  for (const m of landed) pools.set(poolOf(m).toBase58(), account(config.solana.dbc.programId));
  for (const m of funded) pools.set(poolOf(m).toBase58(), account(PublicKey.default));
  const calls: number[] = [];
  const read = (async (keys: PublicKey[]) => (calls.push(keys.length), keys.map((k) => pools.get(k.toBase58()) ?? null))) as ReadAccounts & { calls: number[] };
  read.calls = calls;
  return read;
}

describe("the engine records a launch no browser confirmed (F3)", () => {
  test("a pending launch older than the browser's time whose pool exists is recorded as launched, with its pool", async () => {
    const m = pending(RECONCILE_AFTER_MS + 5_000);
    expect(await reconcilePendingLaunches(NOW, chain([m]))).toContain(m);
    const row = db.getCoin(m);
    expect(row?.status).toBe("launched");
    expect(row?.poolId).toBe(poolOf(m).toBase58());
  });

  test("a launch still inside its browser's time is not looked up", async () => {
    const m = pending(10_000);
    const read = chain([m]);
    expect(await reconcilePendingLaunches(NOW, read)).not.toContain(m);
    expect(db.getCoin(m)?.status).toBe("pending");
  });

  test("an account someone funded at the pool address is not a pool: the launch stays pending", async () => {
    const m = pending(RECONCILE_AFTER_MS + 5_000);
    expect(await reconcilePendingLaunches(NOW, chain([], [m]))).not.toContain(m);
    expect(db.getCoin(m)?.status).toBe("pending");
  });

  test("a read that fails records nothing and throws nothing", async () => {
    const m = pending(RECONCILE_AFTER_MS + 5_000);
    const failing: ReadAccounts = async () => { throw new Error("429 Too Many Requests"); };
    expect(await reconcilePendingLaunches(NOW, failing)).not.toContain(m);
    expect(db.getCoin(m)?.status).toBe("pending");
  });

  test("pools are read 100 at a time, and each answer goes to its own launch", async () => {
    const rows = Array.from({ length: 150 }, () => ({ mint: key(), configId: CONFIG }));
    const read = chain([rows[3]!.mint, rows[120]!.mint]);
    const looks = await lookForPools(rows, read);
    expect(read.calls).toEqual([100, 50]);
    expect(looks.get(rows[3]!.mint)?.state).toBe("landed");
    expect(looks.get(rows[120]!.mint)?.state).toBe("landed");
    expect(looks.get(rows[4]!.mint)?.state).toBe("absent");
  });

  test("a failed batch answers unknown for its launches, not absent (unknown keeps a launch; absent lets the sweep drop it)", async () => {
    const looks = await lookForPools([{ mint: key(), configId: CONFIG }], async () => { throw new Error("rpc down"); });
    expect([...looks.values()].map((l) => l.state)).toEqual(["unknown"]);
  });

  test("a pending row with no config can never be confirmed, so it reads as absent", async () => {
    const m = pending(RECONCILE_AFTER_MS + 5_000, null);
    expect((await lookForPool(m, chain([]))).state).toBe("absent");
  });
});

describe("a simulation's refusal in plain terms", () => {
  test("no SOL for the fee or the new accounts", () => {
    expect(launchShortfall({ InstructionError: [0, "InsufficientFundsForRent"] }, [])).toBe("needs_sol");
    expect(launchShortfall("AccountNotFound", [])).toBe("needs_sol");
    expect(launchShortfall({ InstructionError: [1, { Custom: 1 }] }, ["Transfer: insufficient lamports 100, need 2000000"])).toBe("needs_sol");
  });

  test("a first buy larger than the wallet's ZEC", () => {
    expect(launchShortfall({ InstructionError: [3, { Custom: 1 }] }, ["Program log: Instruction: TransferChecked", "Program log: Error: insufficient funds"])).toBe("needs_zec");
  });

  test("anything else is a launch that would fail", () => {
    expect(launchShortfall({ InstructionError: [2, { Custom: 6002 }] }, ["Program log: AnchorError: ExceededSlippage"])).toBe("launch_would_fail");
    expect(new LaunchTxError("launch_would_fail").code).toBe("launch_would_fail");
  });
});
