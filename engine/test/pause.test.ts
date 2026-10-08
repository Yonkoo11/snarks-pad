// The kill switch (plan section 4): PAYOUTS_PAUSED=1 or the pause file stops every claim and payout before it
// starts, mid-epoch too, and /treasury says so. Nothing is lost: the next run after the switch is off
// finishes what was left, paying each wallet exactly once. Real runEpoch against the local validator.
import { afterEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { runEpoch } from "../src/epoch/engine";
import { loadKeeperKeypair } from "../src/keeper";
import { clearStopRequest, payoutsPaused, requestStop } from "../src/pause";
import { getConnection } from "../src/solana";
import type { SwapAdapter } from "../src/swap/types";
import { devtoolPresent } from "./helpers/validator-up";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

const MINT = config.solana.dbc.quoteMint;
const conn = getConnection();
const SHARE = 50_000n;
const ataOf = (owner: Keypair["publicKey"]) => getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM_ID);
const zecOf = async (owner: Keypair["publicKey"]) => {
  try {
    return (await getAccount(conn, ataOf(owner), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};
const noSwap: SwapAdapter = {
  provider: "simulated",
  quote: async () => ({ outZats: 0n }),
  submit: async () => {
    throw new Error("no shielded leg in these tests");
  },
  status: async () => ({ status: "pending" }),
};

function epochPaying(wallets: Keypair["publicKey"][]): string {
  db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("DELETE FROM carry").run();
  const id = `epoch-pause-${crypto.randomUUID()}`;
  db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
  for (const w of wallets) db.planPayout({ epochId: id, wallet: w.toBase58(), kind: "solana", amountZats: SHARE.toString() });
  return id;
}

const realFile = config.paths.pauseFile;
const realSend = conn.sendRawTransaction.bind(conn);
afterEach(() => {
  delete process.env.PAYOUTS_PAUSED;
  (config.paths as { pauseFile: string }).pauseFile = realFile;
  conn.sendRawTransaction = realSend;
  clearStopRequest();
});

describe("what counts as paused", () => {
  test("PAYOUTS_PAUSED=1, or the pause file; nothing else", () => {
    expect(payoutsPaused()).toEqual({ paused: false, reason: null });
    process.env.PAYOUTS_PAUSED = "0";
    expect(payoutsPaused().paused).toBe(false);
    process.env.PAYOUTS_PAUSED = "1";
    expect(payoutsPaused()).toEqual({ paused: true, reason: "env" });
    delete process.env.PAYOUTS_PAUSED;
    const dir = mkdtempSync(join(tmpdir(), "pause-"));
    (config.paths as { pauseFile: string }).pauseFile = join(dir, "PAUSED");
    expect(payoutsPaused().paused).toBe(false);
    writeFileSync(join(dir, "PAUSED"), "");
    expect(payoutsPaused()).toEqual({ paused: true, reason: "file" });
    rmSync(dir, { recursive: true });
  });

  test.if(devtoolPresent())("GET /treasury says paused: true while the switch is on (reads the treasury wallet)", async () => {
    const off = (await (await handleRequest(new Request("http://x/api/treasury"))).json()) as { paused: boolean };
    expect(off.paused).toBe(false);
    process.env.PAYOUTS_PAUSED = "1";
    const on = (await (await handleRequest(new Request("http://x/api/treasury"))).json()) as { paused: boolean };
    expect(on.paused).toBe(true);
  });
});

describe.if(await validatorUp())("a paused keeper claims and sends nothing", () => {
  test("PAYOUTS_PAUSED=1: runEpoch returns before the lock, the claim step and any send", async () => {
    const wallets = [Keypair.generate().publicKey];
    epochPaying(wallets);
    process.env.PAYOUTS_PAUSED = "1";
    let claimCalls = 0;
    const out = await runEpoch(noSwap, async () => {
      claimCalls++;
    });
    expect(out.paused).toMatch(/paused/);
    expect(claimCalls).toBe(0);
    expect(await zecOf(wallets[0]!)).toBe(0n);
  });

  test("the pause file does the same, with no restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pause-"));
    (config.paths as { pauseFile: string }).pauseFile = join(dir, "PAUSED");
    writeFileSync(join(dir, "PAUSED"), "");
    const wallets = [Keypair.generate().publicKey];
    epochPaying(wallets);
    expect((await runEpoch(noSwap, async () => {})).paused).toMatch(/pause file/);
    expect(await zecOf(wallets[0]!)).toBe(0n);
    rmSync(join(dir, "PAUSED"));
    await mintTo(conn, loadKeeperKeypair(), MINT, ataOf(loadKeeperKeypair().publicKey), loadKeeperKeypair(), 4n * SHARE);
    const out = await runEpoch(noSwap, async () => {});
    expect(out.paused).toBeUndefined();
    expect(await zecOf(wallets[0]!)).toBe(SHARE);
    rmSync(dir, { recursive: true });
  }, 60_000);

  test("thrown mid-epoch: the batch in hand is not sent, the next run pays the rest, each wallet exactly once", async () => {
    await mintTo(conn, loadKeeperKeypair(), MINT, ataOf(loadKeeperKeypair().publicKey), loadKeeperKeypair(), 20n * SHARE);
    const wallets = Array.from({ length: 9 }, () => Keypair.generate().publicKey); // two batches: 8 + 1
    epochPaying(wallets);
    let sends = 0;
    conn.sendRawTransaction = (async (raw: Uint8Array, opts?: object) => {
      sends++;
      const sig = await realSend(raw, opts);
      process.env.PAYOUTS_PAUSED = "1"; // thrown right after the first batch goes out
      return sig;
    }) as typeof conn.sendRawTransaction;
    const first = await runEpoch(noSwap, async () => {});
    expect(first.paused).toMatch(/paused/);
    expect(sends).toBe(1); // the second batch was never sent
    const afterFirst = await Promise.all(wallets.map(zecOf));
    expect(afterFirst.filter((a) => a === SHARE).length).toBe(8);
    expect(afterFirst.filter((a) => a === 0n).length).toBe(1);

    conn.sendRawTransaction = realSend;
    delete process.env.PAYOUTS_PAUSED;
    await runEpoch(noSwap, async () => {});
    expect(await Promise.all(wallets.map(zecOf))).toEqual(wallets.map(() => SHARE)); // not 2x for anyone
  }, 90_000);

  test("a graceful stop (SIGTERM in the keeper) is the same safe stop, and it is not reported as an operator pause", async () => {
    await mintTo(conn, loadKeeperKeypair(), MINT, ataOf(loadKeeperKeypair().publicKey), loadKeeperKeypair(), 20n * SHARE);
    const wallets = Array.from({ length: 9 }, () => Keypair.generate().publicKey);
    epochPaying(wallets);
    conn.sendRawTransaction = (async (raw: Uint8Array, opts?: object) => {
      const sig = await realSend(raw, opts);
      requestStop();
      return sig;
    }) as typeof conn.sendRawTransaction;
    const out = await runEpoch(noSwap, async () => {});
    expect(out.paused).toMatch(/stop requested/);
    expect(payoutsPaused().paused).toBe(false);
    conn.sendRawTransaction = realSend;
    clearStopRequest();
    await runEpoch(noSwap, async () => {});
    expect(await Promise.all(wallets.map(zecOf))).toEqual(wallets.map(() => SHARE));
  }, 90_000);
});
