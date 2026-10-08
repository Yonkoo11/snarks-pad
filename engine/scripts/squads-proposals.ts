#!/usr/bin/env bun
// The owner's tool for Squads custody (Option B). Reads only; the keeper key is
// never loaded here.
//   bun scripts/squads-proposals.ts list                      proposals waiting for approval, each decoded from the
//                                                             STORED message: who would be paid, and what is wrong if anything
//   bun scripts/squads-proposals.ts approve <index> <keypair> approve one proposal with the member keypair at <keypair>
//                                                             (a local/devnet convenience; on mainnet approve from the owner's
//                                                             wallet after reading the same decode)
// SQUADS_MULTISIG must name the multisig.
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { approveProposal, describeProposal, listActiveProposals } from "../src/dbc/squads";
import { assertStartable } from "../src/startupChecks";

assertStartable("keeper", config.mode); // reads proposals from the configured RPC: on mainnet that must be the pad's own (audit S6)
const multisig = config.solana.dbc.squadsMultisig;
if (!multisig) throw new Error("set SQUADS_MULTISIG");
const [cmd, indexArg, keypairPath] = process.argv.slice(2);

if (cmd === "list") {
  const proposals = await listActiveProposals(getConnection(), multisig);
  console.log(proposals.length ? proposals.map((p) => p.text).join("\n\n") : "no proposal is waiting for approval");
} else if (cmd === "approve" && indexArg && keypairPath) {
  const index = BigInt(indexArg);
  const described = await describeProposal(getConnection(), multisig, index);
  console.log(described.text);
  if (described.unknownInstructions.length > 0) throw new Error("refusing to approve: the proposal contains an instruction this pad never makes");
  const member = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  console.log("approved, signature", await approveProposal(getConnection(), multisig, index, member));
} else {
  console.error("usage: list | approve <index> <member-keypair-file>");
  process.exit(1);
}
