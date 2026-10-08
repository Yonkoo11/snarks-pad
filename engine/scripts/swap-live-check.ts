#!/usr/bin/env bun
// ONE real NEAR 1Click swap on mainnet, end to end, through the same adapter the
// epoch engine uses: keeper Solana ZEC -> 1Click -> native ZEC in the treasury
// wallet. Plan step P3 / probe F-030 repeated through engine code.
//
//   bun run swap:live-check -- --amount 1000000
//       DRY RUN (the default). Checks the environment, reads balances, takes one
//       DRY quote, and prints what a real run would do and what it needs. Sends
//       nothing, signs nothing.
//
//   bun run swap:live-check -- --amount 1000000 --i-understand-this-moves-real-money
//       REAL RUN. Signs and sends one Solana ZEC deposit. Re-run the same command
//       (same --key) to resume after any interruption: it never sends a second one.
//
// Environment (no secret is read by this file beyond the keypair PATH):
//   PAD_MODE=mainnet                 KEEPER_KEYPAIR_PATH=<keypair json>
//   TREASURY_ZCASH_ADDRESS=<u1...>   TREASURY_WALLET_DIR=<zcash-devtool wallet dir that owns it>
//   ZCASH_LIGHTWALLETD=zec.rocks:443 SOLANA_MAINNET_RPC=<a keyed RPC; the public one rate-limits>
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { existsSync } from "node:fs";
import { config, ZEC_MINT_MAINNET } from "../src/config";
import * as db from "../src/db";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import { makeNear1ClickAdapter, walletReceipt } from "../src/swap/near1click";
import { makeSolanaDepositChain } from "../src/swap/near1click-chain";
import { buildQuoteRequest, makeOneClickClient, originAssetFor, verifyQuoteSignature } from "../src/swap/near1click-api";
import { balanceProblems, fundingNeeds, type FundingNeeds } from "../src/swap/live-readiness";
import { SwapFundsMayHaveMoved, type SwapSettlement } from "../src/swap/types";
import { checkZcashAddress } from "../src/zcash/address";
import { walletOwnsAddress } from "../src/zcash/devtool";

const REAL_FLAG = "--i-understand-this-moves-real-money";
const F030_TXID = "8007e1086ab46274be507a694ecaef4ddaff8a0e9fe52b930fa88a22ab1478a5"; // a known delivery to the owner's pad-main wallet
const F030_ZATS = 375_000n;
const MIN_SOL_LAMPORTS = 3_500_000n; // the deposit address's token account rent (~1.49M at the F-030 slot) + fee + margin
const MAX_WAIT_MS = 25 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const zec = (zats: bigint): string => `${zats / 100_000_000n}.${(zats % 100_000_000n).toString().padStart(8, "0")} ZEC`;
const problems: string[] = [];
const need = (ok: boolean, message: string): void => {
  if (!ok) problems.push(message);
};
const say = (line = ""): void => console.log(line);

function parseAmount(): bigint {
  const raw = arg("--amount");
  if (!raw || !/^[0-9]{1,12}$/.test(raw)) {
    say("usage: bun run swap:live-check -- --amount <zats> [--key <name>] [--submit-deposit] [" + REAL_FLAG + "]");
    process.exit(1);
  }
  return BigInt(raw);
}

async function checkEnvironment(amount: bigint) {
  need(config.mode === "mainnet", `PAD_MODE must be mainnet (it is ${config.mode})`);
  need(!!process.env.KEEPER_KEYPAIR_PATH && existsSync(config.paths.keeperKeypair), "KEEPER_KEYPAIR_PATH must point at the keeper keypair file");
  need(!!process.env.TREASURY_ZCASH_ADDRESS, "TREASURY_ZCASH_ADDRESS is not set");
  need(!!config.near1click.treasuryWalletDir && existsSync(config.near1click.treasuryWalletDir), "TREASURY_WALLET_DIR must be the treasury's zcash-devtool wallet directory");
  need(config.zcash.lightwalletdServer !== "127.0.0.1:8137", "ZCASH_LIGHTWALLETD is still the regtest default; use a mainnet server such as zec.rocks:443");
  need(amount >= config.near1click.minSwapZats, `--amount ${amount} is below the ${config.near1click.minSwapZats} zats floor`);
  need(amount <= config.near1click.maxSwapZats, `--amount ${amount} is above the ${config.near1click.maxSwapZats} zats cap`);
  need(config.solana.dbc.quoteMint.equals(ZEC_MINT_MAINNET), "the quote mint is not the mainnet ZEC mint");
  if (problems.length) return null;
  const treasury = process.env.TREASURY_ZCASH_ADDRESS!;
  const walletDir = config.near1click.treasuryWalletDir!;
  need(checkZcashAddress(treasury, "main").ok, "TREASURY_ZCASH_ADDRESS is not a mainnet unified address with a shielded receiver");
  need(walletOwnsAddress(walletDir, treasury), "TREASURY_ZCASH_ADDRESS is not an address of the wallet in TREASURY_WALLET_DIR (the swap would pay an address that wallet cannot spend)");
  return { treasury, walletDir, keeper: loadKeeperKeypair() };
}

async function checkBalances(keeper: PublicKey, amount: bigint, needs: FundingNeeds): Promise<void> {
  const conn = getConnection();
  const ata = getAssociatedTokenAddressSync(ZEC_MINT_MAINNET, keeper, false, TOKEN_PROGRAM_ID);
  const lamports = BigInt(await conn.getBalance(keeper, "confirmed"));
  const tokenBal = await conn.getTokenAccountBalance(ata, "confirmed").then((r) => BigInt(r.value.amount), () => 0n);
  const rent = await conn.getMinimumBalanceForRentExemption(165);
  say(`keeper Solana address : ${keeper.toBase58()}`);
  say(`keeper SOL            : ${Number(lamports) / 1e9} (needs >= ${Number(MIN_SOL_LAMPORTS) / 1e9}; the deposit address's token account costs ${rent} lamports now)`);
  say(`keeper ZEC (Solana)   : ${zec(tokenBal)} in ${ata.toBase58()} (${needs.zec ? `needs >= ${zec(amount)}` : "not needed: a deposit for this key already exists"})`);
  const want = { amountZats: amount, minLamports: MIN_SOL_LAMPORTS, keeper: keeper.toBase58(), zecAccount: ata.toBase58(), zecLabel: `${zec(amount)} (mint ${ZEC_MINT_MAINNET.toBase58()})` };
  for (const p of balanceProblems(needs, { lamports, zecZats: tokenBal }, want)) need(false, p);
}

async function checkQuote(keeper: PublicKey, treasury: string, amount: bigint): Promise<void> {
  const client = makeOneClickClient({ baseUrl: config.near1click.baseUrl, apiKey: config.near1click.apiKey });
  const body = buildQuoteRequest({ amountIn: amount, recipient: treasury, refundTo: keeper.toBase58(), originAsset: originAssetFor(ZEC_MINT_MAINNET.toBase58()), slippageBps: config.near1click.slippageBps, dry: true, deadlineMs: Date.now() + 30 * 60_000 });
  const quote = await client.quote(body).catch((e: Error) => (need(false, `dry quote failed: ${e.message}`), null));
  if (quote) {
    need(verifyQuoteSignature(quote), "the dry quote's signature does not verify");
    say(`dry quote             : ${zec(amount)} in -> ${zec(BigInt(quote.quote.amountOut))} out (min ${zec(BigInt(quote.quote.minAmountOut))}), withdraw fee ${quote.quote.withdrawFee} zats, ~${quote.quote.timeEstimate}s`);
  }
}

async function checkWallet(walletDir: string): Promise<void> {
  try {
    const known = await walletReceipt(walletDir)([F030_TXID]);
    say(`treasury wallet read  : ${known ? `F-030 tx reads ${known.zats} zats, ${known.confirmations} confirmations` : "synced; F-030 tx is not in this wallet (no known-answer check)"}`);
    if (known) need(known.zats === F030_ZATS, `the wallet reads ${known.zats} zats for the F-030 tx, expected ${F030_ZATS}: the settled amount would be wrong`);
  } catch (e) {
    need(false, `could not sync and read the treasury wallet: ${(e as Error).message}`);
  }
}

/** Simulates (never sends) the exact deposit transaction shape against mainnet, to a throwaway address. Only meaningful once funded. */
async function simulateDeposit(amount: bigint): Promise<void> {
  const chain = makeSolanaDepositChain({ keeper: loadKeeperKeypair(), mint: ZEC_MINT_MAINNET, priorityMicroLamports: config.near1click.priorityMicroLamports });
  const built = await chain.buildSignedDeposit(PublicKey.unique().toBase58(), amount);
  const res = await getConnection().simulateTransaction(VersionedTransaction.deserialize(built.rawTx), { sigVerify: false, replaceRecentBlockhash: true });
  say(`deposit simulation    : ${res.value.err ? "FAILED " + JSON.stringify(res.value.err) : `ok, ${res.value.unitsConsumed} compute units`} (nothing was sent)`);
  need(!res.value.err, "the deposit transaction does not simulate on mainnet");
}

function existingSwap(key: string): db.Near1ClickSwapRow | null {
  return existsSync(config.paths.dbFile) ? db.getNear1ClickSwap(key) : null;
}

function describeRow(row: db.Near1ClickSwapRow | null, key: string): void {
  if (row) say(`existing swap for key : ${key} is in phase ${row.phase}${row.note ? ` (${row.note})` : ""}; a real run resumes it`);
}

async function realRun(amount: bigint, key: string, treasury: string, walletDir: string, keeper: PublicKey): Promise<number> {
  const holder = `live-check:${process.pid}`;
  if (!db.tryAcquireLock("epoch", holder, 40 * 60_000)) {
    say("another epoch run holds the lock; refusing to run beside it");
    return 1;
  }
  try {
    const adapter = makeNear1ClickAdapter(treasury, { limits: { submitDepositHash: process.argv.includes("--submit-deposit") } as never });
    const started = Date.now();
    const t = () => `[+${Math.round((Date.now() - started) / 1000)}s]`;
    say(`${t()} submitting ${zec(amount)} (key ${key})`);
    let ref = key;
    try {
      ref = (await adapter.submit(amount, key)).ref;
      say(`${t()} deposit confirmed on Solana`);
    } catch (e) {
      if (!(e instanceof SwapFundsMayHaveMoved)) {
        say(`${t()} nothing was signed or sent: ${(e as Error).message}`);
        return 1;
      }
      say(`${t()} the deposit may have been sent but is not confirmed yet: ${e.message}; polling`);
    }
    const result = await pollUntilDone(adapter.status.bind(adapter), ref, started, t);
    return report(result, key, amount, keeper, t);
  } finally {
    db.releaseLock("epoch", holder);
  }
}

async function pollUntilDone(status: (ref: string) => Promise<SwapSettlement>, ref: string, started: number, t: () => string): Promise<SwapSettlement> {
  let last = "";
  for (;;) {
    const s = await status(ref);
    const line = `${s.status}${s.note ? `: ${s.note}` : ""}`;
    if (line !== last) say(`${t()} ${line}`);
    last = line;
    if (s.status !== "pending" || Date.now() - started > MAX_WAIT_MS) return s;
  }
}

function report(result: SwapSettlement, key: string, amount: bigint, keeper: PublicKey, t: () => string): number {
  const row = db.getNear1ClickSwap(key);
  say();
  say(`deposit signature : ${row?.signature ?? "none"}`);
  say(`deposit address   : ${row?.depositAddress ?? "none"}`);
  if (result.status === "settled") {
    say(`${t()} SETTLED: the treasury wallet received ${zec(result.amountOutZats!)} (${result.amountOutZats} zats) for ${zec(amount)} sent; cost ${amount - result.amountOutZats!} zats`);
    say(`zcash txid(s)     : ${row?.destinationTxids ?? "unknown"}`);
    return 0;
  }
  if (result.status === "returned") {
    say(`${t()} RETURNED: the ZEC is back in the keeper account ${keeper.toBase58()} (${row?.phase}); nothing was swapped`);
    return 2;
  }
  say(`${t()} STILL PENDING after ${Math.round(MAX_WAIT_MS / 60_000)} min: ${result.note ?? ""}. Re-run the same command to resume; it never sends a second deposit.`);
  return 3;
}

async function main(): Promise<number> {
  const amount = parseAmount();
  const key = arg("--key") ?? `live-check-${amount}`;
  const real = process.argv.includes(REAL_FLAG);
  say(real ? "REAL RUN: this moves real money." : "DRY RUN: nothing is signed or sent. Add " + REAL_FLAG + " for the real swap.");
  const env = await checkEnvironment(amount);
  if (!env) {
    for (const p of problems) say(`NOT READY: ${p}`);
    return 1;
  }
  say(`treasury address    : ${env.treasury.slice(0, 12)}... (owned by the treasury wallet)`);
  const row = existingSwap(key);
  const needs = fundingNeeds(row?.phase);
  await checkBalances(env.keeper.publicKey, amount, needs);
  if (needs.quoteAndSimulation) await checkQuote(env.keeper.publicKey, env.treasury, amount);
  await checkWallet(env.walletDir);
  if (needs.quoteAndSimulation && problems.length === 0) await simulateDeposit(amount);
  describeRow(row, key);
  say();
  if (problems.length) {
    for (const p of problems) say(`NOT READY: ${p}`);
    return 1;
  }
  if (!real) {
    say(`READY. To send it: bun run swap:live-check -- --amount ${amount} ${REAL_FLAG}`);
    return 0;
  }
  return realRun(amount, key, env.treasury, env.walletDir, env.keeper.publicKey);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("swap live check failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
