// Audit O-4, reproduced by the chaos stress run's kill point "while zcash-devtool pays" (audit/STRESS-REPORT.md):
// devtool broadcasts INSIDE `wallet pay`, and the keeper stores the txid only after pay returns. A keeper killed while
// devtool runs leaves devtool running on its own (it is a separate process); it broadcasts the chunk, and the rows still
// look fresh, so the restarted keeper paid the same holders a second time from other treasury money.
// Real processes, real regtest chain: the keeper is SIGKILLed while its devtool `pay` child runs, then restarted.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import { defaultUnifiedAddress, getBalance, initWallet, syncWallet } from "../src/zcash/devtool";
import { TREASURY_DIR, mineBlocks, shieldedTxFeeZats, syncToTip } from "../src/zcash/regtest";

async function regtestUp(): Promise<boolean> {
  if (!config.isLocal) return false;
  try {
    const r = await fetch(config.zcash.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getblockcount", params: [] }), signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

const procs = (): string[] => new TextDecoder().decode(Bun.spawnSync(["ps", "-Ao", "args"]).stdout).split("\n");
const realPayRunning = (): boolean => procs().some((l) => /zcash-devtool wallet -w \S+ pay /.test(l));
const shimHolding = (): boolean => procs().some((l) => l.includes("devtool-slow-reply.sh") && / pay /.test(l));

describe.if(await regtestUp())("O-4: keeper killed after zcash-devtool broadcast a chunk, before the txid was stored", () => {
  test("the restarted keeper finds the chunk in the treasury wallet and does not pay those holders again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "o4-"));
    const env = {
      ...process.env, PAD_DB_FILE: join(dir, "o4.sqlite"), EPOCH_LOCK_STALE_MS: "1500", PAD_PAUSE_FILE: join(dir, "PAUSED"), PAD_KEEPER_HEALTH_LOG: join(dir, "h.log"),
      ZCASH_DEVTOOL_BIN: join(import.meta.dir, "helpers", "devtool-slow-reply.sh"), TMPDIR: dir,
    };
    writeFileSync(join(dir, "o4-real-devtool"), config.paths.zcashDevtoolBin);
    const child = (args: string[], delayS?: string) => {
      if (delayS) writeFileSync(join(dir, "o4-delay"), delayS);
      else rmSync(join(dir, "o4-delay"), { force: true });
      return Bun.spawn(["bun", "test/helpers/zcash-intent-child.ts", ...args], { env, stdout: "pipe", stderr: "pipe" });
    };
    const recipients = [0, 1].map((i) => {
      const w = join(dir, `r${i}`);
      initWallet(w, `r${i}`, join(dir, `r${i}.age`));
      return { dir: w, wallet: Keypair.generate().publicKey.toBase58(), ua: defaultUnifiedAddress(w), zats: String(200_000 + i * 50_000) };
    });
    const epochId = `epoch-o4-${Date.now()}`;
    expect(await child(["setup", epochId, JSON.stringify(recipients)]).exited).toBe(0);
    await syncToTip(TREASURY_DIR); // this test is about the crash window, not a stale wallet (the next test)

    const first = child(["run"], "30");
    const t0 = Date.now();
    while (!(shimHolding() && !realPayRunning()) && Date.now() - t0 < 120_000) await Bun.sleep(50); // broadcast done, reply held back
    expect(shimHolding()).toBe(true);
    first.kill("SIGKILL"); // the keeper dies with the chunk on the network and no txid stored
    await first.exited;
    rmSync(join(dir, "o4-delay"), { force: true });
    await Bun.sleep(2000); // the dead run's lock goes stale

    for (let i = 0; i < 3; i++) {
      const again = child(["run"]);
      await again.exited;
      console.log(await new Response(again.stdout).text(), (await new Response(again.stderr).text()).split("\n").filter((l) => /pay failed|Error|error:/.test(l)).slice(0, 4).join("\n"));
    }
    await mineBlocks(10);
    for (const r of recipients) {
      syncWallet(r.dir);
      expect(getBalance(r.dir).totalZats).toBe(BigInt(r.zats)); // exactly once, not twice
    }
  }, 600_000);
});

// Found by the same test's first version: the treasury wallet was not synced before `pay`. A settled epoch resumed
// after the chain moved more than devtool's expiry delta (about 40 blocks, ~50 min on mainnet) past the wallet's last
// sync builds transactions that expire before they can be mined: zebrad rejects every one and the epoch never pays.
describe.if(await regtestUp())("a settled epoch resumed after the chain moved on", () => {
  test("pays from a treasury wallet synced right before the payment, not from its last-sync view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    const env = { ...process.env, PAD_DB_FILE: join(dir, "s.sqlite"), EPOCH_LOCK_STALE_MS: "1500", PAD_PAUSE_FILE: join(dir, "PAUSED"), PAD_KEEPER_HEALTH_LOG: join(dir, "h.log") };
    const w = join(dir, "r");
    initWallet(w, "r", join(dir, "r.age"));
    const r = { wallet: Keypair.generate().publicKey.toBase58(), ua: defaultUnifiedAddress(w), zats: "300000" };
    const epochId = `epoch-stale-${Date.now()}`;
    expect(await Bun.spawn(["bun", "test/helpers/zcash-intent-child.ts", "setup", epochId, JSON.stringify([r])], { env }).exited).toBe(0);
    await syncToTip(TREASURY_DIR);
    await mineBlocks(60); // the chain moves on while nothing syncs the treasury (a keeper down for an hour)
    const run = Bun.spawn(["bun", "test/helpers/zcash-intent-child.ts", "run"], { env, stdout: "pipe", stderr: "pipe" });
    await run.exited;
    const err = await new Response(run.stderr).text();
    expect(err).not.toContain("greater than its expiry");
    await mineBlocks(10);
    syncWallet(w);
    expect(getBalance(w).totalZats).toBe(300_000n);
  }, 600_000);
});

// Stress chaos round 7 (audit/STRESS-REPORT.md D8): a keeper killed between two Zcash chunks. The local fee was added
// up only for the chunks sent in the run that finished, so the epoch's published feeZats left out the first chunk
// (45,000 recorded, 75,000 paid). It is now the sum over every txid the epoch sent, read from the node.
describe.if(await regtestUp())("an epoch whose Zcash chunks were sent by two runs", () => {
  test("records the network fee of every chunk, not only the ones the last run sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fee-"));
    const env = { ...process.env, PAD_DB_FILE: join(dir, "f.sqlite"), EPOCH_LOCK_STALE_MS: "1500", PAD_PAUSE_FILE: join(dir, "PAUSED"), PAD_KEEPER_HEALTH_LOG: join(dir, "h.log"), PAD_STRESS_SHIELDED_PER_TX: "1" };
    const recipients = [0, 1].map((i) => {
      const w = join(dir, `r${i}`);
      initWallet(w, `r${i}`, join(dir, `r${i}.age`));
      return { dir: w, wallet: Keypair.generate().publicKey.toBase58(), ua: defaultUnifiedAddress(w), zats: String(150_000 + i * 10_000) };
    });
    const epochId = `epoch-fee-${Date.now()}`;
    expect(await Bun.spawn(["bun", "test/helpers/zcash-intent-child.ts", "setup", epochId, JSON.stringify(recipients)], { env }).exited).toBe(0);
    await syncToTip(TREASURY_DIR);
    const first = Bun.spawn(["bun", "test/helpers/zcash-intent-child.ts", "run"], { env, stdout: "ignore", stderr: "ignore" });
    const { Database } = await import("bun:sqlite");
    const sentRows = () => { const d = new Database(env.PAD_DB_FILE, { readonly: true }); try { return (d.query("SELECT COUNT(*) AS n FROM payouts WHERE sentAt IS NOT NULL").get() as { n: number }).n; } finally { d.close(); } };
    const t0 = Date.now();
    while (sentRows() < 1 && Date.now() - t0 < 120_000) await Bun.sleep(50);
    first.kill("SIGKILL"); // chunk 1 sent and recorded, chunk 2 not yet
    await first.exited;
    while (realPayRunning()) await Bun.sleep(200);
    await Bun.sleep(2000);
    for (let i = 0; i < 3; i++) await Bun.spawn(["bun", "test/helpers/zcash-intent-child.ts", "run"], { env, stdout: "ignore", stderr: "ignore" }).exited;
    const d = new Database(env.PAD_DB_FILE, { readonly: true });
    const e = d.query("SELECT feeZats, zcashTxids FROM epochs WHERE id = ?").get(epochId) as { feeZats: string; zcashTxids: string };
    d.close();
    const txids = JSON.parse(e.zcashTxids) as string[];
    let real = 0n;
    for (const t of txids) real += await shieldedTxFeeZats(t);
    expect(txids.length).toBe(2);
    expect(BigInt(e.feeZats)).toBe(real);
  }, 600_000);
});
