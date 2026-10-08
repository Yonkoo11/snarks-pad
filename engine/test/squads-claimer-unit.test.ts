// Audit S6-A2 / S6-A3: the Squads claimer on a stand-in connection (no chain), the branch that used to forget a claim.
//   A2: before, any failure to read the proposal account (a timeout, a 429, a node that is behind) was taken as "the proposal
//       does not exist": the claim row was deleted and a second proposal was made on the next run, while the first stayed
//       live for the owner to approve and any member to execute, with no row to attribute its ZEC to.
//   A3: findExecutionSig skipped the row's own signature (after an execute-to-await fallback that is the keeper's own
//       execute) and accepted an execute of any multisig that merely named the proposal.
import { describe, expect, test } from "bun:test";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { createHash } from "node:crypto";
import * as db from "../src/db";
import { SquadsVaultFeeClaimer } from "../src/dbc/squads";

const { Permissions } = sqds.types;
const keeper = Keypair.generate();
const owner = Keypair.generate();
const multisigPda = Keypair.generate().publicKey;
const INDEX = 7n;
const [proposalPda] = sqds.getProposalPda({ multisigPda, transactionIndex: INDEX });

function multisigAccount() {
  const [data] = sqds.accounts.Multisig.fromArgs({
    createKey: Keypair.generate().publicKey, configAuthority: PublicKey.default, threshold: 2, timeLock: 0,
    transactionIndex: Number(INDEX), staleTransactionIndex: 0, rentCollector: keeper.publicKey, bump: 255,
    members: [{ key: keeper.publicKey, permissions: Permissions.all() }, { key: owner.publicKey, permissions: Permissions.all() }],
  }).serialize();
  return { data, owner: sqds.PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
}

function proposalAccount(kind: "Active" | "Executed") {
  const [data] = sqds.accounts.Proposal.fromArgs({
    multisig: multisigPda, transactionIndex: Number(INDEX), status: { __kind: kind, timestamp: 1 }, bump: 255,
    approved: [keeper.publicKey, owner.publicKey], rejected: [], cancelled: [],
  }).serialize();
  return { data, owner: sqds.PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
}

const executeDisc = createHash("sha256").update("global:vault_transaction_execute").digest().subarray(0, 8);

/** A transaction carrying a VaultTransactionExecute that names `multisig` and `proposal`, as web3.js's getTransaction returns it. */
function executeTx(multisig: PublicKey, proposal: PublicKey) {
  const ix = new TransactionInstruction({
    programId: sqds.PROGRAM_ID,
    keys: [multisig, proposal, Keypair.generate().publicKey, keeper.publicKey].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    data: Buffer.concat([executeDisc, Buffer.alloc(8)]),
  });
  const message = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
  return { transaction: { message }, meta: { loadedAddresses: undefined } };
}

interface Stub {
  proposal: "throw" | "absent" | "Active" | "Executed";
  landed: Set<string>;
  history: { signature: string; tx: ReturnType<typeof executeTx> }[];
}

function connection(s: Stub): Connection {
  const stub = {
    async getAccountInfo(address: PublicKey) {
      if (address.equals(multisigPda)) return multisigAccount();
      if (address.equals(proposalPda)) {
        if (s.proposal === "throw") throw new Error("fetch failed: 429 Too Many Requests");
        if (s.proposal === "absent") return null;
        return proposalAccount(s.proposal);
      }
      return null;
    },
    async getSignatureStatuses(sigs: string[]) {
      return { value: sigs.map((sig) => (s.landed.has(sig) ? { err: null, confirmationStatus: "confirmed" } : null)) };
    },
    async getSignaturesForAddress(_addr: PublicKey, opts: { before?: string; limit?: number }) {
      const start = opts.before ? s.history.findIndex((h) => h.signature === opts.before) + 1 : 0;
      return s.history.slice(start, start + (opts.limit ?? 100)).map((h) => ({ signature: h.signature, err: null }));
    },
    async getTransaction(sig: string) {
      return s.history.find((h) => h.signature === sig)?.tx ?? null;
    },
  };
  return stub as unknown as Connection;
}

function awaitingClaim(): { id: { epochId: string; mint: string; kind: "trading" }; proposeSig: string } {
  const id = { epochId: `epoch-sq-${crypto.randomUUID()}`, mint: Keypair.generate().publicKey.toBase58(), kind: "trading" as const };
  const proposeSig = "propose-" + crypto.randomUUID();
  db.recordClaimSigned({ ...id, sig: proposeSig, rawTx: "AA==", lastValidBlockHeight: 10, phase: "propose", ref: JSON.stringify({ txIndex: INDEX.toString(), fingerprint: "fp" }) });
  db.setClaimPhase(id.epochId, id.mint, id.kind, "await");
  return { id, proposeSig };
}

const neverBuild = async () => { throw new Error("the claim must not be rebuilt here"); };

describe("audit S6-A2: a proposal read that fails is not a proposal that does not exist", () => {
  test("a 429 while reading the proposal: the claim row stays in its await phase and the step reports pending", async () => {
    const { id, proposeSig } = awaitingClaim();
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({ proposal: "throw", landed: new Set([proposeSig]), history: [] }));
    await expect(claimer.advance(id, neverBuild)).rejects.toThrow("429");
    expect(db.getClaimProgress(id.epochId, id.mint, id.kind)).toMatchObject({ status: "signed", phase: "await", sig: proposeSig });
    db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
  });

  test("the account is absent and the node has not seen the propose transaction either (it is behind): pending, never forgotten", async () => {
    const { id, proposeSig } = awaitingClaim();
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({ proposal: "absent", landed: new Set(), history: [] }));
    const step = await claimer.advance(id, neverBuild);
    expect("pending" in step && step.pending).toContain("not visible on this RPC node yet");
    expect(db.getClaimProgress(id.epochId, id.mint, id.kind)?.sig).toBe(proposeSig);
    db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
  });

  test("the account is gone but its execution is in its history (executed by the owner, then closed for rent): measured, not forgotten", async () => {
    const { id, proposeSig } = awaitingClaim();
    const executeSig = "execute-" + crypto.randomUUID();
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({
      proposal: "absent", landed: new Set([proposeSig, executeSig]), history: [{ signature: executeSig, tx: executeTx(multisigPda, proposalPda) }],
    }));
    expect(await claimer.advance(id, neverBuild)).toEqual({ sig: executeSig });
    db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
  });

  test("the account is gone, the propose transaction landed and nothing executed (rejected, then closed): forgotten, a fresh proposal next run", async () => {
    const { id, proposeSig } = awaitingClaim();
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({ proposal: "absent", landed: new Set([proposeSig]), history: [] }));
    const step = await claimer.advance(id, neverBuild);
    expect("pending" in step && step.pending).toContain("does not exist (closed after a rejection or a cancel)");
    expect(db.getClaimProgress(id.epochId, id.mint, id.kind)).toBeNull();
  });
});

describe("audit S6-A3: the executing transaction is the one that executes THIS proposal of THIS multisig", () => {
  test("an Executed proposal: the keeper's own execute is found even though it is the row's signature (after an execute-to-await fallback)", async () => {
    const { id } = awaitingClaim();
    const ownExecute = "execute-" + crypto.randomUUID();
    db.replaceClaimTx({ ...id, sig: ownExecute, rawTx: "AA==", lastValidBlockHeight: 10, phase: "await" }); // the row's sig is the keeper's execute a lagging node called expired
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({
      proposal: "Executed", landed: new Set([ownExecute]), history: [{ signature: ownExecute, tx: executeTx(multisigPda, proposalPda) }],
    }));
    expect(await claimer.advance(id, neverBuild)).toEqual({ sig: ownExecute });
    db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
  });

  test("the execute is found behind 130 later transactions that merely name the proposal (two pages)", async () => {
    const { id } = awaitingClaim();
    const real = "execute-" + crypto.randomUUID();
    const noise = Array.from({ length: 130 }, (_, i) => ({ signature: `memo-${i}`, tx: executeTx(Keypair.generate().publicKey, Keypair.generate().publicKey) }));
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({
      proposal: "Executed", landed: new Set([real]), history: [...noise, { signature: real, tx: executeTx(multisigPda, proposalPda) }],
    }));
    expect(await claimer.advance(id, neverBuild)).toEqual({ sig: real });
    db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
  });

  test("an execute of another multisig that names this proposal is not it", async () => {
    const { id } = awaitingClaim();
    const decoy = "decoy-" + crypto.randomUUID();
    const real = "execute-" + crypto.randomUUID();
    const claimer = SquadsVaultFeeClaimer.withConnection({ multisigPda, keeper }, connection({
      proposal: "Executed", landed: new Set([decoy, real]),
      history: [{ signature: decoy, tx: executeTx(Keypair.generate().publicKey, proposalPda) }, { signature: real, tx: executeTx(multisigPda, proposalPda) }],
    }));
    expect(await claimer.advance(id, neverBuild)).toEqual({ sig: real });
    db.clearUnlandedClaim(id.epochId, id.mint, id.kind);
  });
});
