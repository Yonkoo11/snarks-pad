#!/usr/bin/env bun
// Creates the pad's permanent DBC config from the reviewed values (audit/CONFIG-REVIEW.md S1-H2).
//   bun run config:create -- --multisig <pda>
//       DRY RUN (the default): prints every field and the vault that becomes the fee claimer, signs nothing.
//   bun run config:create -- --multisig <pda> --i-understand-this-creates-a-permanent-config
//       REAL RUN: sends one transaction paid by the keeper, then reads the config back and checks every field.
//   bun run config:create -- --multisig <pda> --tier <bps> [--i-understand-this-creates-a-permanent-config]
//       the same for a creator-fee tier (audit/CONFIG-REVIEW-TIERS.md): 100 (the default, SNARKS), 200, 400, 600 or 1000.
// The multisig defaults to SQUADS_MULTISIG. The keeper key path is KEEPER_KEYPAIR_PATH; no secret is printed.
import { PublicKey } from "@solana/web3.js";
import { config } from "../src/config";
import { CONFIG_CREATE_FLAG, runConfigCreate } from "../src/dbc/createConfig";
import { DEFAULT_TIER_BPS, TIER_MENU_BPS, reviewedTier } from "../src/dbc/reviewed";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const tierArg = arg("--tier");
const tierBps = tierArg === undefined ? DEFAULT_TIER_BPS : /^\d+$/.test(tierArg) ? Number(tierArg) : Number.NaN;
if (!reviewedTier(tierBps)) {
  console.error(`--tier must be one of ${TIER_MENU_BPS.join(", ")} (bps); got ${JSON.stringify(tierArg)}. A tier is a reviewed config: audit/CONFIG-REVIEW-TIERS.md`);
  process.exit(2);
}

const raw = arg("--multisig") ?? config.solana.dbc.squadsMultisig?.toBase58();
if (!raw) {
  console.error(`usage: bun run config:create -- --multisig <pda> [--tier <bps>] [${CONFIG_CREATE_FLAG}]`);
  process.exit(2);
}
const execute = process.argv.includes(CONFIG_CREATE_FLAG);
const result = await runConfigCreate({ multisig: new PublicKey(raw), execute, tierBps });
for (const line of result.lines) console.log(line);
if (result.problems.length > 0) {
  console.log("\nREFUSED:");
  for (const p of result.problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(execute ? "\nDONE" : `\nDRY RUN: nothing was signed or sent. To create it, add ${CONFIG_CREATE_FLAG}`);
