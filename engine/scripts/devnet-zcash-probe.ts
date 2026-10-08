#!/usr/bin/env bun
// The two Zcash TESTNET legs of an epoch, run on their own (no Solana, no engine state): funding wallet -> pad treasury
// (what the simulated swap does), then ONE batched Ironwood transaction treasury -> two fresh wallets (what the shielded
// payout does). Prints every txid and what each recipient's wallet sees. Run detached: it waits for confirmations.
//   nohup scripts/devnet.sh bun scripts/devnet-zcash-probe.ts > data/devnet-zcash-probe.log 2>&1 &
import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { config } from "../src/config";
import { chainTipHeight, defaultUnifiedAddress, getBalance, initWallet, payBatch, receivedInTx, receivedPools, syncWallet } from "../src/zcash/devtool";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");
const fundingDir = config.simulatedSwap.fundingWalletDir!;
const fundingId = config.simulatedSwap.fundingIdentityFile!;
const treasuryDir = config.near1click.treasuryWalletDir!;
const treasuryId = config.near1click.treasuryIdentityFile!;
const treasuryUa = process.env.TREASURY_ZCASH_ADDRESS!;
const SWAP_ZATS = 2_000_000n; // 0.02 TAZ
const PAY_EACH_ZATS = 400_000n; // 0.004 TAZ
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function waitUntil(label: string, ok: () => boolean, everyMs = 30_000, maxMs = 40 * 60_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > maxMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(everyMs);
  }
}

log("tip", chainTipHeight(treasuryDir), "funding spendable before", getBalance(fundingDir).spendableZats.toString());
syncWallet(fundingDir);
log("funding spendable after sync", getBalance(fundingDir).spendableZats.toString());
const swapTx = payBatch(fundingDir, fundingId, [{ address: treasuryUa, zats: SWAP_ZATS }]);
log("LEG 1 funding -> treasury txid", swapTx, "amount", SWAP_ZATS.toString());

await waitUntil("the treasury to see the payment with 10 confirmations", () => {
  syncWallet(treasuryDir);
  const r = receivedInTx(treasuryDir, swapTx);
  const confs = r?.minedHeight ? chainTipHeight(treasuryDir) - r.minedHeight + 1 : 0;
  log("treasury sees", r ? `${r.zats} zats mined=${r.minedHeight}` : "nothing yet", "confs", confs, "spendable", getBalance(treasuryDir).spendableZats.toString());
  return confs >= 10 && getBalance(treasuryDir).spendableZats >= SWAP_ZATS;
});
log("treasury pools for the swap tx", receivedPools(treasuryDir, swapTx).join(","));

const recips = [0, 1].map((i) => {
  const dir = join(config.paths.dataDir, "zcash-testnet", `probe-recipient-${i}`);
  const id = join(config.paths.dataDir, "zcash-testnet", `probe-recipient-${i}.identity.age`);
  initWallet(dir, `probe-recipient-${i}`, id);
  if (existsSync(id)) chmodSync(id, 0o600);
  return { dir, ua: defaultUnifiedAddress(dir) };
});
const batchTx = payBatch(treasuryDir, treasuryId, recips.map((r) => ({ address: r.ua, zats: PAY_EACH_ZATS })));
log("LEG 2 treasury -> 2 fresh wallets, ONE batched tx, txid", batchTx, "each", PAY_EACH_ZATS.toString());

await waitUntil("both recipients to see their note", () => {
  return recips.every((r) => {
    syncWallet(r.dir);
    const got = receivedInTx(r.dir, batchTx);
    log("recipient", r.ua.slice(0, 10) + "…", got ? `${got.zats} zats mined=${got.minedHeight} pools=${receivedPools(r.dir, batchTx).join(",")} total=${getBalance(r.dir).totalZats}` : "nothing yet");
    return !!got && got.zats === PAY_EACH_ZATS;
  });
}, 20_000);
log("DONE both recipients confirmed their note");
