#!/usr/bin/env bun
// D-2 on devnet: after `config-create --tier` made the tier configs,
//   scripts/devnet.sh bun scripts/devnet-tiers.ts launch   launches one coin on the 2% tier and one on the 6% tier, makes buys and a
//                                                         sell with the seeded test wallets, and compares what the pool accrued for
//                                                         Meteora, the creator and the pad with the model (src/dbc/tiers.ts)
//   scripts/devnet.sh bun scripts/devnet-tiers.ts claim    each creator claims their own fee with their own key; prints the amounts
// then an ordinary epoch (scripts/devnet-epoch.ts) claims the pad's part through the Squads vault. Test keys only (data/devnet-wallets.json,
// 0600, gitignored). Nothing here touches mainnet; it refuses to run outside devnet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "../src/config";
import * as db from "../src/db";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx, recordTrade } from "../src/dbc/trade";
import { buildCreatorClaimTx, readCreatorFees } from "../src/dbc/creatorClaim";
import { feeNumeratorOf, splitSwapFee } from "../src/dbc/tiers";
import { REVIEWED_TIERS } from "../src/dbc/reviewed";
import { loadFaucetKeypair } from "../src/faucet";
import { getConnection, getDbcClient } from "../src/solana";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");
const QUOTE = config.solana.dbc.quoteMint;
const phase = process.argv[2];
const wallets = JSON.parse(readFileSync(join(config.paths.dataDir, "devnet-wallets.json"), "utf8")) as { defaults: string[] };
const kp = (s: string) => Keypair.fromSecretKey(bs58.decode(s));
const [walletA, walletB] = wallets.defaults.map(kp) as [Keypair, Keypair];
// 2% coin: A creates, B buys. 6% coin: B creates, A buys. Both are holders of both coins.
const PLAN = [
  { tier: 200, symbol: "TIER2", name: "Two Percent", creator: walletA, buyer: walletB },
  { tier: 600, symbol: "TIER6", name: "Six Percent", creator: walletB, buyer: walletA },
] as const;
const FIRST_BUY = 100_000_000n; // 1 stand-in ZEC
const SECOND_BUY = 123_456_789n;

async function send(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]); // keeps the new mint's signature the server already added on launch
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function zecOf(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(QUOTE, owner, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

/** The test wallets hold stand-in ZEC from the faucet mint; top up from the same mint authority when short. */
async function ensureZec(w: Keypair, atLeast: bigint): Promise<void> {
  if ((await zecOf(w.publicKey)) >= atLeast) return;
  const faucet = loadFaucetKeypair();
  const ata = (await getOrCreateAssociatedTokenAccount(getConnection(), faucet, QUOTE, w.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(getConnection(), faucet, QUOTE, ata, faucet, 500_000_000n);
}

async function poolFees(poolId: string) {
  const s = (await getDbcClient().state.getPool(poolId))!.poolState;
  return { partner: BigInt(s.partnerQuoteFee.toString()), creator: BigInt(s.creatorQuoteFee.toString()), protocol: BigInt(s.protocolQuoteFee.toString()) };
}

async function trade(mint: string, w: Keypair, side: "buy" | "sell", amount: bigint): Promise<string> {
  const params = { wallet: w.publicKey.toBase58(), mint, side, amount: amount.toString(), slippageBps: 500 };
  const { txBase64, quote } = await buildTradeTx(params);
  const sig = await send(txBase64, w);
  recordTrade(sig, params, quote);
  console.log(`${side.toUpperCase()} ${w.publicKey.toBase58()} ${amount} ${side === "buy" ? "zats" : "raw tokens"}: ${sig}`);
  return sig;
}

async function launchAll(): Promise<void> {
  for (const p of PLAN) {
    const spec = REVIEWED_TIERS[p.tier]!;
    await ensureZec(p.creator, 3n * FIRST_BUY);
    await ensureZec(p.buyer, 3n * FIRST_BUY);
    let coin = db.listCoins().find((c) => c.symbol === p.symbol && c.status === "launched");
    if (!coin) {
      const l = await buildLaunchTx({ creator: p.creator.publicKey.toBase58(), name: p.name, symbol: p.symbol, description: `a ${p.tier / 100}% creator-fee coin (devnet test)`, imageUrl: "", initialBuyZats: FIRST_BUY.toString(), feeTier: p.tier });
      const sig = await send(l.txBase64, p.creator);
      await confirmLaunch(sig, l.mint);
      await waitForCoinWindow(l.mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
      coin = db.getCoin(l.mint)!;
      console.log(`LAUNCH ${p.symbol} tier ${p.tier} bps mint ${l.mint} pool ${coin.poolId} config ${coin.configId} creator ${p.creator.publicKey.toBase58()}: ${sig}`);
      const num = feeNumeratorOf(p.tier);
      const first = splitSwapFee(FIRST_BUY, num, spec.creatorFeePercentage);
      const f1 = await poolFees(coin.poolId!);
      console.log(`  after the first buy (${FIRST_BUY} zats): pool partner/creator/protocol = ${f1.partner}/${f1.creator}/${f1.protocol}; model = ${first.partner}/${first.creator}/${first.meteora}; ${f1.partner === first.partner && f1.creator === first.creator && f1.protocol === first.meteora ? "EQUAL" : "DIFFERENT"}`);
      await trade(coin.mint, p.buyer, "buy", SECOND_BUY);
      const second = splitSwapFee(SECOND_BUY, num, spec.creatorFeePercentage);
      const f2 = await poolFees(coin.poolId!);
      const d = { partner: f2.partner - f1.partner, creator: f2.creator - f1.creator, protocol: f2.protocol - f1.protocol };
      console.log(`  after the second buy (${SECOND_BUY} zats): delta partner/creator/protocol = ${d.partner}/${d.creator}/${d.protocol}; model = ${second.partner}/${second.creator}/${second.meteora}; ${d.partner === second.partner && d.creator === second.creator && d.protocol === second.meteora ? "EQUAL" : "DIFFERENT"}`);
      const tokenAta = getAssociatedTokenAddressSync(new PublicKey(coin.mint), p.buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const held = (await getAccount(getConnection(), tokenAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const before = f2;
      const zecBefore = await zecOf(p.buyer.publicKey);
      await trade(coin.mint, p.buyer, "sell", held / 3n);
      const f3 = await poolFees(coin.poolId!);
      const dd = { partner: f3.partner - before.partner, creator: f3.creator - before.creator, protocol: f3.protocol - before.protocol };
      const whole = dd.partner + dd.creator + dd.protocol;
      const gross = (await zecOf(p.buyer.publicKey)) - zecBefore + whole; // received + fee = the gross output the fee is taken from
      const sold = splitSwapFee(gross, num, spec.creatorFeePercentage);
      console.log(`  after the sell (gross ${gross} zats): delta partner/creator/protocol = ${dd.partner}/${dd.creator}/${dd.protocol}; model = ${sold.partner}/${sold.creator}/${sold.meteora}; ${dd.partner === sold.partner && dd.creator === sold.creator && dd.protocol === sold.meteora ? "EQUAL" : "DIFFERENT"}`);
    }
    const f = await readCreatorFees(coin.mint);
    console.log(`${p.symbol}: pool creator on chain ${f.creator}, creator fee waiting ${f.curveZats} zats, creator share ${f.creatorShareBps} bps of the fee`);
  }
}

async function claimAll(): Promise<void> {
  for (const p of PLAN) {
    const coin = db.listCoins().find((c) => c.symbol === p.symbol && c.status === "launched");
    if (!coin) throw new Error(`${p.symbol} is not launched: run the launch phase first`);
    const owed = (await readCreatorFees(coin.mint)).curveZats;
    const before = await zecOf(p.creator.publicKey);
    const stranger = await buildCreatorClaimTx(coin.mint, p.buyer.publicKey.toBase58()).then(() => "BUILT (bad)", (e: { code?: string }) => e.code);
    console.log(`${p.symbol}: a wallet that is not the creator asking for the claim -> ${stranger}`);
    const claim = await buildCreatorClaimTx(coin.mint, p.creator.publicKey.toBase58());
    const sig = await send(claim.txBase64, p.creator);
    const got = (await zecOf(p.creator.publicKey)) - before;
    console.log(`CLAIM ${p.symbol} by its creator ${p.creator.publicKey.toBase58()}: owed ${owed}, received ${got} zats, ${got === BigInt(owed) ? "EQUAL" : "DIFFERENT"}, left in pool ${(await readCreatorFees(coin.mint)).curveZats}: ${sig}`);
  }
}

if (phase === "launch") await launchAll();
else if (phase === "claim") await claimAll();
else throw new Error("usage: scripts/devnet.sh bun scripts/devnet-tiers.ts launch|claim");
