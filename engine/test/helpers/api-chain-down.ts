// Run as a subprocess by test/api-chain-down.test.ts, with SOLANA_LOCAL_RPC pointing at a stub that answers every call 429 (or never answers) and a database of
// its own. Seeds what a live pad has (a recorded config, a coin launched with v2.8.1's stored window facts and its window open now, a coin launched before
// them, a launch prepared but not confirmed yet, a keeper holder sample, a recorded trade), starts the API on a free port and prints one line:
// READY <port> <mint with facts> <older mint> <wallet> <pending mint>.
import { Keypair, PublicKey } from "@solana/web3.js";
import { ActivationType, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { startApiServer } from "../../src/api";
import { buildConfigParams } from "../../src/dbc/config";
import { scheduleOfState, scheduleToJson } from "../../src/dbc/window";
import * as db from "../../src/db";

const key = () => Keypair.generate().publicKey.toBase58();
const configId = key();
const creator = key();
const withFacts = key();
const older = key();
const holder = key();
const pending = key();

/** The 1% config's scheduler as the chain stores it (the fields the window reads), as test/launch-window.test.ts builds it. */
const config100 = { poolFees: { baseFee: buildConfigParams(100).poolFees.baseFee }, activationType: ActivationType.Timestamp, enableFirstSwapWithMinFee: 1 } as unknown as PoolConfig;

db.insertDbcConfig({
  configId, feeBps: 100, feeClaimer: key(), migrationQuoteThreshold: "1500000000", dammConfig: PublicKey.default.toBase58(), poolCreationFeeLamports: "0", createdAt: new Date().toISOString(),
});
const row = (mint: string, createdAt: string): db.CoinRow => ({
  mint, name: `Chain down ${mint.slice(0, 4)}`, symbol: "DOWN", imageUrl: "", description: "", creator, createdAt, feeBps: 100, poolId: key(), mintDecimals: 6, status: "launched", configId,
});
db.upsertCoin({ ...row(withFacts, new Date().toISOString()), feeSchedule: scheduleToJson(scheduleOfState(config100)) });
db.getDb().query("UPDATE coins SET activationPoint = $a WHERE mint = $m").run({ $a: String(Math.floor(Date.now() / 1000) - 1), $m: withFacts }); // landed a second ago: the window is open
db.upsertCoin(row(older, new Date(Date.now() - 2 * 86_400_000).toISOString()));
db.upsertCoin({ ...row(pending, new Date().toISOString()), poolId: null, status: "pending" });
db.insertHolderSample(withFacts, new Date().toISOString(), [{ wallet: creator, balance: 5_000_000n }, { wallet: holder, balance: 7_000_000n }]);
db.insertTrade({ sig: `sig-${withFacts}`, mint: withFacts, side: "buy", wallet: holder, amountToken: "7000000", amountZec: "1000000", at: new Date().toISOString() });

const server = startApiServer(0);
console.log(`READY ${server.port} ${withFacts} ${older} ${holder} ${pending}`);
