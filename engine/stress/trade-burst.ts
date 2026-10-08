#!/usr/bin/env bun
// Random buy-then-sell cycles on a scenario's coins from fresh trader wallets (audit/STRESS-REPORT.md).
//   bun stress/trade-burst.ts <wallets.json> <swaps> [traders=40] [concurrency=8]   stops after <swaps> landed swaps
//   SOAK_UNTIL=<epoch ms> ...                                                     keeps trading until then, slowly
// Uses the engine's trade builder (PAD_DB_FILE must be the scenario's DB) and sends straight to the validator.
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildTradeTx } from "../src/dbc/trade";
import { airdrop, direct, fundSol, mintZecTo, pool, sendV0 } from "./lib";

const [file, swapsArg, tradersArg, concArg] = process.argv.slice(2);
const W = JSON.parse(readFileSync(file!, "utf8")) as { mints: Record<string, string> };
const target = Number(swapsArg ?? 100);
const soakUntil = Number(Bun.env.SOAK_UNTIL ?? 0);
const mints = Object.values(W.mints);

async function bal(owner: PublicKey, mint: string): Promise<bigint> {
  try {
    return (await getAccount(direct, getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

async function swap(kp: Keypair, mint: string, side: "buy" | "sell", amount: bigint): Promise<void> {
  const { txBase64 } = await buildTradeTx({ wallet: kp.publicKey.toBase58(), mint, side, amount: amount.toString(), slippageBps: 2000 });
  await sendV0(txBase64, kp);
}

const traders = Array.from({ length: Number(tradersArg ?? 40) }, () => Keypair.generate());
const bank = Keypair.generate();
await airdrop(bank.publicKey, traders.length * 1.2 + 1);
await fundSol(bank, traders.map((k) => k.publicKey), 1);
await mintZecTo(traders.map((k) => k.publicKey), 5_000_000_000n);
let landed = 0, failed = 0;
const started = Date.now();
const done = () => (soakUntil ? Date.now() >= soakUntil : landed >= target);
await pool(traders, Number(concArg ?? 8), async (kp) => {
  while (!done()) {
    const mint = mints[Math.floor(Math.random() * mints.length)]!;
    try {
      await swap(kp, mint, "buy", BigInt(Math.floor(4e6 + Math.random() * 12e6)));
      landed++;
      const b = await bal(kp.publicKey, mint);
      if (b > 0n) {
        if (soakUntil) await Bun.sleep(Math.random() * 20_000); // holds for a while: sometimes across a holder sample
        await swap(kp, mint, "sell", b);
        landed++;
      }
    } catch {
      failed++;
    }
    if (soakUntil) await Bun.sleep(2_000 + Math.random() * 8_000);
  }
});
console.log(JSON.stringify({ landed, failed, seconds: Math.round((Date.now() - started) / 1000) }));
process.exit(0);
