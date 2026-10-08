#!/usr/bin/env bun
// Phase 1 of bringing the pad up on Solana DEVNET + Zcash TESTNET (ops/DEPLOY.md, "Devnet"). Idempotent. Creates
// the test-only keys (keeper, faucet, stand-in owner, stand-in backup), funds the keeper and faucet with devnet SOL, makes the 8-decimal
// stand-in ZEC mint (mint authority = the faucet key), creates the pad's Zcash testnet treasury wallet, and writes
// engine/data/devnet.vars (paths and PUBLIC addresses only) which scripts/devnet.sh loads for every later command.
//   scripts/devnet.sh bun scripts/devnet-init.ts --funder <keypair file holding devnet SOL> [--zcash-funding-dir <wallet> --zcash-funding-identity <age file>]
// Nothing here prints a key. Devnet airdrops are rate-limited per IP, so SOL comes from a keypair file you point at.
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createMint, getMint } from "@solana/spl-token";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { defaultUnifiedAddress, initWallet, syncWallet } from "../src/zcash/devtool";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const conn = getConnection();
const { keysDir, dataDir } = config.paths;
const ENV_FILE = join(dataDir, "devnet.vars");
const KEEPER_SOL = 0.6;
const FAUCET_SOL = 1.0;

function loadOrCreateKey(path: string): Keypair {
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

async function topUp(funder: Keypair, to: PublicKey, targetSol: number): Promise<void> {
  const have = await conn.getBalance(to, "confirmed");
  const need = Math.round(targetSol * 1e9) - have;
  if (need <= 0) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: need }));
  await sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" });
}

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function writeEnvFile(vars: Record<string, string>): void {
  writeFileSync(ENV_FILE, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

const keeper = loadOrCreateKey(join(keysDir, "keeper-devnet.json"));
const faucet = loadOrCreateKey(join(keysDir, "faucet-devnet.json"));
const owner = loadOrCreateKey(join(keysDir, "devnet-owner.json"));
const backup = loadOrCreateKey(join(keysDir, "devnet-backup.json"));
const funderPath = arg("--funder");
if (funderPath) {
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(funderPath, "utf8"))));
  await topUp(funder, keeper.publicKey, KEEPER_SOL);
  await topUp(funder, faucet.publicKey, FAUCET_SOL);
}
console.log("keeper", keeper.publicKey.toBase58(), "lamports", await conn.getBalance(keeper.publicKey));
console.log("faucet", faucet.publicKey.toBase58(), "lamports", await conn.getBalance(faucet.publicKey));

const vars = readEnvFile();
if (!vars.DEVNET_QUOTE_MINT) {
  const mint = await createMint(conn, faucet, faucet.publicKey, null, config.solana.dbc.quoteDecimals);
  vars.DEVNET_QUOTE_MINT = mint.toBase58();
  console.log("created stand-in ZEC mint", vars.DEVNET_QUOTE_MINT, "(8 decimals, mint authority = faucet)");
}
const mintInfo = await getMint(conn, new PublicKey(vars.DEVNET_QUOTE_MINT!));
if (mintInfo.decimals !== 8 || !mintInfo.mintAuthority?.equals(faucet.publicKey) || mintInfo.freezeAuthority) throw new Error("the stand-in mint is not 8 decimals / faucet authority / no freeze authority");

// The pad's Zcash TESTNET treasury: a fresh devtool wallet (so the epoch's swap leg is a real testnet payment into it).
const ztDir = join(dataDir, "zcash-testnet");
const treasuryDir = join(ztDir, "treasury");
const treasuryIdentity = join(ztDir, "treasury.identity.age");
if (!existsSync(ztDir)) Bun.spawnSync(["mkdir", "-p", ztDir]);
initWallet(treasuryDir, "pad-treasury", treasuryIdentity);
chmodSync(treasuryIdentity, 0o600);
syncWallet(treasuryDir);
const treasuryUa = defaultUnifiedAddress(treasuryDir);

const bin = config.paths.zcashDevtoolBin;
Object.assign(vars, {
  PAD_MODE: "devnet",
  KEEPER_KEYPAIR_PATH: join(keysDir, "keeper-devnet.json"),
  DEVNET_OWNER_KEYPAIR: join(keysDir, "devnet-owner.json"),
  DEVNET_BACKUP_KEYPAIR: join(keysDir, "devnet-backup.json"),
  DEVNET_OWNER_PUBKEY: owner.publicKey.toBase58(),
  DEVNET_BACKUP_PUBKEY: backup.publicKey.toBase58(),
  TREASURY_WALLET_DIR: treasuryDir,
  TREASURY_IDENTITY_FILE: treasuryIdentity,
  TREASURY_ZCASH_ADDRESS: treasuryUa,
  ZCASH_DEVTOOL_BIN: bin,
  ZCASH_DEVTOOL_SHA256: createHash("sha256").update(readFileSync(bin)).digest("hex"),
  ZCASH_LIGHTWALLETD: config.zcash.lightwalletdServer,
});
const zFund = arg("--zcash-funding-dir");
const zFundId = arg("--zcash-funding-identity");
if (zFund && zFundId) Object.assign(vars, { DEVNET_ZCASH_FUNDING_DIR: zFund, DEVNET_ZCASH_FUNDING_IDENTITY: zFundId });
writeEnvFile(vars);
console.log("treasury testnet address", treasuryUa.slice(0, 14) + "…", "wallet", treasuryDir);
console.log("wrote", ENV_FILE, "(paths and public addresses only)");
