#!/usr/bin/env bun
// Scenario 1 setup (audit/STRESS-REPORT.md): three coins (1% curve "A", 6% tier "B", "C" graduated to DAMM v2),
// >=2,000 holder wallets, >=700 opted in through the HTTP API with real regtest unified addresses (one zcash-devtool
// account each, so every recipient's balance can be read on its own), >=3,000 swaps from many trader wallets.
// Needs: a fresh local chain (`bun run local:up`), the API running on PAD_API_PORT with the same PAD_DB_FILE.
// Writes $STRESS_DIR/scale-wallets.json (0600; throwaway local keys).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { config } from "../src/config";
import * as db from "../src/db";
import { getDbcClient } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { createDbcConfig, ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx } from "../src/dbc/trade";
import { readCurveStage, reconcileMigration } from "../src/dbc/migrate";
import { optinMessage } from "../src/optin/message";
import {
  STRESS_DIR, airdrop, direct, distributeTokens, fundSol, kpToJson, mintZecTo, pool, sendV0,
} from "./lib";
import { makeRecipientWallets, type Recipient } from "./zrecipients";

const N_HOLDERS = Number(process.env.HOLDERS ?? 2100);
const N_OPTIN = Number(process.env.OPTIN ?? 720);
const N_TRADERS = Number(process.env.TRADERS ?? 240);
const N_SWAPS = Number(process.env.SWAPS ?? 3200);
const N_DUST = Number(process.env.DUST ?? 60);
const ZW_NAME = Bun.env.ZW ?? "zw";
const OUT_NAME = Bun.env.OUT ?? "scale-wallets.json";
const API = `http://127.0.0.1:${config.api.port}/api`;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

async function launch(creator: Keypair, symbol: string, feeTier?: number): Promise<string> {
  const { txBase64, mint } = await buildLaunchTx({
    creator: creator.publicKey.toBase58(), name: `Stress ${symbol}`, symbol, description: "stress", imageUrl: "",
    initialBuyZats: "20000000", ...(feeTier ? { feeTier } : {}),
  });
  await confirmLaunch(await sendV0(txBase64, creator), mint);
  await waitForCoinWindow(mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
  return mint;
}

async function tokenBalance(owner: PublicKey, mint: string): Promise<bigint> {
  try {
    return (await getAccount(direct, getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function trade(kp: Keypair, mint: string, side: "buy" | "sell", amount: bigint): Promise<string> {
  const { txBase64 } = await buildTradeTx({ wallet: kp.publicKey.toBase58(), mint, side, amount: amount.toString(), slippageBps: 2000 });
  return sendV0(txBase64, kp);
}

async function fillCurve(poolId: string, whale: Keypair): Promise<number> {
  let buys = 0;
  while ((await readCurveStage(poolId)) === "open" && buys < 20) {
    const tx = await getDbcClient().pool.swap2({
      owner: whale.publicKey, pool: new PublicKey(poolId), swapMode: SwapMode.PartialFill, amountIn: new BN(400_000_000),
      minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null,
    });
    await sendAndConfirmTransaction(direct, tx, [whale], { commitment: "confirmed", skipPreflight: true });
    buys++;
  }
  return buys;
}

async function optIn(kp: Keypair, ua: string): Promise<void> {
  const wallet = kp.publicKey.toBase58();
  for (let attempt = 0; attempt < 5; attempt++) {
    const n = await fetch(`${API}/optin/nonce?wallet=${wallet}`);
    if (n.status !== 200) throw new Error(`nonce ${n.status}`);
    const { nonce } = (await n.json()) as { nonce: string };
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(optinMessage(wallet, ua, nonce)), kp.secretKey));
    const r = await fetch(`${API}/optin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, zcashAddress: ua, nonce, signature }) });
    if (r.status === 200) return;
    const body = await r.text();
    if (r.status !== 429) throw new Error(`optin ${r.status} ${body}`);
    await Bun.sleep(500);
  }
  throw new Error("optin kept answering 429");
}

async function main(): Promise<void> {
  mkdirSync(STRESS_DIR, { recursive: true, mode: 0o700 });
  const keeper = loadKeeperKeypair();
  if ((await direct.getBalance(keeper.publicKey)) < 5e9) await airdrop(keeper.publicKey, 100); // a scenario's own keeper key starts empty
  await ensureDbcConfig();
  if (!db.listDbcConfigs().some((c) => c.feeBps === 600)) await createDbcConfig(keeper.publicKey, 600);
  log("configs", db.listDbcConfigs().map((c) => `${c.feeBps}bps ${c.configId.slice(0, 6)}`).join(", "));

  const bank = Keypair.generate();
  await airdrop(bank.publicKey, 500);
  const creators = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const dists = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  await fundSol(bank, [...creators, ...dists].map((k) => k.publicKey), 30);
  await mintZecTo([...creators, ...dists].map((k) => k.publicKey), 2_000_000_000n); // 20 ZEC each
  const mintA = await launch(creators[0]!, "STA");
  const mintB = await launch(creators[1]!, "STB", 600);
  const mintC = await launch(creators[2]!, "STC");
  log("launched A", mintA, "B(6%)", mintB, "C", mintC);

  // Distributors take a large position in A and B; C's distributor fills C's curve, then C graduates (permissionless).
  await trade(dists[0]!, mintA, "buy", 250_000_000n);
  await trade(dists[1]!, mintB, "buy", 250_000_000n);
  const coinC = db.getCoin(mintC)!;
  const fills = await fillCurve(coinC.poolId!, dists[2]!);
  const migrated = await reconcileMigration(db.getCoin(mintC)!, keeper.publicKey);
  log("C curve filled in", fills, "buys; migrated:", !!migrated.dammPool, migrated.dammPool);

  // Holders: the first N_OPTIN hold all three coins at about twice the weight; the rest hold a random subset.
  const holders = Array.from({ length: N_HOLDERS }, () => Keypair.generate());
  const optins = holders.slice(0, N_OPTIN);
  const plain = holders.slice(N_OPTIN);
  const dust = plain.slice(0, N_DUST);
  const mints = [mintA, mintB, mintC];
  const plan: Record<string, { to: PublicKey; units: number }[]> = { [mintA]: [], [mintB]: [], [mintC]: [] };
  for (const h of optins) for (const m of mints) plan[m]!.push({ to: h.publicKey, units: rand(1.6, 2.4) });
  for (const h of plain.slice(N_DUST)) {
    const pick = [Math.random() < 0.8, Math.random() < 0.5, Math.random() < 0.5];
    if (!pick.some(Boolean)) pick[0] = true;
    mints.forEach((m, i) => pick[i] && plan[m]!.push({ to: h.publicKey, units: rand(0.5, 1.5) }));
  }
  for (let i = 0; i < mints.length; i++) {
    const m = mints[i]!;
    const available = (await tokenBalance(dists[i]!.publicKey, m)) * 85n / 100n;
    const totalUnits = plan[m]!.reduce((a, x) => a + x.units, 0);
    const items = plan[m]!.map((x) => ({ to: x.to, raw: BigInt(Math.floor((Number(available) * x.units) / totalUnits)) }));
    if (i === 0) for (const d of dust) items.push({ to: d.publicKey, raw: BigInt(1 + Math.floor(Math.random() * 100)) });
    const errs = await pool(chunkArr(items, 64), 6, (batch) => distributeTokens(dists[i]!, new PublicKey(m), batch));
    if (errs.length) throw errs[0];
    log("distributed", m.slice(0, 6), "to", items.length, "holders");
  }
  // Half of the non-opted holders already have a ZEC account (the other half get one only when their share pays the rent).
  const withZec = plain.filter((_, i) => i % 2 === 0).map((k) => k.publicKey);
  {
    const errs = await pool(chunkArr(withZec, 60), 6, (b) => mintZecTo(b, 0n, 10));
    if (errs.length) throw errs[0];
  }
  log("pre-created ZEC accounts for", withZec.length, "plain holders");

  // Traders: buy then sell everything, on A, B and the graduated C, from many wallets at once.
  const traders = Array.from({ length: N_TRADERS }, () => Keypair.generate());
  await fundSol(bank, traders.map((k) => k.publicKey), 1);
  {
    const errs = await pool(chunkArr(traders.map((k) => k.publicKey), 30), 6, (b) => mintZecTo(b, 3_000_000_000n));
    if (errs.length) throw errs[0];
  }
  let swaps = 0;
  let swapErrors = 0;
  const cycles = Math.ceil(N_SWAPS / 2);
  const tradeErrs = await pool(Array.from({ length: cycles }, (_, i) => i), 16, async (i) => {
    const kp = traders[i % traders.length]!;
    const r = Math.random();
    const mint = r < 0.45 ? mintA : r < 0.8 ? mintB : mintC;
    try {
      await trade(kp, mint, "buy", BigInt(Math.floor(rand(4e6, 16e6))));
      swaps++;
      const bal = await tokenBalance(kp.publicKey, mint);
      if (bal > 0n) {
        await trade(kp, mint, "sell", bal);
        swaps++;
      }
    } catch (e) {
      swapErrors++;
      if (swapErrors < 5) log("swap error", (e as Error).message.slice(0, 200));
    }
    if (swaps % 500 < 2) log("swaps", swaps);
  });
  log("swaps done:", swaps, "errors:", swapErrors, tradeErrs.length);

  // Zcash recipients: one devtool account per opted-in holder, then opt in through the API.
  const recipients: Recipient[] = makeRecipientWallets(join(STRESS_DIR, ZW_NAME), N_OPTIN, 90);
  log("zcash recipient accounts:", recipients.length);
  const optErrs = await pool(optins.map((k, i) => ({ k, ua: recipients[i]!.ua })), 8, ({ k, ua }) => optIn(k, ua));
  if (optErrs.length) throw new Error(`${optErrs.length} opt-ins failed: ${optErrs[0]!.message}`);
  log("opted in via API:", optins.length, "active in DB:", db.listActiveOptins().length);

  const out = {
    mints: { A: mintA, B: mintB, C: mintC },
    keeper: keeper.publicKey.toBase58(),
    creators: creators.map(kpToJson), dists: dists.map(kpToJson),
    holders: holders.map((k) => k.publicKey.toBase58()),
    optins: optins.map((k, i) => ({ wallet: k.publicKey.toBase58(), walletDir: recipients[i]!.walletDir, account: recipients[i]!.account })),
    dust: dust.map((k) => k.publicKey.toBase58()),
    traders: traders.map((k) => k.publicKey.toBase58()),
    swaps, swapErrors, setupSeconds: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(join(STRESS_DIR, OUT_NAME), JSON.stringify(out), { mode: 0o600 });
  log("setup complete", { holders: holders.length, optins: optins.length, swaps, swapErrors });
}

function chunkArr<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("scale setup failed:", e);
  process.exit(1);
});
