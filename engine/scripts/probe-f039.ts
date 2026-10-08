#!/usr/bin/env bun
// F-039 probe: can a DBC pool's creator be a wallet other than the payer, and who must sign. DEVNET only.
//   PAD_MODE=devnet bun scripts/probe-f039.ts [--from probe/fee-scheduler/results/f038-devnet-<ts>.json]
// Reuses the F-038 probe config and quote mint (the newest f038 results file by default). Four experiments:
//   N1  payer signs, poolCreator = a random key that never signs           -> expect: refused before the chain sees it
//   N2  the same with the creator account marked "not a signer"           -> expect: the PROGRAM refuses (creator is Signer)
//   P1  poolCreator = a fresh key that co-signs and holds 0 SOL             -> expect: pool.creator = that key, payer paid everything
//   P2  payer launches as creator and hands the pool to a random key in the SAME transaction (transfer_pool_creator)
//                                                                           -> expect: pool.creator = the random key, which never signed
// Then the creator-fee claim path: who the program lets claim (claim_creator_trading_fee needs pool.creator to sign).
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { U64_MAX, deriveDammV1MigrationMetadataAddress, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RESULTS_DIR = join(config.paths.repoRoot, "probe", "fee-scheduler", "results");
const FIRST_BUY = 20_000_000n; // 0.2 quote units
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const results: Record<string, unknown> = { probe: "F-039", cluster: "devnet", startedAt: new Date().toISOString() };

function loadPayer(): Keypair {
  const path = process.env.PROBE_PAYER_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function f038Results(): { config: PublicKey; quoteMint: PublicKey; file: string } {
  const i = process.argv.indexOf("--from");
  const file = i >= 0 ? process.argv[i + 1]! : join(RESULTS_DIR, readdirSync(RESULTS_DIR).filter((f) => f.startsWith("f038-devnet-")).sort().at(-1)!);
  const r = JSON.parse(readFileSync(file, "utf8")) as { config: { id: string }; quoteMint: string };
  return { config: new PublicKey(r.config.id), quoteMint: new PublicKey(r.quoteMint), file };
}

async function requireDevnet(conn: Connection): Promise<void> {
  if (config.mode !== "devnet") throw new Error("devnet only: PAD_MODE=devnet");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`refusing: genesis ${genesis} is not devnet`);
}

/** What the SDK's bundled IDL says about who signs (Anchor 0.30 IDLs name instructions in camelCase). */
function idlSignerFlags(): Record<string, unknown> {
  const idl = getDbcClient().creator.program.idl as unknown as { instructions: { name: string; accounts: { name: string; signer?: boolean; writable?: boolean }[] }[] };
  const flags = (ixName: string) => {
    const ix = idl.instructions.find((i) => i.name === ixName);
    return ix ? Object.fromEntries(ix.accounts.filter((a) => ["creator", "payer", "newCreator", "new_creator"].includes(a.name)).map((a) => [a.name, { signer: a.signer ?? false, writable: a.writable ?? false }])) : "not in IDL";
  };
  const out = {
    initializeVirtualPoolWithToken2022: flags("initializeVirtualPoolWithToken2022"),
    initializeVirtualPoolWithSplToken: flags("initializeVirtualPoolWithSplToken"),
    transferPoolCreator: flags("transferPoolCreator"),
    claimCreatorTradingFee: flags("claimCreatorTradingFee"),
  };
  log("IDL signer flags:", out);
  return out;
}

/** --only idl,negative,p1,p2 runs a subset (the first two cost nothing on chain); default: everything. */
function stepsWanted(): Set<string> {
  const i = process.argv.indexOf("--only");
  return new Set(i >= 0 ? process.argv[i + 1]!.split(",") : ["idl", "negative", "p1", "p2"]);
}

async function prepare(conn: Connection, tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = feePayer;
  return tx;
}

async function sendSigned(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log(`${label}: ${sig}`);
  return sig;
}

/** The first lines of an error, plus web3.js's transactionMessage and the program's own line when a send was refused. */
function errorText(err: unknown): string {
  const e = err as Error & { transactionMessage?: string; transactionLogs?: string[]; logs?: string[] };
  const logs = e.transactionLogs ?? e.logs ?? [];
  const programLine = logs.find((l) => /Error|failed|signature/i.test(l));
  return [e.transactionMessage ?? String(e?.message ?? err).split("\n").slice(0, 2).join(" "), programLine].filter(Boolean).join(" | ").slice(0, 400);
}

async function simulate(conn: Connection, tx: Transaction): Promise<{ ok: boolean; err: string | null; log: string | null }> {
  const sim = await conn.simulateTransaction(tx);
  return { ok: !sim.value.err, err: sim.value.err ? JSON.stringify(sim.value.err) : null, log: (sim.value.logs ?? []).find((l) => /Error Code|Error Number|failed|Error/.test(l)) ?? null };
}

const createPoolParam = (payer: PublicKey, poolCreator: PublicKey, cfg: PublicKey, baseMint: PublicKey, symbol: string) => ({ name: `Creator Probe ${symbol}`, symbol, uri: "none", payer, poolCreator, config: cfg, baseMint });

/** N1 and N2: a pool creator that never signs. */
async function negativeCases(conn: Connection, payer: Keypair, cfg: PublicKey): Promise<Record<string, unknown>> {
  const client = getDbcClient();
  const stranger = Keypair.generate().publicKey; // a public key only; nobody holds its secret here
  const baseKp = Keypair.generate();
  const tx = await prepare(conn, await client.creator.createPool(createPoolParam(payer.publicKey, stranger, cfg, baseKp.publicKey, "N1")), payer.publicKey);
  const initIx = tx.instructions.find((ix) => ix.keys.some((k) => k.pubkey.equals(stranger)))!;
  const metas = Object.fromEntries(initIx.keys.filter((k) => k.pubkey.equals(stranger) || k.pubkey.equals(payer.publicKey)).map((k) => [k.pubkey.equals(stranger) ? "creator (stranger)" : "payer", { isSigner: k.isSigner, isWritable: k.isWritable }]));
  log("N1 instruction account metas:", metas);
  tx.sign(payer, baseKp);
  let serializeError: string | null = null;
  try {
    tx.serialize();
  } catch (err) {
    serializeError = errorText(err);
  }
  let rpcError: string | null = null;
  try {
    await conn.sendRawTransaction(tx.serialize({ requireAllSignatures: false, verifySignatures: false }), { skipPreflight: false });
  } catch (err) {
    rpcError = errorText(err);
  }
  log("N1 web3.js serialize():", serializeError, "| RPC send without the creator's signature:", rpcError);

  // N2: tell the runtime the creator does not sign (so signature verification passes) and let the PROGRAM judge
  const baseKp2 = Keypair.generate();
  const tx2 = await prepare(conn, await client.creator.createPool(createPoolParam(payer.publicKey, stranger, cfg, baseKp2.publicKey, "N2")), payer.publicKey);
  for (const ix of tx2.instructions) for (const k of ix.keys) if (k.pubkey.equals(stranger)) k.isSigner = false;
  tx2.sign(payer, baseKp2);
  const sim = await simulate(conn, tx2);
  log("N2 creator marked non-signer, program simulation:", sim);
  return { stranger: stranger.toBase58(), n1: { metas, serializeError, rpcError }, n2: sim };
}

/** P1: a co-signing creator with no SOL. */
async function coSigningCreator(conn: Connection, payer: Keypair, cfg: PublicKey, quoteMint: PublicKey): Promise<Record<string, unknown>> {
  const client = getDbcClient();
  const creator = Keypair.generate();
  const baseKp = Keypair.generate();
  const payerBefore = await conn.getBalance(payer.publicKey, "confirmed");
  const tx = await client.creator.createPoolWithFirstBuy({
    createPoolParam: createPoolParam(payer.publicKey, creator.publicKey, cfg, baseKp.publicKey, "P1"),
    firstBuyParam: { buyer: payer.publicKey, buyAmount: new BN(FIRST_BUY.toString()), minimumAmountOut: new BN(0), referralTokenAccount: null },
  });
  const sig = await sendSigned(conn, tx, [payer, baseKp, creator], "P1 launch: payer pays, a 0-SOL key co-signs as creator");
  const pool = deriveDbcPoolAddress(quoteMint, baseKp.publicKey, cfg);
  const state = (await client.state.getPool(pool))!.poolState;
  const out = {
    sig, pool: pool.toBase58(), baseMint: baseKp.publicKey.toBase58(), creatorKey: creator.publicKey.toBase58(), poolCreatorOnChain: state.creator.toBase58(), creatorIsTheCoSigner: state.creator.equals(creator.publicKey),
    creatorLamports: await conn.getBalance(creator.publicKey, "confirmed"), payerLamportsPaid: payerBefore - (await conn.getBalance(payer.publicKey, "confirmed")),
    claimByPayer: await simulateClaim(conn, pool, payer, payer),
    claimByCreator: await simulateClaim(conn, pool, creator, payer),
  };
  log("P1:", out);
  return out;
}

/** The creator-fee claim, simulated for `claimer` (the payer pays): what the program answers. */
async function simulateClaim(conn: Connection, pool: PublicKey, claimer: Keypair, payer: Keypair): Promise<Record<string, unknown>> {
  const tx = await getDbcClient().creator.claimCreatorTradingFee({ creator: claimer.publicKey, payer: payer.publicKey, pool, maxBaseAmount: new BN(U64_MAX.toString()), maxQuoteAmount: new BN(U64_MAX.toString()) });
  await prepare(conn, tx, payer.publicKey);
  tx.sign(...(claimer.publicKey.equals(payer.publicKey) ? [payer] : [payer, claimer]));
  return { claimer: claimer.publicKey.toBase58(), ...(await simulate(conn, tx)) };
}

/** P2: launch and hand over in one transaction; the new creator never signs. */
async function handoverInLaunchTx(conn: Connection, payer: Keypair, cfg: PublicKey, quoteMint: PublicKey): Promise<Record<string, unknown>> {
  const client = getDbcClient();
  const receiver = Keypair.generate().publicKey; // the "Creator wallet" field: a public key, never a signer
  const baseKp = Keypair.generate();
  const pool = deriveDbcPoolAddress(quoteMint, baseKp.publicKey, cfg);
  const launch = await client.creator.createPoolWithFirstBuy({
    createPoolParam: createPoolParam(payer.publicKey, payer.publicKey, cfg, baseKp.publicKey, "P2"),
    firstBuyParam: { buyer: payer.publicKey, buyAmount: new BN(FIRST_BUY.toString()), minimumAmountOut: new BN(0), referralTokenAccount: null },
  });
  const transfer = await client.creator.program.methods.transferPoolCreator()
    .accountsPartial({ virtualPool: pool, newCreator: receiver, config: cfg, creator: payer.publicKey })
    .remainingAccounts([{ pubkey: deriveDammV1MigrationMetadataAddress(pool), isSigner: false, isWritable: false }])
    .instruction();
  launch.add(transfer);
  const sig = await sendSigned(conn, launch, [payer, baseKp], "P2 launch + transfer_pool_creator in ONE transaction");
  const state = (await client.state.getPool(pool))!.poolState;
  // the same handover with new_creator = the old creator must be refused (InvalidNewCreator)
  const same = await client.creator.program.methods.transferPoolCreator().accountsPartial({ virtualPool: pool, newCreator: payer.publicKey, config: cfg, creator: payer.publicKey })
    .remainingAccounts([{ pubkey: deriveDammV1MigrationMetadataAddress(pool), isSigner: false, isWritable: false }]).transaction();
  await prepare(conn, same, payer.publicKey);
  same.sign(payer);
  const out = {
    sig, pool: pool.toBase58(), baseMint: baseKp.publicKey.toBase58(), receiver: receiver.toBase58(), poolCreatorOnChain: state.creator.toBase58(), creatorIsTheReceiver: state.creator.equals(receiver),
    receiverLamports: await conn.getBalance(receiver, "confirmed"), instructionsInTx: launch.instructions.length,
    claimByLauncher: await simulateClaim(conn, pool, payer, payer),
    transferBackToSelfByOldCreator: await simulate(conn, same),
  };
  log("P2:", out);
  return out;
}

async function main(): Promise<void> {
  const conn = getConnection();
  await requireDevnet(conn);
  const payer = loadPayer();
  const from = f038Results();
  log("payer", payer.publicKey.toBase58(), "config", from.config.toBase58(), "quote mint", from.quoteMint.toBase58(), "from", from.file);
  const balance0 = await conn.getBalance(payer.publicKey, "confirmed");
  const steps = stepsWanted();
  results.steps = [...steps];
  results.payer = payer.publicKey.toBase58();
  results.config = from.config.toBase58();
  results.quoteMint = from.quoteMint.toBase58();
  if (steps.has("idl")) results.idl = idlSignerFlags();
  if (steps.has("negative")) results.negative = await negativeCases(conn, payer, from.config);
  if (steps.has("p1")) results.p1 = await coSigningCreator(conn, payer, from.config, from.quoteMint);
  if (steps.has("p2")) results.p2 = await handoverInLaunchTx(conn, payer, from.config, from.quoteMint);
  results.lamportsSpent = balance0 - (await conn.getBalance(payer.publicKey, "confirmed"));
  results.finishedAt = new Date().toISOString();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `f039-devnet-${[...steps].join("-")}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log("spent", Number(results.lamportsSpent) / 1e9, "SOL; results", file);
}

await main();
