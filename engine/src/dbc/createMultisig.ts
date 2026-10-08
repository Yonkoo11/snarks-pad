// Creates the pad's Squads v4 multisig exactly as audit/CONFIG-REVIEW.md section 5 reviewed it: members
// owner + backup (all permissions) and the keeper (Initiate+Vote+Execute), threshold 2, no time lock,
// autonomous (no config authority), rent collector = the keeper. Its vault 0 becomes the fee owner of the
// permanent DBC config (dbc/createConfig.ts).
//
// Dry run by default: it reads the chain and prints what it would send. A real send needs the flag, refuses
// if a multisig was already created here, and reads the account back and checks it before it records anything.
// The keeper pays and signs; the owner and backup only contribute their PUBLIC addresses, and the multisig's
// address comes from a fresh random key that is used once and never stored (it has no power afterwards).
// Keeper-side only: it loads the keeper key (never import it from the HTTP API).
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { config } from "../config";
import * as db from "../db";
import { loadKeeperKeypair } from "../keeper";
import { getConnection } from "../solana";
import { clearPendingCreate, resolvePendingCreate, signRecordAndSend } from "./pendingCreate";
import { REVIEWED_MULTISIG } from "./reviewed";
import { KEEPER_PERMISSIONS, multisigReviewedProblems, vaultOf } from "./squads";

export const MULTISIG_CREATE_FLAG = "--i-understand-this-creates-a-permanent-multisig";
export const MULTISIG_PENDING_META = "squads_multisig_pending";
export const MULTISIG_CREATED_META = "squads_multisig_created";
/** Rent for the multisig account plus fees, with margin. The Squads creation fee (read from its ProgramConfig) is added. */
const MIN_KEEPER_LAMPORTS = 10_000_000n;

export interface MultisigCreateOptions {
  owner: PublicKey;
  backup: PublicKey;
  execute: boolean;
}

export interface MultisigCreateResult {
  executed: boolean;
  problems: string[];
  lines: string[];
  multisig?: string;
  vault?: string;
}

interface Plan {
  keeper: PublicKey;
  problems: string[];
  creationFee: bigint;
  keeperLamports: bigint;
}

function peopleProblems(owner: PublicKey, backup: PublicKey, keeper: PublicKey): string[] {
  const problems: string[] = [];
  const named: [string, PublicKey][] = [["owner", owner], ["backup", backup], ["keeper", keeper]];
  const seen = new Map<string, string>();
  for (const [role, key] of named) {
    const prior = seen.get(key.toBase58());
    if (prior) problems.push(`the ${role} and the ${prior} are the same address ${key.toBase58()}: three different keys are required`);
    seen.set(key.toBase58(), role);
    if (!PublicKey.isOnCurve(key.toBytes())) problems.push(`the ${role} address ${key.toBase58()} is not a normal wallet key (off the ed25519 curve): it could never sign`);
  }
  return problems;
}

async function makePlan(opts: MultisigCreateOptions): Promise<Plan> {
  const conn = getConnection();
  const keeper = loadKeeperKeypair().publicKey;
  const problems = peopleProblems(opts.owner, opts.backup, keeper);
  if (config.solana.dbc.squadsMultisig) problems.push(`SQUADS_MULTISIG is already set (${config.solana.dbc.squadsMultisig.toBase58()}): a multisig exists; creating another would give the pad two vaults`);
  const created = db.getMeta(MULTISIG_CREATED_META);
  if (created) problems.push(`a multisig was already created here: ${created}`);
  const programConfig = await sqds.accounts.ProgramConfig.fromAccountAddress(conn, sqds.getProgramConfigPda({})[0]);
  const creationFee = BigInt(programConfig.multisigCreationFee.toString());
  const keeperLamports = BigInt(await conn.getBalance(keeper, "confirmed"));
  if (keeperLamports < MIN_KEEPER_LAMPORTS + creationFee) {
    problems.push(`the keeper ${keeper.toBase58()} holds ${keeperLamports} lamports; it needs at least ${MIN_KEEPER_LAMPORTS + creationFee} to pay the multisig's rent and fees`);
  }
  return { keeper, problems, creationFee, keeperLamports };
}

const roleLine = (role: string, key: PublicKey, perms: string): string => `  ${role.padEnd(7)} ${key.toBase58()}  ${perms}`;

function describePlan(opts: MultisigCreateOptions, plan: Plan): string[] {
  return [
    `Squads multisig to create on ${config.mode} (the keeper pays and signs; nothing here needs the owner's or the backup's key):`,
    roleLine("owner", opts.owner, "Initiate + Vote + Execute"),
    roleLine("backup", opts.backup, "Initiate + Vote + Execute"),
    roleLine("keeper", plan.keeper, "Initiate + Vote + Execute"),
    `  threshold ${REVIEWED_MULTISIG.threshold}, time lock ${REVIEWED_MULTISIG.timeLock}, config authority none (autonomous), rent collector = the keeper ${plan.keeper.toBase58()}`,
    `  the multisig address comes from a fresh random key at send time; its vault ${REVIEWED_MULTISIG.vaultIndex} becomes the config's fee claimer`,
    `  Squads creation fee ${plan.creationFee} lamports; keeper balance ${plan.keeperLamports} lamports`,
    "Check the three addresses above against the ones on your paper before sending.",
  ];
}

async function sendMultisig(opts: MultisigCreateOptions, plan: Plan): Promise<{ multisig: PublicKey; sig: string }> {
  const keeper = loadKeeperKeypair();
  const createKey = Keypair.generate();
  const [multisigPda] = sqds.getMultisigPda({ createKey: createKey.publicKey });
  const { treasury } = await sqds.accounts.ProgramConfig.fromAccountAddress(getConnection(), sqds.getProgramConfigPda({})[0]);
  const ix = sqds.instructions.multisigCreateV2({
    treasury, creator: keeper.publicKey, multisigPda, configAuthority: null,
    threshold: REVIEWED_MULTISIG.threshold, timeLock: REVIEWED_MULTISIG.timeLock, createKey: createKey.publicKey,
    rentCollector: keeper.publicKey,
    members: [
      { key: opts.owner, permissions: sqds.types.Permissions.all() },
      { key: opts.backup, permissions: sqds.types.Permissions.all() },
      { key: plan.keeper, permissions: KEEPER_PERMISSIONS },
    ],
  });
  const sig = await signRecordAndSend(MULTISIG_PENDING_META, multisigPda.toBase58(), new Transaction().add(ix), keeper, [createKey]);
  return { multisig: multisigPda, sig };
}

/** Reads the multisig back and refuses anything but the reviewed shape and these exact people; records it only then. */
async function verifyAndRecord(opts: MultisigCreateOptions, multisig: PublicKey, sig: string | null): Promise<string[]> {
  const keeper = loadKeeperKeypair().publicKey;
  const ms = await sqds.accounts.Multisig.fromAccountAddress(getConnection(), multisig, "confirmed");
  const problems = multisigReviewedProblems(ms, keeper, { owner: opts.owner, backup: opts.backup });
  if (problems.length > 0) throw new Error(`the created multisig ${multisig.toBase58()} does NOT match the review: ${problems.join("; ")}. Do not use it.`);
  const vault = vaultOf(multisig);
  db.setMeta(MULTISIG_CREATED_META, JSON.stringify({ multisig: multisig.toBase58(), vault: vault.toBase58(), sig, at: new Date().toISOString() }));
  clearPendingCreate(MULTISIG_PENDING_META);
  return [
    `multisig: ${multisig.toBase58()}`,
    `vault: ${vault.toBase58()}`,
    "Read back: 3 members with the reviewed permissions, threshold 2, no time lock, no config authority, rent collector = the keeper.",
    "Write the multisig and vault addresses on paper. Next: set SQUADS_MULTISIG to the multisig and run `bun run config:create -- --multisig <multisig>`.",
  ];
}

export async function runMultisigCreate(opts: MultisigCreateOptions): Promise<MultisigCreateResult> {
  const earlier = await resolvePendingCreate(MULTISIG_PENDING_META);
  if (earlier.state === "in_flight") {
    return { executed: false, problems: [`an earlier multisig creation (${earlier.pending.subject}) may still land; wait about two minutes and run this again`], lines: [] };
  }
  if (earlier.state === "landed") {
    if (!opts.execute) return { executed: false, problems: [`an earlier multisig creation landed (${earlier.pending.subject}); run with ${MULTISIG_CREATE_FLAG} to verify and record it`], lines: [] };
    const lines = await verifyAndRecord(opts, new PublicKey(earlier.pending.subject), earlier.pending.sig);
    return { executed: true, problems: [], lines, multisig: earlier.pending.subject, vault: vaultOf(new PublicKey(earlier.pending.subject)).toBase58() };
  }
  const plan = await makePlan(opts);
  const lines = describePlan(opts, plan);
  if (plan.problems.length > 0 || !opts.execute) return { executed: false, problems: plan.problems, lines };
  const { multisig, sig } = await sendMultisig(opts, plan);
  const done = await verifyAndRecord(opts, multisig, sig);
  return { executed: true, problems: [], lines: [...lines, ...done], multisig: multisig.toBase58(), vault: vaultOf(multisig).toBase58() };
}
