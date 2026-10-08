// Subprocess for test/keeper-kill.test.ts: one holder (argv[2] = index) buys 50,000,000 zats of the coin, which
// accrues new partner fees; prints the unclaimed partner fees and every holder's ZEC balance right now.
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/config";
import { buildTradeTx } from "../../src/dbc/trade";
import * as db from "../../src/db";
import { getConnection, getDbcClient } from "../../src/solana";

const conn = getConnection();
const { mint, secrets } = JSON.parse(readFileSync(join(process.env.KILL_DIR!, "wallets.json"), "utf8")) as { mint: string; secrets: number[][] };
const holders = secrets.map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
const buyer = holders[Number(process.argv[2])]!;
const { txBase64 } = await buildTradeTx({ wallet: buyer.publicKey.toBase58(), mint, side: "buy", amount: "50000000", slippageBps: 500 });
const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
tx.sign([buyer]);
await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), "confirmed");

const zec = async (owner: Keypair["publicKey"]): Promise<string> => {
  try {
    return (await getAccount(conn, getAssociatedTokenAddressSync(config.solana.dbc.quoteMint, owner, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount.toString();
  } catch {
    return "0";
  }
};
const accrued = (await getDbcClient().state.getPoolFeeMetrics(db.getCoin(mint)!.poolId!)).current.partnerQuoteFee.toString();
const before: Record<string, string> = {};
for (const h of holders) before[h.publicKey.toBase58()] = await zec(h.publicKey);
console.log(JSON.stringify({ accrued, holders: holders.map((h) => h.publicKey.toBase58()), before }));
process.exit(0);
