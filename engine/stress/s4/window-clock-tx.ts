#!/usr/bin/env bun
// S4 ST-LW-02, the decisive half: the clock a transaction LANDS under against the wall clock at the moment it was sent. The engine's feeNowBps reads
// the server's clock one second back (dbc/window.ts CLOCK_MARGIN_SECONDS); it is safe when, for a trade sent at wall time T, floor(T) - 1 <= the
// landing block's unix time, i.e. the chain's clock at landing trails the wall clock by less than the margin. Each probe is one self-transfer of
// 1 lamport: on the local validator from a fresh airdropped key, on devnet from this machine's own devnet key through the public endpoint
// (test SOL, ~5,000 lamports each). Prints per transaction: sent at, landed block time, lag, and whether the engine's second ran ahead.
//   bun stress/s4/window-clock-tx.ts local [n=10]
//   bun stress/s4/window-clock-tx.ts devnet [n=6]
//   MAINNET_PROBE_KEYPAIR=<file> SOLANA_MAINNET_RPC=<url> bun stress/s4/window-clock-tx.ts mainnet [n=6] --i-understand-this-sends-real-transactions
// The mainnet probe is the runbook's gate G14 (ops/MAINNET-RUNBOOK.md), run by the owner, never by an agent: it spends real SOL (about 5,000 lamports a probe) from a THROWAWAY key
// funded with 0.001 SOL, named only by MAINNET_PROBE_KEYPAIR (there is no default: not the devnet key, not the owner's). The RPC address is read from the environment and only its
// host is printed. It refuses to start without the flag, the key file and an https address, before any network call.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";

const which = process.argv[2] ?? "local";
const countArg = process.argv[3] && !process.argv[3].startsWith("--") ? Number(process.argv[3]) : undefined;
const n = countArg ?? (which === "local" ? 10 : 6);
const MAINNET_FLAG = "--i-understand-this-sends-real-transactions";

/** The mainnet probe's connection and throwaway payer, or an exit with a usage line before any network call. */
function mainnetProbe(): { conn: Connection; payer: Keypair } {
  const rpc = process.env.SOLANA_MAINNET_RPC ?? "";
  const keyFile = process.env.MAINNET_PROBE_KEYPAIR ?? "";
  if (!process.argv.includes(MAINNET_FLAG) || !/^https:\/\/[^\s]+$/.test(rpc) || keyFile === "") {
    console.error(`mainnet sends real transactions (about 5,000 lamports each) from a throwaway key. Set SOLANA_MAINNET_RPC (an https URL) and MAINNET_PROBE_KEYPAIR (a key file funded with 0.001 SOL) and add ${MAINNET_FLAG}`);
    process.exit(2);
  }
  console.log(`mainnet probe through ${new URL(rpc).host}`);
  return { conn: new Connection(rpc, "confirmed"), payer: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")) as number[])) };
}

let conn: Connection;
let payer: Keypair;
if (which === "mainnet") {
  ({ conn, payer } = mainnetProbe());
  const lamports = await conn.getBalance(payer.publicKey);
  console.log(`probe key ${payer.publicKey.toBase58()} holds ${lamports} lamports`);
  if (lamports < 100_000) {
    console.error(`fund ${payer.publicKey.toBase58()} with 0.001 SOL, then run this again`);
    process.exit(2);
  }
} else if (which === "local") {
  conn = new Connection("http://127.0.0.1:8899", "confirmed");
  payer = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100_000_000), "confirmed");
} else {
  conn = new Connection("https://api.devnet.solana.com", "confirmed");
  payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config", "solana", "id.json"), "utf8")) as number[]));
}
const MARGIN = 1;
const rows: { sentAt: number; blockTime: number; slot: number; lagS: number; engineSecond: number; chainSecond: number; ahead: boolean }[] = [];
for (let i = 0; i < n; i++) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
  tx.sign(payer);
  const sentAt = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  let got: { blockTime?: number | null; slot: number } | null = null;
  for (let t = 0; t < 10 && !got?.blockTime; t++) {
    got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!got?.blockTime) await Bun.sleep(500);
  }
  if (!got?.blockTime) {
    console.log(`- probe ${i}: no block time for ${sig}`);
    continue;
  }
  const engineSecond = Math.floor(sentAt / 1000) - MARGIN;
  const chainSecond = got.blockTime;
  rows.push({ sentAt, blockTime: got.blockTime, slot: got.slot, lagS: Number((sentAt / 1000 - got.blockTime).toFixed(2)), engineSecond, chainSecond, ahead: engineSecond > chainSecond });
  console.log(`- probe ${i}: sent ${new Date(sentAt).toISOString()} landed slot ${got.slot} block time ${new Date(got.blockTime * 1000).toISOString()} lag ${(sentAt / 1000 - got.blockTime).toFixed(2)} s; engine second ${engineSecond} vs chain second ${chainSecond}: ${engineSecond > chainSecond ? "ENGINE AHEAD (a step shown as passed that the chain still charges)" : "engine at or behind (safe)"}`);
  await Bun.sleep(which === "local" ? 700 : 1_500);
}
const lags = rows.map((r) => r.lagS).sort((a, b) => a - b);
console.log(JSON.stringify({ chain: which, probes: rows.length, lagMin: lags[0], lagMedian: lags[Math.floor(lags.length / 2)], lagMax: lags.at(-1), engineAhead: rows.filter((r) => r.ahead).length, marginSeconds: MARGIN, verdict: rows.some((r) => r.ahead) ? "the one-second margin is too small on this chain" : "the one-second margin held on every probe" }));
