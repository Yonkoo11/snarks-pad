#!/usr/bin/env bun
// Creates the pad's DBC config (once), launches SNARKS with a creator first
// buy, and simulates buyers: 2 default holders, 3 opted-in holders with real
// regtest unified addresses, one SMALL opted-in holder (its share lands below
// the shielded per-holder minimum, so it must carry) and one wallet that gets a
// few tokens by transfer and has no ZEC account (its share lands below the
// new-account rent, so it must carry). Writes engine/data/seed-wallets.json
// (gitignored) so scripts/e2e.ts can check balances against these keypairs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx, recordTrade } from "../src/dbc/trade";
import { issueNonce, registerOptin } from "../src/optin/registry";
import { optinMessage } from "../src/optin/message";
import { initWallet, defaultUnifiedAddress } from "../src/zcash/devtool";

const BUY_ZATS = 80_000_000n; // 0.8 Solana ZEC per full buyer
const SMALL_BUY_ZATS = 8_000_000n; // the small opted-in buyer: its share lands between the 5,000 dust floor and the 100,000 shielded minimum
const CREATOR_FIRST_BUY_ZATS = 20_000_000n; // total buys stay well under the 6.67 ZEC migration threshold
const AIRDROP_SOL = 5e9;
const AIRDROP_ZEC = 500_000_000n; // 5 ZEC test tokens

async function fundWallet(kp: Keypair): Promise<void> {
  const conn = getConnection();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, AIRDROP_SOL), "confirmed");
  const quoteMint = config.solana.dbc.quoteMint;
  const keeper = loadKeeperKeypair();
  const ata = (await getOrCreateAssociatedTokenAccount(conn, keeper, quoteMint, kp.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(conn, keeper, quoteMint, ata, keeper, AIRDROP_ZEC);
}

async function signAndSend(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]); // keeps the mint's signature the server already added on launch
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function launchSnarks(creator: Keypair): Promise<string> {
  const { txBase64, mint } = await buildLaunchTx({
    creator: creator.publicKey.toBase58(),
    name: "Snarks",
    symbol: "SNARKS",
    description: "The pad's launch coin. RELEASE THE SNARKS.",
    imageUrl: "/mascot.jpg",
    initialBuyZats: CREATOR_FIRST_BUY_ZATS.toString(),
  });
  const sig = await signAndSend(txBase64, creator);
  await confirmLaunch(sig, mint);
  await waitForCoinWindow(mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  console.log("launched SNARKS", mint, "tx", sig);
  return mint;
}

async function buy(mint: string, buyer: Keypair, zats: bigint = BUY_ZATS): Promise<void> {
  const params = { wallet: buyer.publicKey.toBase58(), mint, side: "buy" as const, amount: zats.toString(), slippageBps: 500 };
  const { txBase64, quote } = await buildTradeTx(params);
  const sig = await signAndSend(txBase64, buyer);
  recordTrade(sig, params, quote);
  console.log("buy", buyer.publicKey.toBase58().slice(0, 8), "tx", sig);
}

function signOptin(kp: Keypair, zcashAddress: string): { nonce: string; signature: string } {
  const { nonce } = issueNonce(kp.publicKey.toBase58());
  const message = optinMessage(kp.publicKey.toBase58(), zcashAddress, nonce);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  return { nonce, signature };
}

/** The creator sends a sixteenth of its tokens to a wallet that has no ZEC token account (a wallet-to-wallet send pays no fee). Its share must land between the 5,000-zat dust floor and the 30,000-zat new-account threshold: an eighth landed at 31,768 and was paid. */
async function sendTokensToNewWallet(creator: Keypair, mint: string, to: PublicKey): Promise<void> {
  const conn = getConnection();
  const mintKey = new PublicKey(mint);
  const from = getAssociatedTokenAddressSync(mintKey, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dest = getAssociatedTokenAddressSync(mintKey, to, false, TOKEN_2022_PROGRAM_ID);
  const balance = (await getAccount(conn, from, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, dest, to, mintKey, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(from, mintKey, dest, creator.publicKey, balance / 16n, config.solana.dbc.baseDecimals, [], TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, tx, [creator], { commitment: "confirmed" });
  console.log("sent", (balance / 16n).toString(), "raw tokens to a wallet with no ZEC account", to.toBase58().slice(0, 8));
}

async function main(): Promise<void> {
  await ensureDbcConfig();

  const creator = Keypair.generate();
  await fundWallet(creator);
  const mint = await launchSnarks(creator);

  const defaultBuyers = [Keypair.generate(), Keypair.generate()];
  const optinBuyers = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()]; // the last one is the small holder
  const noAccountWallet = Keypair.generate();

  for (const kp of [...defaultBuyers, ...optinBuyers]) {
    await fundWallet(kp);
    await buy(mint, kp, kp === optinBuyers[3] ? SMALL_BUY_ZATS : BUY_ZATS);
  }
  await sendTokensToNewWallet(creator, mint, noAccountWallet.publicKey);

  const optinWalletDirs = optinBuyers.map((_, i) => join(config.paths.zcashWorkDir, "wallets", `optin-${i}`));
  const optinIdentities = optinBuyers.map((_, i) => join(config.paths.zcashWorkDir, "wallets", `optin-${i}.identity.age`));
  const registered: { wallet: string; zcashAddressMasked: string }[] = [];
  for (let i = 0; i < optinBuyers.length; i++) {
    initWallet(optinWalletDirs[i]!, `optin-${i}`, optinIdentities[i]!);
    const ua = defaultUnifiedAddress(optinWalletDirs[i]!);
    const kp = optinBuyers[i]!;
    const { nonce, signature } = signOptin(kp, ua);
    const result = registerOptin(kp.publicKey.toBase58(), ua, nonce, signature);
    if (!result.ok) throw new Error(`seed opt-in failed for wallet ${i}: ${result.error}`);
    registered.push({ wallet: kp.publicKey.toBase58(), zcashAddressMasked: ua.slice(0, 12) + "…" });
    console.log("registered opt-in", kp.publicKey.toBase58().slice(0, 8), "->", ua.slice(0, 12) + "…");
  }

  mkdirSync(config.paths.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(config.paths.dataDir, "seed-wallets.json"),
    JSON.stringify(
      {
        mint,
        creator: bs58.encode(creator.secretKey),
        defaultBuyers: defaultBuyers.map((k) => bs58.encode(k.secretKey)),
        optinBuyers: optinBuyers.map((k, i) => ({ secretKey: bs58.encode(k.secretKey), walletDir: optinWalletDirs[i] })),
        noAccountWallet: bs58.encode(noAccountWallet.secretKey),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("seed complete. mint:", mint, "holders: creator + 2 default + 1 without a ZEC account +", registered.length, "opted-in");
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
