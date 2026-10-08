// Subprocess for test/claim-isolation.test.ts, with its own sqlite file: a coin
// whose pool cannot be read (A, listed FIRST) must not stop the next coin (B,
// a real launch with accrued fees) from being claimed and attributed.
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { getConnection } from "../../src/solana";
import { loadKeeperKeypair } from "../../src/keeper";
import { fundTestWallet } from "../../src/faucet";
import { ensureDbcConfig } from "../../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../../src/dbc/launch";
import { claimRemainingCoins } from "../../src/epoch/engine";
import * as db from "../../src/db";

const cfg = await ensureDbcConfig();
const creator = Keypair.generate();
await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Iso", symbol: "ISO", description: "", imageUrl: "", initialBuyZats: "20000000" });
const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
tx.sign([creator]);
const sig = await getConnection().sendRawTransaction(tx.serialize());
await getConnection().confirmTransaction(sig, "confirmed");
await confirmLaunch(sig, mint);

const broken = Keypair.generate().publicKey.toBase58();
db.upsertCoin({
  mint: broken, name: "Broken", symbol: "BRK", imageUrl: "", description: "", creator: creator.publicKey.toBase58(),
  createdAt: new Date(Date.now() + 3_600_000).toISOString(), feeBps: 100, poolId: Keypair.generate().publicKey.toBase58(),
  mintDecimals: 6, status: "launched", configId: cfg.configId,
});

const epochId = `epoch-iso-${Date.now()}`;
db.upsertEpoch({ id: epochId, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "harvesting", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
await claimRemainingCoins(epochId); // must not throw
console.log(JSON.stringify({
  broken,
  mint,
  harvests: db.listEpochCoinHarvests(epochId),
  unconfirmed: db.listUnconfirmedClaims(epochId).length,
}));
process.exit(0);
