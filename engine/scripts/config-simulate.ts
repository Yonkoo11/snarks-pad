#!/usr/bin/env bun
// Asks the Meteora DBC PROGRAM, in simulation only, whether it accepts each reviewed tier's config as dbc/config.ts builds it (launch window included).
// Nothing is signed for the chain and nothing is sent: `simulateTransaction` runs the instruction against current state and throws the result away.
// This is the proof F-038 asked for when a scheduler value is new: "if the program refuses it, show the simulation error".
//   scripts/devnet.sh bun scripts/config-simulate.ts [--tier <bps>] [--payer <keypair file>]
// Payer: the Solana CLI default key (PROBE_PAYER_KEYPAIR or --payer overrides); it only has to hold the config account's rent for the simulation to run.
// Refuses mainnet: a mainnet check is the dry run of config-create, which signs nothing either.
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { buildConfigParams } from "../src/dbc/config";
import { TIER_MENU_BPS, windowScheduleOf } from "../src/dbc/reviewed";
import { getConnection, getDbcClient } from "../src/solana";

if (config.mode === "mainnet") throw new Error("config-simulate refuses mainnet: use the dry run of config:create");
const argAfter = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const payerPath = argAfter("--payer") ?? process.env.PROBE_PAYER_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))));
const only = argAfter("--tier");
const tiers = only ? [Number(only)] : [...TIER_MENU_BPS];

/** The program's verdict on one tier's config: the simulation's error and its first error line, or null error when it would be accepted. */
async function simulateTier(tierBps: number, vault: PublicKey): Promise<{ tierBps: number; accepted: boolean; err: string | null; log: string | null; units: number | null }> {
  const conn = getConnection();
  const cfg = Keypair.generate();
  const tx = await getDbcClient().partner.createConfig({
    config: cfg.publicKey, feeClaimer: vault, leftoverReceiver: vault, quoteMint: config.solana.dbc.quoteMint, payer: payer.publicKey, ...buildConfigParams(tierBps),
  });
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, cfg);
  const sim = await conn.simulateTransaction(tx);
  const log = (sim.value.logs ?? []).find((l) => /Error Code|Error Number|failed/.test(l)) ?? null;
  return { tierBps, accepted: !sim.value.err, err: sim.value.err ? JSON.stringify(sim.value.err) : null, log, units: sim.value.unitsConsumed ?? null };
}

const vault = config.solana.dbc.feeClaimer ?? payer.publicKey;
console.log(`cluster ${config.mode}, payer ${payer.publicKey.toBase58()}, fee claimer ${vault.toBase58()}, quote mint ${config.solana.dbc.quoteMint.toBase58()}`);
let refused = 0;
for (const t of tiers) {
  const w = windowScheduleOf(t === 100 ? config.solana.dbc.feeBps : t);
  const r = await simulateTier(t, vault);
  if (!r.accepted) refused++;
  console.log(`tier ${t} bps: cliff ${w.cliffNumerator}, ${w.periods} x ${w.periodSeconds} s, reduction ${w.reductionFactor}: program ${r.accepted ? "ACCEPTED (simulation)" : "REFUSED"}${r.units ? `, ${r.units} compute units` : ""}${r.err ? `, error ${r.err}` : ""}${r.log ? `, ${r.log}` : ""}`);
}
process.exit(refused === 0 ? 0 : 1);
