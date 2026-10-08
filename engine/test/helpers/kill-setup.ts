// Subprocess for test/keeper-kill.test.ts: with its own sqlite file, a real coin on the local validator, ten
// holders (the creator and nine buyers, so the Solana payout needs two batches), and accrued fees. Writes the
// throwaway local wallets to $KILL_DIR/wallets.json (kill-trade.ts trades with them) and prints the mint.
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConnection } from "../../src/solana";
import { loadKeeperKeypair } from "../../src/keeper";
import { fundTestWallet } from "../../src/faucet";
import { ensureDbcConfig } from "../../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../../src/dbc/launch";
import { buildTradeTx } from "../../src/dbc/trade";
import { waitForCoinWindow } from "../../src/dbc/windowWait";

const conn = getConnection();
async function send(txBase64: string, signer: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

await ensureDbcConfig();
const creator = Keypair.generate();
await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Kill", symbol: "KIL", description: "", imageUrl: "", initialBuyZats: "20000000" });
await confirmLaunch(await send(txBase64, creator), mint);
await waitForCoinWindow(mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures

const holders = [creator];
for (let i = 0; i < 9; i++) {
  const buyer = Keypair.generate();
  await fundTestWallet(buyer.publicKey, 2, loadKeeperKeypair());
  const { txBase64: tx } = await buildTradeTx({ wallet: buyer.publicKey.toBase58(), mint, side: "buy", amount: "30000000", slippageBps: 500 });
  await send(tx, buyer);
  holders.push(buyer);
}
writeFileSync(join(process.env.KILL_DIR!, "wallets.json"), JSON.stringify({ mint, secrets: holders.map((h) => Array.from(h.secretKey)) }), { mode: 0o600 });
console.log(JSON.stringify({ mint }));
process.exit(0);
