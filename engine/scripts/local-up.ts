#!/usr/bin/env bun
// Idempotent local environment: ONE solana-test-validator running the MAINNET
// Meteora DBC and DAMM v2 binaries, the MAINNET Squads v4 program with its
// ProgramConfig account, the DAMM v2 migration config Hv8Lmzm...
// (1% pool fee) and the real Solana-ZEC mint cloned in,
// plus the pad's Zcash regtest chain (probe/zcash-batch, F-035). Safe to run
// twice: if either is already up, this leaves it alone. Reads mainnet only
// (program dumps + account reads); sends no mainnet transaction.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as sqds from "@sqds/multisig";
import { config } from "../src/config";
import { loadKeeperKeypair } from "../src/keeper";
import { getConnection } from "../src/solana";
import { REVIEWED_TIERS } from "../src/dbc/reviewed";
import { ensureRegtestReady } from "../src/zcash/regtest";

const { dbc } = config.solana;
const LOCALNET_DIR = join(config.paths.probeDbcDir, ".localnet");

/** `--clone` flags for every DAMM v2 config a fee tier graduates into (the 1% one and the 2%, 4% and 6% ones), cloned once from mainnet. */
function dammConfigClones(): string[] {
  const keys = new Set<string>([dbc.dammConfig.toBase58(), ...Object.values(REVIEWED_TIERS).map((t) => t.dammMigrationConfig)]);
  return [...keys].flatMap((k) => ["--clone", k]);
}

function sh(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`command failed (${proc.exitCode}): ${cmd.join(" ")}`);
}

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return true;
  } catch {
    return false;
  }
}

function ensureProgramBinary(programId: PublicKey, name: string): string {
  const cached = join(LOCALNET_DIR, `${name}.so`);
  if (existsSync(cached)) return cached;
  mkdirSync(LOCALNET_DIR, { recursive: true });
  sh(["solana", "program", "dump", "-u", "m", programId.toBase58(), cached]);
  return cached;
}

// Patches only the base64 "data" payload, at the string level: this account
// JSON's rentEpoch is u64::MAX (18446744073709551615), which JSON.parse turns
// into an imprecise float, so a JSON.parse -> JSON.stringify round trip
// corrupts it. String-splicing leaves every other field's raw text untouched.
function rewriteZecMintAuthority(keeperPubkey: PublicKey): string {
  const outPath = join(config.paths.dataDir, "zec-local.json");
  const cachedMainnetSnapshot = join(LOCALNET_DIR, "zec-mainnet.json");
  const rawText = existsSync(cachedMainnetSnapshot)
    ? readFileSync(cachedMainnetSnapshot, "utf8")
    : (() => {
        const tmp = join(config.paths.dataDir, "zec-mainnet-fetch.json");
        sh(["solana", "account", "-u", "m", dbc.quoteMint.toBase58(), "--output", "json-compact", "--output-file", tmp]);
        return readFileSync(tmp, "utf8");
      })();

  const match = /"data":\s*\[\s*"([^"]+)"/.exec(rawText);
  if (!match) throw new Error(`could not find "data" field in ${cachedMainnetSnapshot}`);
  const data = Buffer.from(match[1]!, "base64");
  data.writeUInt32LE(1, 0); // COption<Pubkey> discriminant: Some
  keeperPubkey.toBuffer().copy(data, 4); // mint_authority bytes
  const patched =
    rawText.slice(0, match.index) + `"data":["${data.toString("base64")}"` + rawText.slice(match.index + match[0].length);
  writeFileSync(outPath, patched);
  return outPath;
}

/** DBC flash-rents lamports from its pool-authority PDA during migration (flash_rent.rs:12); on mainnet it holds ~68 SOL, on a fresh local chain it holds none. */
async function fundPoolAuthority(): Promise<void> {
  const conn = getConnection();
  const poolAuthority = deriveDbcPoolAuthority();
  if ((await conn.getBalance(poolAuthority)) >= 1e9) return;
  const keeper = loadKeeperKeypair();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: poolAuthority, lamports: 1e9 }));
  await sendAndConfirmTransaction(conn, tx, [keeper], { commitment: "confirmed" });
  console.log("funded the DBC pool-authority PDA with 1 SOL (local only)");
}

async function main(): Promise<void> {
  if (await validatorUp()) {
    console.log("solana-test-validator already up, skipping");
  } else {
    const keeper = loadKeeperKeypair();
    const dbcSo = ensureProgramBinary(dbc.programId, "dbc");
    const dammSo = ensureProgramBinary(dbc.dammProgramId, "damm");
    const squadsSo = ensureProgramBinary(sqds.PROGRAM_ID, "squads");
    const zecLocalAccount = rewriteZecMintAuthority(keeper.publicKey);
    mkdirSync(config.paths.validatorLedger, { recursive: true });
    const log = Bun.file(config.paths.validatorLog);
    const proc = Bun.spawn(
      [
        "solana-test-validator", "--reset", "--quiet", "--ledger", config.paths.validatorLedger,
        "--url", "m", ...dammConfigClones(), "--clone", sqds.getProgramConfigPda({})[0].toBase58(),
        "--account", dbc.quoteMint.toBase58(), zecLocalAccount,
        "--bpf-program", dbc.programId.toBase58(), dbcSo,
        "--bpf-program", dbc.dammProgramId.toBase58(), dammSo,
        "--bpf-program", sqds.PROGRAM_ID.toBase58(), squadsSo,
      ],
      { stdout: log, stderr: log, stdin: "ignore" },
    );
    proc.unref();
    writeFileSync(config.paths.validatorPid, String(proc.pid));
    for (let i = 0; i < 60 && !(await validatorUp()); i++) await Bun.sleep(1000);
    if (!(await validatorUp())) throw new Error("solana-test-validator did not come up within 60s");
    await getConnection().confirmTransaction(await getConnection().requestAirdrop(keeper.publicKey, 100e9), "confirmed");
    console.log("solana-test-validator up, keeper airdropped 100 SOL");
    // A fresh chain has none of the pools the old DB points at: start the DB over with it.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(config.paths.dbFile + suffix, { force: true });
    rmSync(join(config.paths.dataDir, "seed-wallets.json"), { force: true });
    console.log("fresh chain: reset", config.paths.dbFile);
  }
  await fundPoolAuthority();

  const { treasuryUA, fundingUA } = await ensureRegtestReady();
  console.log("zcash regtest up. treasury:", treasuryUA.slice(0, 12) + "…", "funding:", fundingUA.slice(0, 12) + "…");
}

main().catch((err) => {
  console.error("local:up failed:", err);
  process.exit(1);
});
