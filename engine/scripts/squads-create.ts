#!/usr/bin/env bun
// Creates the pad's Squads multisig as reviewed (audit/CONFIG-REVIEW.md section 5).
//   bun run squads:create -- --owner <pubkey> --backup <pubkey>
//       DRY RUN (the default): prints the members, permissions and settings, signs nothing.
//   bun run squads:create -- --owner <pubkey> --backup <pubkey> --i-understand-this-creates-a-permanent-multisig
//       REAL RUN: the keeper pays and signs one transaction; the account is read back and checked.
// The owner and backup keys are only addresses here: their keys are never needed.
import { PublicKey } from "@solana/web3.js";
import { MULTISIG_CREATE_FLAG, runMultisigCreate } from "../src/dbc/createMultisig";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const owner = arg("--owner");
const backup = arg("--backup");
if (!owner || !backup) {
  console.error(`usage: bun run squads:create -- --owner <pubkey> --backup <pubkey> [${MULTISIG_CREATE_FLAG}]`);
  process.exit(2);
}
const execute = process.argv.includes(MULTISIG_CREATE_FLAG);
const result = await runMultisigCreate({ owner: new PublicKey(owner), backup: new PublicKey(backup), execute });
for (const line of result.lines) console.log(line);
if (result.problems.length > 0) {
  console.log("\nREFUSED:");
  for (const p of result.problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(execute ? "\nDONE" : `\nDRY RUN: nothing was signed or sent. To create it, add ${MULTISIG_CREATE_FLAG}`);
