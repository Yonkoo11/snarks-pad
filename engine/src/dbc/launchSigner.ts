// The pad's launch signer (Meteora's ask, 2026-10-08): one key that signs every launch transaction so trading terminals (Jupiter, Axiom, GMGN and the others)
// can tell a SNARKS pad launch from any other DBC pool and label it. It rides as a read-only signer, named by one instruction: an SPL Memo ("snarks.fun")
// whose only account is the signer. Until 2026-10-11 it was added to the compiled message with no instruction naming it (the shape of a reference launch
// on mainnet); Phantom rebuilds a transaction from its instructions when it adds its Lighthouse checks, which drops any account no instruction names, and
// three mainnet launches were refused by the co-sign check that night (engine log "launch-cosign refused ...: signers"). The memo keeps the signer through
// any rebuild. The key holds nothing and can do nothing but sign: a leak costs the pad its label until the key is rotated. It is made on the server
// (ops/keys-setup.sh <instance> signer) and read by the API, which co-signs launches; the keeper never needs it. Local mode makes one in engine/keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair, type PublicKey, TransactionInstruction } from "@solana/web3.js";
import { MEMO_PROGRAM_ID } from "../memoProgram";
import { config } from "../config";

let loaded: { kp: Keypair | null } | null = null;

/** The pad's launch signer, or null when this instance has none (the launch is then built without it; mainnet warns at startup). */
export function launchpadSigner(): Keypair | null {
  if (loaded) return loaded.kp;
  const path = config.paths.launchpadSigner;
  if (existsSync(path)) {
    loaded = { kp: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))) };
    return loaded.kp;
  }
  if (!config.isLocal) {
    console.error(`[launch] no launch signer at ${path} (LAUNCHPAD_SIGNER_PATH): launches are built without the pad's signature, so terminals cannot attribute them`);
    loaded = { kp: null };
    return null;
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  loaded = { kp };
  return kp;
}

export const launchpadSignerAddress = (): string | null => launchpadSigner()?.publicKey.toBase58() ?? null;

/** For tests: forget the loaded key so the next call reads the path again. */
export function forgetLaunchpadSigner(): void {
  loaded = null;
}

/** The memo every launch carries; what an explorer shows next to the pad's signature. */
export const LAUNCH_MEMO = "snarks.fun";

/**
 * The instruction that names `signer`: an SPL Memo whose one account is the signer, read-only. Compiled, the signer lands last among the required
 * signatures (after the payer and the writable coin key), and a wallet that rebuilds the message from its instructions keeps it there.
 */
export function attributionIx(signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(LAUNCH_MEMO, "utf8") });
}

/** `instructions` followed by the pad's attribution memo when this instance has a signer; unchanged otherwise. */
export function withLaunchpadSigner(instructions: TransactionInstruction[]): TransactionInstruction[] {
  const kp = launchpadSigner();
  return kp ? [...instructions, attributionIx(kp.publicKey)] : instructions;
}
