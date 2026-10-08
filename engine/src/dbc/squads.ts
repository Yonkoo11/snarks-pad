// Custody Option B (plan 4, F-037): the DBC config's `fee_claimer` (and the
// DAMM v2 partner position's owner) is a Squads v4 VAULT. The keeper can never
// claim by itself: it proposes a vault transaction, a second member (the
// owner's phone) approves it, then the keeper executes it. This file is the
// FeeClaimer for that setup.
//
// Per claim, three stages, each resumable from claim_progress:
//   propose  keeper tx: vaultTransactionCreate (the claim instruction, wrapped)
//            + proposalCreate. Signed, persisted, then broadcast.
//   await    nothing in flight. The keeper votes (it holds Vote), then waits
//            for the owner. Each run re-reads the proposal.
//   execute  keeper tx: vaultTransactionExecute, only after the proposal is
//            Approved AND the stored message is exactly what the keeper wrote.
//            Signed, persisted, then broadcast; its signature is what the
//            claim amount is measured from.
// The receiver of the ZEC is inside the approved message (F-037 4b: swapping it
// at execute fails with InvalidAccount), so approval binds it. `describeProposal`
// decodes the STORED message (not the keeper's intention) so the owner sees the
// real receiver before approving.
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import * as sqds from "@sqds/multisig";
import { createHash } from "node:crypto";
import { config } from "../config";
import { getConnection, isSignatureLanded, broadcastAndConfirm } from "../solana";
import { readAccountsInfo } from "../multiAccounts";
import { loadKeeperKeypair } from "../keeper";
import { SQUADS_MEMBERS_META } from "../holders";
import * as db from "../db";
import { REVIEWED_MULTISIG } from "./reviewed";
import { isExpiredAndUnlanded, signAndPersist, type Advance, type ClaimBuilder, type ClaimId, type FeeClaimer } from "./claim";

const { Permission, Permissions } = sqds.types;

/** The search for a proposal's executing transaction reads its signature history in pages of this size, at most this many per call. */
export const EXECUTION_SEARCH_PAGE = 100;
export const EXECUTION_SEARCH_MAX_SIGNATURES = 1_000;

/** Initiate + Vote + Execute: what the keeper needs so that a claim is keeper + one more approval (F-037 4d). */
export const KEEPER_PERMISSIONS = Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]);
const KEEPER_MASK = KEEPER_PERMISSIONS.mask;

export const vaultOf = (multisigPda: PublicKey, index = 0): PublicKey => sqds.getVaultPda({ multisigPda, index })[0];

// ---- decoding what a stored proposal would really do ----

export interface ResolvedIx {
  programId: PublicKey;
  accounts: PublicKey[];
  data: Buffer;
}

const anchorDisc = (name: string): string => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");

/**
 * The claim instructions this pad ever wraps, with the positions of the token
 * accounts that RECEIVE money (from each program's account struct: DBC
 * ix_claim_partner_trading_fee.rs / ix_withdraw_partner_surplus.rs, DAMM
 * ix_claim_position_fee.rs). test/squads.test.ts decodes real SDK-built
 * instructions to prove these positions.
 */
const CLAIM_SHAPES: { name: string; program: () => PublicKey; disc: string; receivers: number[] }[] = [
  { name: "dbc claim_trading_fee", program: () => config.solana.dbc.programId, disc: anchorDisc("claim_trading_fee"), receivers: [3, 4] },
  { name: "dbc partner_withdraw_surplus", program: () => config.solana.dbc.programId, disc: anchorDisc("partner_withdraw_surplus"), receivers: [3] },
  { name: "damm claim_position_fee", program: () => config.solana.dbc.dammProgramId, disc: anchorDisc("claim_position_fee"), receivers: [3, 4] },
];

export interface DecodedReceiver {
  instruction: string; // e.g. "dbc claim_trading_fee"
  tokenAccount: string;
  owner: string | null; // null if the token account does not exist yet
  mint: string | null;
}

/** For every instruction, the money-receiving token accounts it names. An instruction that is not a known claim is reported as `unknown` (and must not be approved or executed). */
export function decodeClaimReceivers(ixs: ResolvedIx[]): { receivers: { instruction: string; tokenAccount: string }[]; unknown: string[] } {
  const receivers: { instruction: string; tokenAccount: string }[] = [];
  const unknown: string[] = [];
  for (const ix of ixs) {
    const shape = CLAIM_SHAPES.find((s) => s.program().equals(ix.programId) && ix.data.subarray(0, 8).toString("hex") === s.disc);
    if (!shape) {
      unknown.push(`${ix.programId.toBase58()} (${ix.data.subarray(0, 8).toString("hex")})`);
      continue;
    }
    for (const i of shape.receivers) receivers.push({ instruction: shape.name, tokenAccount: ix.accounts[i]!.toBase58() });
  }
  return { receivers, unknown };
}

/** Looks up who owns each receiving token account (an account that does not exist yet has no owner to show). */
export async function resolveReceivers(conn: Connection, receivers: { instruction: string; tokenAccount: string }[]): Promise<DecodedReceiver[]> {
  if (receivers.length === 0) return [];
  const keys = receivers.map((r) => new PublicKey(r.tokenAccount));
  const infos = await readAccountsInfo(keys, (k) => conn.getMultipleAccountsInfo(k, "confirmed"));
  return receivers.map((r, i) => {
    const info = infos[i];
    if (!info) return { ...r, owner: null, mint: null };
    const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const acct = unpackAccount(keys[i]!, info, program);
    return { ...r, owner: acct.owner.toBase58(), mint: acct.mint.toBase58() };
  });
}

/** Canonical form of a wrapped message: per instruction, program + resolved accounts + data. Flags and ordering of the compiled message do not matter here. */
export function fingerprint(ixs: ResolvedIx[]): string {
  const canon = ixs.map((ix) => ({ p: ix.programId.toBase58(), a: ix.accounts.map((k) => k.toBase58()), d: ix.data.toString("hex") }));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export const resolveInstructions = (ixs: TransactionInstruction[]): ResolvedIx[] =>
  ixs.map((ix) => ({ programId: ix.programId, accounts: ix.keys.map((k) => k.pubkey), data: Buffer.from(ix.data) }));

/** The instructions of a stored vault transaction, with account indexes resolved to addresses. */
export function resolveStoredMessage(msg: sqds.generated.VaultTransactionMessage): ResolvedIx[] {
  return msg.instructions.map((ix) => ({
    programId: msg.accountKeys[ix.programIdIndex]!,
    accounts: Array.from(ix.accountIndexes).map((i) => msg.accountKeys[i]!),
    data: Buffer.from(ix.data),
  }));
}

export interface ProposalDescription {
  index: bigint;
  status: string;
  approvals: string[];
  threshold: number;
  receivers: DecodedReceiver[];
  unknownInstructions: string[];
  fingerprint: string;
  text: string;
}

/** Reads a proposal's STORED vault transaction and says in plain words who gets paid. This is what the owner must read before approving. */
export async function describeProposal(conn: Connection, multisigPda: PublicKey, index: bigint): Promise<ProposalDescription> {
  const ms = await sqds.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const [txPda] = sqds.getTransactionPda({ multisigPda, index });
  const [proposalPda] = sqds.getProposalPda({ multisigPda, transactionIndex: index });
  const vaultTx = await sqds.accounts.VaultTransaction.fromAccountAddress(conn, txPda);
  const proposal = await sqds.accounts.Proposal.fromAccountAddress(conn, proposalPda);
  const ixs = resolveStoredMessage(vaultTx.message);
  const { receivers: raw, unknown } = decodeClaimReceivers(ixs);
  const receivers = await resolveReceivers(conn, raw);
  const status = proposal.status.__kind;
  const approvals = proposal.approved.map((k) => k.toBase58());
  const lines = [
    `Squads proposal #${index} (${status}), approvals ${approvals.length} of ${ms.threshold}`,
    ...receivers.map((r) => `  ${r.instruction}: pays token account ${r.tokenAccount} (owner ${r.owner ?? "account does not exist"}, mint ${r.mint ?? "-"})`),
    ...unknown.map((u) => `  WARNING: unknown instruction ${u}: do not approve`),
  ];
  return { index, status, approvals, threshold: ms.threshold, receivers, unknownInstructions: unknown, fingerprint: fingerprint(ixs), text: lines.join("\n") };
}

/** Proposals still waiting for approval (Active) with their decoded receivers: the owner's work list. */
export async function listActiveProposals(conn: Connection, multisigPda: PublicKey): Promise<ProposalDescription[]> {
  const ms = await sqds.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const out: ProposalDescription[] = [];
  const last = BigInt(ms.transactionIndex.toString());
  const stale = BigInt(ms.staleTransactionIndex.toString());
  for (let i = last; i > stale && i > last - 20n; i--) {
    const d = await describeProposal(conn, multisigPda, i).catch(() => describeConfigProposal(conn, multisigPda, i, ms.threshold));
    if (d?.status === "Active") out.push(d);
  }
  return out.reverse();
}

/**
 * A CONFIG proposal (members, threshold, time lock, spending limit, rent collector). With threshold 2 and a
 * keeper that holds Vote, keeper + owner can pass one, so it must be shown, never hidden (audit/CONFIG-REVIEW.md
 * S1-M2). It is reported with an `unknownInstructions` entry so nothing in this pad treats it as a claim.
 * Returns null when the index holds neither kind of transaction.
 */
export async function describeConfigProposal(conn: Connection, multisigPda: PublicKey, index: bigint, threshold: number): Promise<ProposalDescription | null> {
  const [txPda] = sqds.getTransactionPda({ multisigPda, index });
  const [proposalPda] = sqds.getProposalPda({ multisigPda, transactionIndex: index });
  const cfg = await sqds.accounts.ConfigTransaction.fromAccountAddress(conn, txPda).catch(() => null);
  const proposal = await sqds.accounts.Proposal.fromAccountAddress(conn, proposalPda).catch(() => null);
  if (!cfg || !proposal) return null;
  const actions = cfg.actions.map((a) => JSON.stringify(a, (_k, v) => (v instanceof PublicKey ? v.toBase58() : typeof v === "bigint" || (v && v.constructor?.name === "BN") ? v.toString() : v)));
  const approvals = proposal.approved.map((k) => k.toBase58());
  const status = proposal.status.__kind;
  const text = [
    `Squads proposal #${index} (${status}), approvals ${approvals.length} of ${threshold}`,
    `  CONFIG CHANGE, not a fee claim. Created by ${cfg.creator.toBase58()}.`,
    ...actions.map((a) => `  action: ${a}`),
    "  Do NOT approve unless you started this change yourself.",
  ].join("\n");
  return { index, status, approvals, threshold, receivers: [], unknownInstructions: actions.map((a) => `config change ${a}`), fingerprint: "", text };
}

/** The owner's action: approve one proposal with `member`. Prints nothing and decides nothing: read `describeProposal` first. */
export async function approveProposal(conn: Connection, multisigPda: PublicKey, index: bigint, member: Keypair): Promise<string> {
  const tx = new Transaction().add(sqds.instructions.proposalApprove({ multisigPda, transactionIndex: index, member: member.publicKey }));
  return sendAndConfirmTransaction(conn, tx, [member], { commitment: "confirmed" });
}

/** The parts of a multisig's setup this pad relies on (audit/CONFIG-REVIEW.md, Squads section); empty = acceptable. */
export function multisigShapeProblems(
  ms: Pick<sqds.accounts.Multisig, "members" | "threshold" | "configAuthority" | "rentCollector">,
  keeper: PublicKey,
): string[] {
  const problems: string[] = [];
  const me = ms.members.find((m) => m.key.equals(keeper));
  if (!me || (me.permissions.mask & KEEPER_MASK) !== KEEPER_MASK) problems.push(`the keeper ${keeper.toBase58()} is not a member with Initiate+Vote+Execute`);
  if (ms.threshold < 2) problems.push("the threshold is below 2: the keeper alone could claim");
  // A "controlled" multisig: that one key could change members and threshold with no vote (SQ state/multisig.rs:14-24).
  if (!ms.configAuthority.equals(PublicKey.default)) problems.push(`config authority is ${ms.configAuthority.toBase58()}; it must be none (autonomous)`);
  // Proposal rent is refunded to the rent collector; anyone else means the keeper pays it for every claim (PORT-ASSUMPTIONS Q5).
  // After a keeper rotation, change the rent collector to the new keeper too.
  if (!ms.rentCollector || !ms.rentCollector.equals(keeper)) problems.push(`rent collector is ${ms.rentCollector?.toBase58() ?? "none"}; it must be the keeper ${keeper.toBase58()}`);
  return problems;
}

/**
 * What a multisig must be before it may become the PERMANENT fee owner of a config (creation tools only):
 * the claim-time shape above plus the exact reviewed membership (CONFIG-REVIEW section 5): three members
 * who can all vote, threshold 2, no time lock. `people` (known when this pad creates the multisig) also
 * pins who the members are; every member must be able to sign (an off-curve key never can).
 */
export function multisigReviewedProblems(
  ms: Pick<sqds.accounts.Multisig, "members" | "threshold" | "configAuthority" | "rentCollector" | "timeLock">,
  keeper: PublicKey,
  people?: { owner: PublicKey; backup: PublicKey },
): string[] {
  const problems = multisigShapeProblems(ms, keeper);
  if (ms.members.length !== REVIEWED_MULTISIG.memberCount) problems.push(`the multisig has ${ms.members.length} members; the review requires ${REVIEWED_MULTISIG.memberCount} (owner, backup, keeper)`);
  if (ms.threshold !== REVIEWED_MULTISIG.threshold) problems.push(`the threshold is ${ms.threshold}; the review requires ${REVIEWED_MULTISIG.threshold}`);
  if (ms.timeLock !== REVIEWED_MULTISIG.timeLock) problems.push(`the time lock is ${ms.timeLock}; the review requires ${REVIEWED_MULTISIG.timeLock}`);
  for (const m of ms.members) {
    if (m.permissions.mask !== Permissions.all().mask) problems.push(`member ${m.key.toBase58()} has permission mask ${m.permissions.mask}; every member needs Initiate+Vote+Execute (7)`);
    if (!PublicKey.isOnCurve(m.key.toBytes())) problems.push(`member ${m.key.toBase58()} is not a normal wallet key (off the ed25519 curve): it could never sign`);
  }
  if (people) {
    const keys = new Set(ms.members.map((m) => m.key.toBase58()));
    for (const [role, key] of [["owner", people.owner], ["backup", people.backup], ["keeper", keeper]] as const) {
      if (!keys.has(key.toBase58())) problems.push(`the ${role} ${key.toBase58()} is not a member`);
    }
  }
  return problems;
}

// ---- the claimer ----

interface SquadsRef {
  txIndex: string;
  fingerprint: string;
}

export interface SquadsClaimerOptions {
  multisigPda: PublicKey;
  keeper: Keypair;
  vaultIndex?: number;
  /**
   * Test network only (config.devnetCoSignerKeypair): the multisig's second member, whose approval the keeper adds itself after decoding the STORED
   * message exactly as the owner's tool does, so a devnet round needs no person. null on mainnet: the owner approves from their phone.
   */
  coSigner?: Keypair | null;
}

export class SquadsVaultFeeClaimer implements FeeClaimer {
  readonly publicKey: PublicKey;
  private constructor(private opts: Required<SquadsClaimerOptions>, private conn: Connection) {
    this.publicKey = vaultOf(opts.multisigPda, opts.vaultIndex);
  }

  /** Reads the multisig, checks the keeper is a member with Initiate+Vote+Execute, and records the member list for the holder exclusion. */
  static async create(opts: SquadsClaimerOptions): Promise<SquadsVaultFeeClaimer> {
    const conn = getConnection();
    const ms = await sqds.accounts.Multisig.fromAccountAddress(conn, opts.multisigPda);
    const problems = multisigShapeProblems(ms, opts.keeper.publicKey);
    if (problems.length > 0) throw new Error(`Squads multisig ${opts.multisigPda.toBase58()} is not set up as reviewed:\n  ${problems.join("\n  ")}`);
    if (opts.coSigner) {
      const co = ms.members.find((m) => m.key.equals(opts.coSigner!.publicKey));
      if (!co || (co.permissions.mask & Permission.Vote) !== Permission.Vote) throw new Error(`the co-signer ${opts.coSigner.publicKey.toBase58()} is not a member of ${opts.multisigPda.toBase58()} with Vote`);
      if (opts.coSigner.publicKey.equals(opts.keeper.publicKey)) throw new Error("the co-signer is the keeper itself: a claim would need no second member");
    }
    db.setMeta(SQUADS_MEMBERS_META, JSON.stringify(ms.members.map((m) => m.key.toBase58())));
    return new SquadsVaultFeeClaimer({ vaultIndex: 0, coSigner: null, ...opts }, conn);
  }

  /** Tests only: a claimer on a stand-in connection, with none of create()'s on-chain checks. */
  static withConnection(opts: SquadsClaimerOptions, conn: Connection): SquadsVaultFeeClaimer {
    return new SquadsVaultFeeClaimer({ vaultIndex: 0, coSigner: null, ...opts }, conn);
  }

  /** `isSignatureLanded` on THIS claimer's connection (the same node that answered the account reads it is compared with). */
  private async landedHere(sig: string): Promise<boolean> {
    const { value } = await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    return !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
  }

  /**
   * The proposal account, or "absent" when the node says there is no account there. Any other failure (a timeout, a
   * rate limit, a network error) is thrown: it says nothing about the proposal, and a claim row must never be forgotten
   * on it (audit S6-A2: that forgot a live proposal and proposed a second one; an approval of the first then landed ZEC
   * with no row to attribute it to).
   */
  private async readProposal(proposalPda: PublicKey): Promise<sqds.accounts.Proposal | "absent"> {
    try {
      return await sqds.accounts.Proposal.fromAccountAddress(this.conn, proposalPda);
    } catch (err) {
      if (/Unable to find .* account/.test(String((err as Error)?.message ?? err))) return "absent";
      throw err;
    }
  }

  private get multisigPda() {
    return this.opts.multisigPda;
  }

  private async sendKeeper(ixs: TransactionInstruction[]): Promise<string> {
    return sendAndConfirmTransaction(this.conn, new Transaction().add(...ixs), [this.opts.keeper], { commitment: "confirmed" });
  }

  async advance(id: ClaimId, build: ClaimBuilder): Promise<Advance> {
    for (;;) {
      const row = db.getClaimProgress(id.epochId, id.mint, id.kind);
      if (!row) {
        await this.propose(id, build);
        continue;
      }
      if (row.phase === "propose") {
        if (!(await this.settleInFlight(id, row))) return { pending: "the proposal transaction did not land yet; the next run resumes it" };
        db.setClaimPhase(id.epochId, id.mint, id.kind, "await");
        continue;
      }
      if (row.phase === "execute") {
        if (await this.settleInFlight(id, row)) return { sig: row.sig };
        db.setClaimPhase(id.epochId, id.mint, id.kind, "await"); // the executing tx expired unlanded: look at the proposal again
        continue;
      }
      const next = await this.awaitApproval(id, row, build);
      if (next) return next;
    }
  }

  /**
   * A signed transaction in flight (propose or execute): true once it landed;
   * false while it may still land; if it can never land (blockhash expired),
   * a propose is forgotten (nothing happened on chain) and an execute falls back to `await`.
   */
  private async settleInFlight(id: ClaimId, row: db.ClaimProgressRow): Promise<boolean> {
    if (await isSignatureLanded(row.sig)) return true;
    try {
      await broadcastAndConfirm(new Uint8Array(Buffer.from(row.rawTx, "base64")), row.sig);
      return true;
    } catch (err) {
      if (!(await isExpiredAndUnlanded(row.sig, row.lastValidBlockHeight))) throw err;
      if (row.phase === "propose") db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
      return false;
    }
  }

  private async propose(id: ClaimId, build: ClaimBuilder): Promise<void> {
    const { keeper, vaultIndex } = this.opts;
    const parts = await build();
    if (parts.setupIxs.length > 0) await this.sendKeeper(parts.setupIxs); // the receiver's token accounts: idempotent, keeper-paid
    const ms = await sqds.accounts.Multisig.fromAccountAddress(this.conn, this.multisigPda);
    const index = BigInt(ms.transactionIndex.toString()) + 1n;
    const message = new TransactionMessage({
      payerKey: this.publicKey,
      recentBlockhash: (await this.conn.getLatestBlockhash("confirmed")).blockhash,
      instructions: parts.claimIxs,
    });
    const resolved = resolveInstructions(parts.claimIxs);
    const { receivers: raw } = decodeClaimReceivers(resolved);
    const decoded = await resolveReceivers(this.conn, raw);
    const memo = `snarks pad claim ${id.kind}: pays ${decoded.map((r) => `${r.tokenAccount} (owner ${r.owner})`).join(", ")}`.slice(0, 250);
    const tx = new Transaction().add(
      sqds.instructions.vaultTransactionCreate({
        multisigPda: this.multisigPda, transactionIndex: index, creator: keeper.publicKey, vaultIndex,
        ephemeralSigners: 0, transactionMessage: message, memo,
      }),
      sqds.instructions.proposalCreate({ multisigPda: this.multisigPda, transactionIndex: index, creator: keeper.publicKey }),
    );
    const ref: SquadsRef = { txIndex: index.toString(), fingerprint: fingerprint(resolved) };
    const { sig, raw: bytes } = await signAndPersist(id, tx, [], "propose", JSON.stringify(ref), "insert"); // durable, BEFORE broadcasting
    await broadcastAndConfirm(bytes, sig); // if this throws, the next advance() resumes the same signed bytes (or forgets them once they can never land)
  }

  private async awaitApproval(id: ClaimId, row: db.ClaimProgressRow, build: ClaimBuilder): Promise<Advance | null> {
    const ref = JSON.parse(row.ref ?? "{}") as SquadsRef;
    const index = BigInt(ref.txIndex);
    const { keeper } = this.opts;
    const ms = await sqds.accounts.Multisig.fromAccountAddress(this.conn, this.multisigPda);
    const [proposalPda] = sqds.getProposalPda({ multisigPda: this.multisigPda, transactionIndex: index });
    const forget = async (why: string): Promise<Advance> => {
      db.clearUnlandedClaim(id.epochId, id.mint, id.kind); // no ZEC moved: a fresh proposal is made on the next run
      if (why === "was rejected" || why === "was cancelled") await this.closeFinished(index).catch(() => {}); // recover its rent
      return { pending: `proposal #${index} ${why}; a new one is made on the next run` };
    };
    if (index <= BigInt(ms.staleTransactionIndex.toString())) return forget("went stale after a member change");

    const read = await this.readProposal(proposalPda);
    if (read === "absent") {
      // No account there. Three cases, told apart by what else this same node knows (audit S6-A2):
      //   executed by another member and then closed for its rent: its executing transaction is in the proposal's history, measure it;
      //   rejected or cancelled and then closed: the propose transaction landed and nothing executed, so a fresh one is made;
      //   a node that is behind (it has neither the account nor the propose transaction that created it): wait, never forget.
      const executed = await this.findExecutionSig(proposalPda);
      if (executed.sig) return { sig: executed.sig };
      if (!executed.complete) return { pending: `proposal #${index} has no account and a history longer than ${EXECUTION_SEARCH_MAX_SIGNATURES} signatures; not forgotten, the next run looks again` };
      if (await this.landedHere(row.sig)) return forget("does not exist (closed after a rejection or a cancel)");
      return { pending: `proposal #${index} is not visible on this RPC node yet (neither the account nor its creating transaction); the next run looks again` };
    }
    let proposal = read;
    let kind = proposal.status.__kind;
    if (kind === "Rejected" || kind === "Cancelled") return forget(`was ${kind.toLowerCase()}`);
    if (kind === "Executed") {
      const executed = await this.findExecutionSig(proposalPda);
      if (executed.sig) return { sig: executed.sig };
      if (!executed.complete) return { pending: `proposal #${index} is Executed but its history is longer than ${EXECUTION_SEARCH_MAX_SIGNATURES} signatures; the next run looks again` };
      throw new Error(`proposal ${proposalPda.toBase58()} is Executed but no transaction executing it is in its history`);
    }
    if (kind === "Executing") return { pending: `proposal #${index} is executing` };

    if (kind === "Active" && !proposal.approved.some((k) => k.equals(keeper.publicKey))) {
      await this.sendKeeper([sqds.instructions.proposalApprove({ multisigPda: this.multisigPda, transactionIndex: index, member: keeper.publicKey })]);
      proposal = await sqds.accounts.Proposal.fromAccountAddress(this.conn, proposalPda);
      kind = proposal.status.__kind;
    }
    const co = this.opts.coSigner;
    if (kind === "Active" && co && !proposal.approved.some((k) => k.equals(co.publicKey))) {
      // the test network's stand-in owner: approve only what the owner's tool would approve, read from the STORED message
      const d = await describeProposal(this.conn, this.multisigPda, index);
      const paysKeeper = d.receivers.length > 0 && d.receivers.every((r) => r.owner === keeper.publicKey.toBase58());
      if (d.unknownInstructions.length > 0 || !paysKeeper) return { pending: `not co-signed: the stored message is not a claim paying the keeper.\n${d.text}` };
      await approveProposal(this.conn, this.multisigPda, index, co);
      proposal = await sqds.accounts.Proposal.fromAccountAddress(this.conn, proposalPda);
      kind = proposal.status.__kind;
    }
    if (kind !== "Approved") {
      const d = await describeProposal(this.conn, this.multisigPda, index);
      return { pending: `awaiting owner approval.\n${d.text}` };
    }
    return this.execute(id, ref, index, build);
  }

  private async execute(id: ClaimId, ref: SquadsRef, index: bigint, build: ClaimBuilder): Promise<Advance | null> {
    // The owner approved a message. Execute only if it is exactly what the keeper wrote and still what it would write now.
    const stored = await describeProposal(this.conn, this.multisigPda, index);
    const now = fingerprint(resolveInstructions((await build()).claimIxs));
    if (stored.fingerprint !== ref.fingerprint || stored.fingerprint !== now || stored.unknownInstructions.length > 0) {
      throw new Error(`proposal #${index} was approved but its message is not the one this keeper proposed (stored ${stored.fingerprint.slice(0, 12)}, proposed ${ref.fingerprint.slice(0, 12)}, current ${now.slice(0, 12)}); refusing to execute`);
    }
    const { instruction } = await sqds.instructions.vaultTransactionExecute({
      connection: this.conn, multisigPda: this.multisigPda, transactionIndex: index, member: this.opts.keeper.publicKey,
    });
    const { sig, raw } = await signAndPersist(id, new Transaction().add(instruction), [], "execute", null, "replace"); // durable, BEFORE broadcasting
    await broadcastAndConfirm(raw, sig);
    return { sig };
  }

  /**
   * A finished proposal (Executed, Rejected, Cancelled) still holds about
   * 0.0062 SOL of rent in its vault-transaction and proposal accounts. Anyone
   * can close them; the lamports go to the multisig's rent collector (set it to
   * the keeper when the multisig is created, or the keeper pays that rent for
   * every claim for good: F-037 "Cost per claim").
   */
  private async closeFinished(index: bigint): Promise<void> {
    const ms = await sqds.accounts.Multisig.fromAccountAddress(this.conn, this.multisigPda);
    await this.sendKeeper([sqds.instructions.vaultTransactionAccountsClose({ multisigPda: this.multisigPda, rentCollector: ms.rentCollector!, transactionIndex: index })]);
  }

  async settle(id: ClaimId): Promise<void> {
    const row = db.getClaimProgress(id.epochId, id.mint, id.kind);
    if (row?.ref) await this.closeFinished(BigInt((JSON.parse(row.ref) as SquadsRef).txIndex));
  }

  /**
   * The transaction that executed this proposal (the one carrying a VaultTransactionExecute of THIS multisig and THIS
   * proposal), so its ZEC is measured whoever sent it: the keeper's own execute that a lagging node once called expired,
   * or another member's. null when none landed. Any transaction that merely names the proposal, or executes some other
   * multisig's transaction while naming it, is not it (audit S6-A3).
   */
  private async findExecutionSig(proposalPda: PublicKey): Promise<{ sig: string | null; complete: boolean }> {
    const executeDisc = createHash("sha256").update("global:vault_transaction_execute").digest().subarray(0, 8);
    // The whole history, newest first, a page at a time (the hostile review of S6-A2: anyone can send transactions that
    // merely name the PDA; one page of 25 let a few of them hide the execute). `complete` says the history was read to its
    // end; a history longer than the cap is never a reason to forget a claim.
    let before: string | undefined;
    let scanned = 0;
    while (scanned < EXECUTION_SEARCH_MAX_SIGNATURES) {
      const sigs = await this.conn.getSignaturesForAddress(proposalPda, { before, limit: EXECUTION_SEARCH_PAGE }, "confirmed");
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await this.conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx) continue;
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
        const all = keys.staticAccountKeys.concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? []);
        const hit = tx.transaction.message.compiledInstructions.some((ix) => {
          if (!all[ix.programIdIndex]?.equals(sqds.PROGRAM_ID) || !Buffer.from(ix.data).subarray(0, 8).equals(executeDisc)) return false;
          const named = ix.accountKeyIndexes.map((i) => all[i]);
          return named.some((k) => k?.equals(this.multisigPda)) && named.some((k) => k?.equals(proposalPda));
        });
        if (hit) return { sig: s.signature, complete: true };
      }
      scanned += sigs.length;
      if (sigs.length < EXECUTION_SEARCH_PAGE) return { sig: null, complete: true };
      before = sigs[sigs.length - 1]!.signature;
    }
    return { sig: null, complete: false };
  }
}

/** Builds the Squads claimer for the configured multisig from the keeper key. Keeper-side only. */
export async function loadSquadsFeeClaimer(): Promise<SquadsVaultFeeClaimer> {
  const multisigPda = config.solana.dbc.squadsMultisig;
  if (!multisigPda) throw new Error("SQUADS_MULTISIG is not set: this config's fee claimer is a Squads vault but no multisig is configured");
  return SquadsVaultFeeClaimer.create({ multisigPda, keeper: loadKeeperKeypair() });
}
