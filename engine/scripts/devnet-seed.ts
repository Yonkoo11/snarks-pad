#!/usr/bin/env bun
// Phase 2 of the devnet bring-up (after devnet-init.ts, squads:create and config:create): launches SNARKS on devnet
// (image /mascot.jpg) and simulates buyers with test wallets: the creator, two default holders and two opted-in holders
// whose unified addresses come from FRESH zcash-devtool testnet wallets. Resumable: wallets are kept in
// engine/data/devnet-wallets.json (0600, test-only keys, gitignored); a coin already launched is not launched again.
//   scripts/devnet.sh bun scripts/devnet-seed.ts
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { config } from "../src/config";
import * as db from "../src/db";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx, recordTrade } from "../src/dbc/trade";
import { ensureDbcConfig } from "../src/dbc/setup";
import { fundTestWallet, loadFaucetKeypair } from "../src/faucet";
import { optinMessage } from "../src/optin/message";
import { issueNonce, registerOptin } from "../src/optin/registry";
import { getConnection } from "../src/solana";
import { defaultUnifiedAddress, initWallet } from "../src/zcash/devtool";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");
const WALLETS_FILE = join(config.paths.dataDir, "devnet-wallets.json");
const CREATOR_FIRST_BUY_ZATS = 20_000_000n; // 0.2 stand-in ZEC
const BUY_ZATS = 100_000_000n; // 1 stand-in ZEC per buyer: fees of ~5 ZEC of buys clear the shielded swap floor (0.01 ZEC)

interface Wallets { creator: string; defaults: string[]; optins: { key: string; walletDir: string; identity: string }[]; mint?: string }

function loadWallets(): Wallets {
  if (existsSync(WALLETS_FILE)) return JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as Wallets;
  const gen = () => bs58.encode(Keypair.generate().secretKey);
  const zdir = join(config.paths.dataDir, "zcash-testnet");
  const w: Wallets = {
    creator: gen(),
    defaults: [gen(), gen()],
    optins: [0, 1].map((i) => ({ key: gen(), walletDir: join(zdir, `optin-${i}`), identity: join(zdir, `optin-${i}.identity.age`) })),
  };
  save(w);
  return w;
}

function save(w: Wallets): void {
  writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2), { mode: 0o600 });
  chmodSync(WALLETS_FILE, 0o600);
}

const kp = (secret: string): Keypair => Keypair.fromSecretKey(bs58.decode(secret));

async function signAndSend(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]); // keeps the new mint's signature the server already added on launch
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function buy(mint: string, buyer: Keypair, zats: bigint): Promise<string> {
  const params = { wallet: buyer.publicKey.toBase58(), mint, side: "buy" as const, amount: zats.toString(), slippageBps: 500 };
  const { txBase64, quote } = await buildTradeTx(params);
  const sig = await signAndSend(txBase64, buyer);
  recordTrade(sig, params, quote);
  console.log(`BUY ${buyer.publicKey.toBase58()} ${zats} zats of stand-in ZEC, tx ${sig}`);
  return sig;
}

function optIn(buyer: Keypair, ua: string): void {
  const wallet = buyer.publicKey.toBase58();
  if (db.getOptin(wallet)?.active) return;
  const { nonce } = issueNonce(wallet);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(optinMessage(wallet, ua, nonce)), buyer.secretKey));
  const result = registerOptin(wallet, ua, nonce, signature);
  if (!result.ok) throw new Error(`opt-in failed for ${wallet}: ${result.error}`);
  console.log(`OPT-IN ${wallet} -> ${ua.slice(0, 12)}…${ua.slice(-4)} (fresh testnet wallet)`);
}

const wallets = loadWallets();
const faucet = loadFaucetKeypair();
const everyone = [wallets.creator, ...wallets.defaults, ...wallets.optins.map((o) => o.key)].map(kp);
for (const w of everyone) {
  const conn = getConnection();
  if ((await conn.getBalance(w.publicKey)) >= 50_000_000) continue; // already funded
  const f = await fundTestWallet(w.publicKey, 0.1, faucet);
  console.log(`FAUCET ${w.publicKey.toBase58()} ${f.sol} SOL + ${f.zecZats} zats of stand-in ZEC`);
}

const cfg = await ensureDbcConfig();
console.log("DBC config", cfg.configId, "fee claimer", cfg.feeClaimer);
const existing = db.listCoins().find((c) => c.symbol === "SNARKS" && c.status === "launched");
let mint = existing?.mint ?? wallets.mint;
if (!mint) {
  const creator = kp(wallets.creator);
  const launch = await buildLaunchTx({
    creator: creator.publicKey.toBase58(), name: "Snarks", symbol: "SNARKS", description: "The pad's launch coin. RELEASE THE SNARKS.",
    imageUrl: "/mascot.jpg", initialBuyZats: CREATOR_FIRST_BUY_ZATS.toString(),
  });
  const sig = await signAndSend(launch.txBase64, creator);
  await confirmLaunch(sig, launch.mint);
  await waitForCoinWindow(launch.mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  mint = launch.mint;
  console.log(`LAUNCH SNARKS mint ${mint}, tx ${sig}`);
}
wallets.mint = mint;
save(wallets);

const traded = new Set(db.listTradesForMint(mint, 1000).map((t) => t.wallet));
const holds = (owner: Keypair): boolean => traded.has(owner.publicKey.toBase58());
for (const b of [...wallets.defaults, ...wallets.optins.map((o) => o.key)].map(kp)) {
  if (!holds(b)) await buy(mint, b, BUY_ZATS);
}
for (const [i, o] of wallets.optins.entries()) {
  initWallet(o.walletDir, `optin-${i}`, o.identity);
  chmodSync(o.identity, 0o600);
  optIn(kp(o.key), defaultUnifiedAddress(o.walletDir));
}
console.log("devnet seed complete. mint:", mint);
