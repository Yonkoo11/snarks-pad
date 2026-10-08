// A Squads v4 multisig on the local validator for tests and the e2e: the owner
// (A, all permissions, stands in for the phone wallet), the offline backup (B,
// all permissions) and the keeper (Initiate+Vote+Execute), threshold 2. The
// vault (index 0) is the DBC fee claimer.
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { getConnection } from "../../src/solana";
import { KEEPER_PERMISSIONS, vaultOf } from "../../src/dbc/squads";

export interface LocalMultisig {
  multisigPda: PublicKey;
  vault: PublicKey;
  owner: Keypair;
  backup: Keypair;
}

export async function createLocalMultisig(keeper: Keypair): Promise<LocalMultisig> {
  const conn = getConnection();
  const owner = Keypair.generate();
  const backup = Keypair.generate();
  const createKey = Keypair.generate();
  for (const k of [owner, backup]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5e9), "confirmed");
  const [multisigPda] = sqds.getMultisigPda({ createKey: createKey.publicKey });
  const { treasury } = await sqds.accounts.ProgramConfig.fromAccountAddress(conn, sqds.getProgramConfigPda({})[0]);
  const ix = sqds.instructions.multisigCreateV2({
    treasury, creator: owner.publicKey, multisigPda, configAuthority: null, threshold: 2, timeLock: 0,
    createKey: createKey.publicKey, rentCollector: keeper.publicKey, // finished proposals refund their rent to the keeper, which fronted it
    members: [
      { key: owner.publicKey, permissions: sqds.types.Permissions.all() },
      { key: backup.publicKey, permissions: sqds.types.Permissions.all() },
      { key: keeper.publicKey, permissions: KEEPER_PERMISSIONS },
    ],
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [owner, createKey], { commitment: "confirmed" });
  return { multisigPda, vault: vaultOf(multisigPda), owner, backup };
}

/** Rejects a proposal with the given members until it is Rejected (needs members - threshold + 1 = 2 rejections here). */
export async function rejectProposal(multisigPda: PublicKey, index: bigint, members: Keypair[]): Promise<void> {
  const conn = getConnection();
  for (const m of members) {
    await sendAndConfirmTransaction(conn, new Transaction().add(sqds.instructions.proposalReject({ multisigPda, transactionIndex: index, member: m.publicKey })), [m], { commitment: "confirmed" });
  }
}

/** A member-set change by owner + backup (here a no-op threshold change). Every proposal made before it becomes stale and can never execute. */
export async function makeProposalsStale(ms: LocalMultisig): Promise<void> {
  const conn = getConnection();
  const current = await sqds.accounts.Multisig.fromAccountAddress(conn, ms.multisigPda);
  const transactionIndex = BigInt(current.transactionIndex.toString()) + 1n;
  const send = (ixs: Transaction["instructions"], signer: Keypair) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
  await send([
    sqds.instructions.configTransactionCreate({ multisigPda: ms.multisigPda, transactionIndex, creator: ms.owner.publicKey, actions: [{ __kind: "ChangeThreshold", newThreshold: 2 }] }),
    sqds.instructions.proposalCreate({ multisigPda: ms.multisigPda, transactionIndex, creator: ms.owner.publicKey }),
  ], ms.owner);
  for (const m of [ms.owner, ms.backup]) await send([sqds.instructions.proposalApprove({ multisigPda: ms.multisigPda, transactionIndex, member: m.publicKey })], m);
  await send([sqds.instructions.configTransactionExecute({ multisigPda: ms.multisigPda, transactionIndex, member: ms.owner.publicKey, rentPayer: ms.owner.publicKey })], ms.owner);
}
