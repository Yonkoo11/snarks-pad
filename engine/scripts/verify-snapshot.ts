#!/usr/bin/env bun
// Verify an epoch snapshot yourself. Needs only this file and bun: no keys, no database, no other repo code.
//
//   bun scripts/verify-snapshot.ts --api http://localhost:8787/api [--epoch <id>] [--rpc <solana rpc>]
//                                  [--wallet <w> --mint <m> --salt <hex> --share <zats>]      (your own shielded row)
//
// It checks, and exits 1 on the first thing that is wrong:
//   1. the snapshot file served by the API hashes to the sha256 the API lists for the epoch;
//   2. that same sha256 is in the Solana memo transaction the keeper signed (when --rpc is given and the epoch lists one);
//   3. the arithmetic: per coin, holders + team == claimed, team == the published share of claimed, every Solana row's
//      share is the pro-rata share of the holders' pool for its weight (+0 or +1 zat of rounding), and the Solana rows
//      plus the shielded total add up to the holders' pool;
//   4. optionally, that your own shielded row (wallet, mint, salt, share, which the pad gives you for a signed request)
//      is one of the commitments in the file.
// Shielded rows are published only as a count, a total and one salted commitment each; nobody can read an amount or an
// address from the file, and this script never asks for one.
import { createHash } from "node:crypto";

interface Row { wallet: string; weight: string | null; shareZats: string }
interface Coin {
  mint: string; claimedZats: string; teamZats: string; holdersZats: string; totalWeight: string | null;
  solana: Row[]; shielded: { count: number; totalShareZats: string; totalWeight: string | null; commitments: string[] };
}
export interface Snapshot {
  version: number; epochId: string; at: string; network: string;
  policy: { meteoraShareOfFeeBps: number; holdersShareOfClaimedBps: number; teamShareOfClaimedBps: number };
  coins: Coin[];
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function commitment(epochId: string, mint: string, salt: string, wallet: string, share: bigint): string {
  return sha256(`snarks-pad-snapshot-v1\n${epochId}\n${mint}\n${salt}\n${wallet}\n${share}`);
}

/** Every arithmetic problem in the snapshot, as sentences; empty means it adds up. */
export function arithmeticProblems(s: Snapshot): string[] {
  const out: string[] = [];
  const { teamShareOfClaimedBps: teamBps, holdersShareOfClaimedBps: holdersBps } = s.policy;
  if (teamBps + holdersBps !== 10_000) out.push(`the policy shares add to ${teamBps + holdersBps}, not 10000`);
  for (const c of s.coins) {
    const claimed = BigInt(c.claimedZats), team = BigInt(c.teamZats), holders = BigInt(c.holdersZats);
    const tag = `coin ${c.mint}`;
    if (holders + team !== claimed) out.push(`${tag}: holders ${holders} + team ${team} is not claimed ${claimed}`);
    if (team !== (claimed * BigInt(teamBps)) / 10_000n) out.push(`${tag}: team ${team} is not ${teamBps} bps of ${claimed}, rounded down`);
    const solanaTotal = c.solana.reduce((a, r) => a + BigInt(r.shareZats), 0n);
    if (solanaTotal + BigInt(c.shielded.totalShareZats) !== holders) out.push(`${tag}: Solana rows ${solanaTotal} + shielded ${c.shielded.totalShareZats} is not the holders' pool ${holders}`);
    if (c.shielded.commitments.length !== c.shielded.count) out.push(`${tag}: ${c.shielded.commitments.length} commitments for a count of ${c.shielded.count}`);
    if (new Set(c.shielded.commitments).size !== c.shielded.commitments.length) out.push(`${tag}: a commitment appears twice`);
    if (c.totalWeight === null) continue; // an older epoch that did not store weights: the sums above are all that can be checked
    const total = BigInt(c.totalWeight);
    const rowWeights = c.solana.reduce((a, r) => a + BigInt(r.weight ?? "0"), 0n);
    if (c.shielded.totalWeight === null || rowWeights + BigInt(c.shielded.totalWeight) !== total) out.push(`${tag}: the weights do not add up to ${total}`);
    for (const r of c.solana) {
      const floor = (holders * BigInt(r.weight ?? "0")) / total;
      const share = BigInt(r.shareZats);
      if (share !== floor && share !== floor + 1n) out.push(`${tag}: ${r.wallet} has share ${share}, but its weight gives ${floor} (or ${floor + 1n} with the rounding zat)`);
    }
  }
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

async function memoOnChain(rpc: string, sig: string): Promise<string | null> {
  const res = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }),
  });
  const body = (await res.json()) as { result?: { meta?: { err: unknown }; transaction: { message: { instructions: { program?: string; parsed?: unknown }[] } } } | null };
  const tx = body.result;
  if (!tx || tx.meta?.err) return null;
  const ix = tx.transaction.message.instructions.find((i) => i.program === "spl-memo");
  return typeof ix?.parsed === "string" ? ix.parsed : null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let failed = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => { failed++; console.log(`  FAIL  ${m}`); };

async function main(): Promise<void> {
  const api = (arg("api") ?? "http://localhost:8787/api").replace(/\/$/, "");
  const epochs = (await getJson<{ epochs: { id: string; snapshot: { sha256: string; memoSig: string | null; url: string } | null }[] }>(`${api}/epochs`)).epochs;
  const want = arg("epoch");
  const epoch = want ? epochs.find((e) => e.id === want) : epochs.find((e) => e.snapshot);
  if (!epoch?.snapshot) { console.log("no epoch with a snapshot to verify"); process.exit(1); }
  console.log(`epoch ${epoch.id}`);

  const text = await (await fetch(api.replace(/\/api$/, "") + epoch.snapshot.url)).text();
  const actual = sha256(text);
  if (actual === epoch.snapshot.sha256) ok(`the file hashes to ${actual}`); else bad(`the file hashes to ${actual}, the API lists ${epoch.snapshot.sha256}`);

  const rpc = arg("rpc");
  if (!epoch.snapshot.memoSig) console.log("  skip  no memo transaction listed for this epoch yet");
  else if (!rpc) console.log(`  skip  memo ${epoch.snapshot.memoSig} not read (pass --rpc <solana rpc> to check it)`);
  else {
    const memo = await memoOnChain(rpc, epoch.snapshot.memoSig);
    const expected = `snarks-pad snapshot ${epoch.id} sha256:${actual}`;
    if (memo === expected) ok(`the Solana memo ${epoch.snapshot.memoSig} says the same hash`); else bad(`the memo on chain is ${JSON.stringify(memo)}, expected ${JSON.stringify(expected)}`);
  }

  const snapshot = JSON.parse(text) as Snapshot;
  if (snapshot.epochId !== epoch.id) bad(`the file is for epoch ${snapshot.epochId}`);
  const problems = arithmeticProblems(snapshot);
  if (problems.length === 0) ok(`the split adds up for ${snapshot.coins.length} coin(s)`); else problems.forEach(bad);

  const [wallet, mint, salt, share] = [arg("wallet"), arg("mint"), arg("salt"), arg("share")];
  if (wallet && mint && salt && share) {
    const c = commitment(epoch.id, mint, salt, wallet, BigInt(share));
    if (snapshot.coins.find((x) => x.mint === mint)?.shielded.commitments.includes(c)) ok("your shielded row is in the file"); else bad("your shielded row is NOT in the file");
  }
  console.log(failed === 0 ? "VERIFIED" : `${failed} problem(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

if (import.meta.main) await main();
