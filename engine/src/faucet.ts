// Test-money faucet: SOL (cluster airdrop) plus test ZEC minted by a MINTER key.
// Exposed over HTTP on devnet only (POST /faucet, docs/API.md v2.0: the
// devnet quote is a stand-in mint whose mint authority is the dedicated faucet
// key, so anyone clicking the judge site can trade. The faucet key is NOT the
// keeper: it holds only test funds, so the public API never touches the keeper
// key (INV-17). Scripts and tests fund wallets locally with `fundTestWallet`
// and the keeper as minter (the local ZEC mint's authority is rewritten to the
// keeper by scripts/local-up.ts). Mainnet has no faucet and no such mint.
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { getConnection } from "./solana";
import * as db from "./db";

export const FAUCET_ZEC_ZATS = 500_000_000n; // 5 test ZEC
export const FAUCET_COOLDOWN_MS = 10 * 60_000;
// Audit S2-10: the per-wallet cooldown alone lets anyone with fresh keys drain
// the faucet; at most this many fills per cooldown window across all wallets.
export const FAUCET_MAX_PER_WINDOW = 30;
// Local mode only: below this the minter (the keeper) is topped up from the validator's airdrop first. Devnet has no airdrop to
// lean on: there the faucet key must keep PAD_FAUCET_MIN_RESERVE_SOL (src/config.ts) after every fill.
const MIN_MINTER_LAMPORTS = 50_000_000;
const lamportsOf = (sol: number): number => Math.round(sol * 1e9);
// What a devnet fill costs the faucet key on top of the SOL it hands over: the recipient's ZEC token-account rent (the local
// validator's 2,039,280; devnet's is 1,488,440, so the count below errs low) and the fee of its three transactions (transfer,
// create the account, mint). A recipient that already holds the account costs less.
export const FILL_OVERHEAD_LAMPORTS = 2_039_280 + 3 * 5_000;
// Below this many fills left the keeper raises an alert (src/scheduler.ts) so the key is refilled before a judge meets a dry faucet.
export const FAUCET_LOW_FILLS = 10;

export interface FaucetStatus {
  available: boolean;
  fillsLeft: number;
}
/** A status plus what it was read from: the faucet key's address and balance (the keeper's alert names them). */
export interface FaucetReading extends FaucetStatus {
  address: string;
  lamports: number;
}

export class FaucetError extends Error {
  constructor(public code: "faucet_cooldown" | "faucet_unavailable" | "bad_wallet") {
    super(code);
  }
}

const faucetKeyPath = (): string => join(config.paths.keysDir, `faucet-${config.mode}.json`);

/** The faucet's own key (keys/faucet-<mode>.json, generated on first use in local/devnet only). */
export function loadFaucetKeypair(): Keypair {
  if (config.mode === "mainnet") throw new FaucetError("faucet_unavailable");
  const path = faucetKeyPath();
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/**
 * How many fills the faucet key can still pay from `balanceLamports`. A fill goes ahead only while the key holds the fill plus the
 * reserve (the gate in fundTestWallet), and each one then costs the fill plus FILL_OVERHEAD_LAMPORTS; 0 below the gate.
 */
export function fillsLeftFor(balanceLamports: number, fillSol = config.faucet.devnetSol, reserveSol = config.faucet.minReserveSol): number {
  const fill = lamportsOf(fillSol);
  const gate = fill + lamportsOf(reserveSol);
  if (balanceLamports < gate) return 0;
  return Math.floor((balanceLamports - gate) / (fill + FILL_OVERHEAD_LAMPORTS)) + 1;
}

/**
 * The faucet key's balance and what it still buys, read from the cluster. null where there is no faucet (anything but devnet).
 * Throws if the key file is missing (this never makes one) or the balance cannot be read.
 */
export async function readFaucet(): Promise<FaucetReading | null> {
  if (config.mode !== "devnet") return null;
  if (!existsSync(faucetKeyPath())) throw new Error("the faucet key file does not exist");
  const address = loadFaucetKeypair().publicKey;
  const lamports = await getConnection().getBalance(address);
  const fillsLeft = fillsLeftFor(lamports);
  return { available: fillsLeft >= 1, fillsLeft, address: address.toBase58(), lamports };
}

// GET /treasury is public and carries the faucet's status, so the balance read behind it is cached and made one at a time (like
// the treasury balance in ledger.ts): whatever the traffic, the shared RPC quota sees one read per window. The faucet itself never
// uses this number; fundTestWallet reads the balance fresh before every fill.
const STATUS_MAX_AGE_MS = 30_000;
let statusCache: { atMs: number; status: FaucetStatus | null } | null = null;
let statusRead: Promise<FaucetStatus | null> | null = null;

/** null on a network without a faucet. A balance that cannot be read is reported as unavailable, never as an error. */
export async function faucetStatusForView(): Promise<FaucetStatus | null> {
  if (config.mode !== "devnet") return null;
  const age = statusCache ? Date.now() - statusCache.atMs : -1; // a clock that stepped back makes the age negative: stale, not fresh
  if (statusCache && age >= 0 && age < STATUS_MAX_AGE_MS) return statusCache.status;
  statusRead ??= readFaucet()
    .then((r): FaucetStatus | null => (r ? { available: r.available, fillsLeft: r.fillsLeft } : null))
    .catch((err: Error): FaucetStatus => {
      console.error(`faucet balance unreadable, reporting it unavailable: ${err.message}`);
      return { available: false, fillsLeft: 0 };
    })
    .then((status) => {
      statusCache = { atMs: Date.now(), status };
      return status;
    })
    .finally(() => {
      statusRead = null;
    });
  return statusRead;
}

/** Airdrops SOL and mints test ZEC to `owner`. Throws faucet_unavailable if `minter` is not the quote mint's authority. */
export async function fundTestWallet(owner: PublicKey, sol: number, minter: Keypair): Promise<{ sol: number; zecZats: string }> {
  const conn = getConnection();
  const { quoteMint } = config.solana.dbc;
  const mint = await getMint(conn, quoteMint, "confirmed", TOKEN_PROGRAM_ID);
  if (!mint.mintAuthority?.equals(minter.publicKey)) throw new FaucetError("faucet_unavailable");
  if (config.mode === "devnet") {
    // The cluster's airdrop faucet is rate-limited per IP and often dry, so the faucet key pays PAD_FAUCET_SOL per fill from its own
    // balance instead. A refill is a manual devnet airdrop to the faucet key (faucet.solana.com).
    sol = config.faucet.devnetSol;
    if (fillsLeftFor(await conn.getBalance(minter.publicKey)) < 1) throw new FaucetError("faucet_unavailable"); // the faucet key is dry
    const pay = new Transaction().add(SystemProgram.transfer({ fromPubkey: minter.publicKey, toPubkey: owner, lamports: lamportsOf(sol) }));
    await sendAndConfirmTransaction(conn, pay, [minter], { commitment: "confirmed" });
  } else {
    if ((await conn.getBalance(minter.publicKey)) < MIN_MINTER_LAMPORTS) {
      await conn.confirmTransaction(await conn.requestAirdrop(minter.publicKey, 1e9), "confirmed");
    }
    await conn.confirmTransaction(await conn.requestAirdrop(owner, sol * 1e9), "confirmed");
  }
  const ata = (await getOrCreateAssociatedTokenAccount(conn, minter, quoteMint, owner, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(conn, minter, quoteMint, ata, minter, FAUCET_ZEC_ZATS);
  return { sol, zecZats: FAUCET_ZEC_ZATS.toString() };
}

/** The HTTP faucet: one fill per wallet per cooldown window, minted by the faucet key. */
export async function faucetFund(wallet: string): Promise<{ sol: number; zecZats: string }> {
  // A recipient that can never hold the test ZEC (an off-curve address such as a PDA) or receive SOL (a program) used to
  // get its SOL first and then fail, and the failure undid the cooldown row: anyone could drain the faucet by
  // repeating the request (found on the live server 2026-10-03). Refused before anything is sent.
  const owner = new PublicKey(wallet);
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new FaucetError("bad_wallet");
  const last = db.lastFaucetClaimAt(wallet);
  if (last && Date.now() - Date.parse(last) < FAUCET_COOLDOWN_MS) throw new FaucetError("faucet_cooldown");
  if (db.countFaucetClaimsSince(new Date(Date.now() - FAUCET_COOLDOWN_MS).toISOString()) >= FAUCET_MAX_PER_WINDOW) throw new FaucetError("faucet_cooldown");
  // Recorded BEFORE the first await (audit S2-10): two concurrent requests for
  // one wallet can no longer both pass the cooldown check. Undone if funding fails.
  db.recordFaucetClaim(wallet);
  try {
    const info = await getConnection().getAccountInfo(owner, "confirmed");
    if (info && (info.executable || !info.owner.equals(SystemProgram.programId))) throw new FaucetError("bad_wallet");
    return await fundTestWallet(owner, 1, loadFaucetKeypair());
  } catch (e) {
    db.deleteFaucetClaim(wallet);
    throw e;
  }
}
