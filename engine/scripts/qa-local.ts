#!/usr/bin/env bun
// Local-mode QA helper for web/qa/real-flow.cjs. Refuses to run outside
// PAD_MODE=local. Keeps the keeper key inside the engine: the web QA script
// only ever asks for a public key to be funded.
//
//   bun scripts/qa-local.ts fund <solana pubkey>   airdrop 5 SOL + mint 5 local Solana ZEC
//   bun scripts/qa-local.ts zwallet <name>         fresh zcash-devtool regtest wallet, prints its UA
//   bun scripts/qa-local.ts zbalance <name>        syncs that wallet, prints its total balance in zats
//   bun scripts/qa-local.ts solbalance <pubkey>    prints Solana-ZEC balance (zats) and token balances
//   bun scripts/qa-local.ts quotemint              prints the quote (Solana ZEC) mint of this mode
//   bun scripts/qa-local.ts sample                 takes one holder sample now (what the keeper loop does at random times)
//   bun scripts/qa-local.ts feetrade <mint> <zats> a throwaway wallet buys <zats> of Solana ZEC worth of <mint>, so fees accrue for its holders
//   bun scripts/qa-local.ts curvecoin              launches a fresh coin that stays on the curve and buys 0.5 ZEC of it, prints its mint
// Output is one JSON line on stdout.
import { join } from "node:path";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";
import * as db from "../src/db";
import { curveRoomZats } from "../src/dbc/room";
import { fundTestWallet, loadFaucetKeypair } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { initWallet, defaultUnifiedAddress, syncWallet, getBalance } from "../src/zcash/devtool";
import { isPubkey } from "../src/api/validate";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx, recordTrade } from "../src/dbc/trade";
import { ensureDbcConfig } from "../src/dbc/setup";
import { takeSamplesNow } from "../src/epoch/snapshots";

if (!config.isLocal && config.mode !== "devnet") {
  console.error("qa-local.ts only runs in PAD_MODE=local or PAD_MODE=devnet (test money only)");
  process.exit(2);
}
// Funding minter: the keeper locally (the local ZEC mint's authority is rewritten to it), the faucet key on devnet.
const minter = (): Keypair => (config.isLocal ? loadKeeperKeypair() : loadFaucetKeypair());

const [cmd, arg] = process.argv.slice(2);
const walletDir = (name: string) => join(config.isLocal ? join(config.paths.zcashWorkDir, "wallets") : join(config.paths.dataDir, "zcash-testnet"), `qa-${name}`);

function safeName(name: string | undefined): string {
  if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("name must be [a-z0-9-]{1,40}");
  return name;
}

async function signAndSend(txBase64: string, signer: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]); // keeps the new mint's signature the server already added
  const sig = await getConnection().sendRawTransaction(tx.serialize());
  await getConnection().confirmTransaction(sig, "confirmed");
  return sig;
}

/** A precondition for the home-page check: a coin that is certainly still on the curve and has some progress. */
async function launchCurveCoin(): Promise<{ mint: string; symbol: string }> {
  await ensureDbcConfig();
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 5, minter());
  const symbol = `QC${String(Date.now()).slice(-6)}`;
  const launch = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "QA Curve Coin", symbol, description: "Made by web/qa/real-flow.cjs so the home page has a coin on the curve.", imageUrl: "", initialBuyZats: "0" });
  await confirmLaunch(await signAndSend(launch.txBase64, creator), launch.mint);
  await waitForCoinWindow(launch.mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  const params = { wallet: creator.publicKey.toBase58(), mint: launch.mint, side: "buy" as const, amount: "50000000", slippageBps: 500 };
  const { txBase64, quote } = await buildTradeTx(params);
  recordTrade(await signAndSend(txBase64, creator), params, quote);
  return { mint: launch.mint, symbol };
}

/**
 * A buy on a coin still on its DBC curve is an exact-in swap, which the program refuses ("Insufficient Liquidity") when it is larger
 * than what the curve has left. Earlier runs fill the launch coin's curve, so the helper clamps to 95% of the room that is left
 * (the 1% fee is taken from the input) instead of depending on how many runs came before.
 */
async function roomOnCurve(mint: string): Promise<bigint | null> {
  const coin = db.getCoin(mint);
  if (!coin?.poolId || coin.dammPool) return null;
  const client = getDbcClient();
  const pool = await client.state.getPool(coin.poolId);
  if (!pool || pool.poolState.isMigrated !== 0) return null;
  const threshold = BigInt((await client.state.getPoolMigrationQuoteThreshold(coin.poolId)).toString());
  return curveRoomZats(threshold, BigInt(pool.poolState.quoteReserve.toString()));
}

/** A throwaway wallet buys `zats` of `mint`; the trade's fee accrues in the pool for the coin's holders. */
async function feeTrade(mint: string, requested: string): Promise<{ sig: string; zats: string }> {
  const room = await roomOnCurve(mint);
  const zats = room !== null && room < BigInt(requested) ? room.toString() : requested;
  if (BigInt(zats) === 0n) throw new Error("the curve is full: nothing left to buy until the keeper migrates the coin");
  const trader = Keypair.generate();
  await fundTestWallet(trader.publicKey, 5, minter());
  const params = { wallet: trader.publicKey.toBase58(), mint, side: "buy" as const, amount: zats, slippageBps: 1000 };
  const { txBase64, quote } = await buildTradeTx(params);
  const sig = await signAndSend(txBase64, trader);
  recordTrade(sig, params, quote);
  return { sig, zats };
}

async function main(): Promise<unknown> {
  if (cmd === "fund") {
    if (!isPubkey(arg)) throw new Error("fund needs a Solana pubkey");
    return { ok: true, ...(await fundTestWallet(new PublicKey(arg), 5, minter())) };
  }
  if (cmd === "zwallet") {
    const name = safeName(arg);
    const dir = walletDir(name);
    initWallet(dir, `qa-${name}`, `${dir}.identity.age`);
    return { ok: true, ua: defaultUnifiedAddress(dir) };
  }
  if (cmd === "zbalance") {
    const dir = walletDir(safeName(arg));
    syncWallet(dir);
    const b = getBalance(dir);
    return { ok: true, totalZats: b.totalZats.toString(), spendableZats: b.spendableZats.toString(), height: b.height };
  }
  if (cmd === "solbalance") {
    if (!isPubkey(arg)) throw new Error("solbalance needs a Solana pubkey");
    const owner = new PublicKey(arg);
    const conn = getConnection();
    const out: Record<string, string> = {};
    for (const programId of [TOKEN_PROGRAM_ID, new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")]) {
      const { value } = await conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
      for (const a of value) {
        const info = a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
        out[info.mint] = (BigInt(out[info.mint] ?? "0") + BigInt(info.tokenAmount.amount)).toString();
      }
    }
    return { ok: true, balances: out };
  }
  if (cmd === "quotemint") return { ok: true, mint: config.solana.dbc.quoteMint.toBase58() };
  if (cmd === "sample") return { ok: true, coinsSampled: await takeSamplesNow(Date.now()) };
  if (cmd === "feetrade") {
    const zats = process.argv[4];
    if (!isPubkey(arg) || !zats || !/^\d{1,12}$/.test(zats)) throw new Error("feetrade needs <mint> <zats>");
    return { ok: true, ...(await feeTrade(arg, zats)) };
  }
  if (cmd === "curvecoin") return { ok: true, ...(await launchCurveCoin()) };
  throw new Error("usage: fund <pubkey> | zwallet <name> | zbalance <name> | solbalance <pubkey> | quotemint | sample | feetrade <mint> <zats> | curvecoin");
}

main()
  .then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    console.log(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }));
    process.exit(1);
  });
