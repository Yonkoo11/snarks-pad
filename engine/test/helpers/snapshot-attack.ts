// Subprocess for test/snapshot-attack-live.test.ts, with its own sqlite file: a real coin on the local validator
// (mainnet DBC binary), an honest holder, three holder samples, then a sniper that buys a stack ten times the
// honest one just before the epoch's claim, and a real claimRemainingCoins. Prints who got shares.
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { getConnection } from "../../src/solana";
import { loadKeeperKeypair } from "../../src/keeper";
import { fundTestWallet } from "../../src/faucet";
import { ensureDbcConfig } from "../../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../../src/dbc/launch";
import { buildTradeTx } from "../../src/dbc/trade";
import { claimRemainingCoins } from "../../src/epoch/engine";
import { takeSamplesNow } from "../../src/epoch/snapshots";
import * as db from "../../src/db";
import { waitForCoinWindow } from "../../src/dbc/windowWait";

const conn = getConnection();
async function send(txBase64: string, signer: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}
async function buy(mint: string, wallet: Keypair, zats: string): Promise<void> {
  await fundTestWallet(wallet.publicKey, 2, loadKeeperKeypair());
  const { txBase64 } = await buildTradeTx({ wallet: wallet.publicKey.toBase58(), mint, side: "buy", amount: zats, slippageBps: 500 });
  await send(txBase64, wallet);
}

await ensureDbcConfig();
const creator = Keypair.generate();
await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Snipe", symbol: "SNP", description: "", imageUrl: "", initialBuyZats: "20000000" });
await confirmLaunch(await send(txBase64, creator), mint);
await waitForCoinWindow(mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures

const honest = Keypair.generate();
await buy(mint, honest, "80000000");

const t0 = Date.now();
// SNIPE_CONTROL=1 takes no window samples: the old single claim-time snapshot, to show the attack is real
if (!process.env.SNIPE_CONTROL) for (const offset of [3000, 2000, 1000]) await takeSamplesNow(t0 - offset); // three samples of the real chain, inside the window

const sniper = Keypair.generate();
await buy(mint, sniper, "400000000"); // five times the honest buyer's money, bought after every window sample

const epochId = `epoch-snipe-${Date.now()}`;
db.upsertEpoch({ id: epochId, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
await claimRemainingCoins(epochId);
const shares = db.combineEpochCoinShares(epochId);
console.log(JSON.stringify({
  creator: creator.publicKey.toBase58(),
  honest: honest.publicKey.toBase58(),
  sniper: sniper.publicKey.toBase58(),
  harvest: db.listEpochCoinHarvests(epochId),
  shares: Object.fromEntries([...shares].map(([k, v]) => [k, v.toString()])),
}));
process.exit(0);
