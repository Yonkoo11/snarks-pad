#!/usr/bin/env bun
// Chaos setup, part 2 (audit/STRESS-REPORT.md scenario 3): after stress/scale-setup.ts made the scenario's keeper
// coins, this adds a Squads v4 multisig (owner + backup + the keeper, threshold 2; test/helpers/squads-local.ts), a DBC
// config whose fee claimer is its vault, and a coin S on it bought by 12 fresh wallets. Every claim of S is a vault
// proposal the owner must approve (the chaos driver approves as the owner). Appends S and the multisig to the wallets file.
//   bun stress/chaos-squads.ts <wallets.json>
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { loadKeeperKeypair } from "../src/keeper";
import { createDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { waitForCoinWindow } from "../src/dbc/windowWait";
import { buildTradeTx } from "../src/dbc/trade";
import { createLocalMultisig } from "../test/helpers/squads-local";
import { airdrop, fundSol, kpToJson, mintZecTo, sendV0 } from "./lib";

const file = process.argv[2]!;
const W = JSON.parse(readFileSync(file, "utf8"));
const keeper = loadKeeperKeypair();
const ms = await createLocalMultisig(keeper);
await createDbcConfig(ms.vault);
const creator = Keypair.generate();
const buyers = Array.from({ length: 12 }, () => Keypair.generate());
const bank = Keypair.generate();
await airdrop(bank.publicKey, 50);
await fundSol(bank, [creator, ...buyers].map((k) => k.publicKey), 2);
await mintZecTo([creator, ...buyers].map((k) => k.publicKey), 2_000_000_000n);
const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: "Stress Vault", symbol: "SVLT", description: "fee claimer is a Squads vault", imageUrl: "", initialBuyZats: "20000000" });
await confirmLaunch(await sendV0(txBase64, creator), mint);
await waitForCoinWindow(mint); // a trade in the first seconds would pay the launch window's fee, not the tier's
for (const [i, b] of buyers.entries()) {
  const t = await buildTradeTx({ wallet: b.publicKey.toBase58(), mint, side: "buy", amount: String(20_000_000 + i * 2_000_000), slippageBps: 2000 });
  await sendV0(t.txBase64, b);
}
W.mints.S = mint;
W.squads = { multisig: ms.multisigPda.toBase58(), vault: ms.vault.toBase58(), owner: kpToJson(ms.owner) };
writeFileSync(file, JSON.stringify(W), { mode: 0o600 });
console.log("vault coin", mint, "multisig", ms.multisigPda.toBase58());
process.exit(0);
