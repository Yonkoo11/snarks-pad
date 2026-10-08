// The pad's launch signer (Meteora's ask, 2026-10-08): one key that signs every launch transaction so trading terminals (Jupiter, Axiom, GMGN and the others)
// can tell a SNARKS pad launch from any other DBC pool and label it. It is a read-only signer that no instruction names, the shape of the launchpad
// transactions those terminals already index (a reference launch on mainnet carries its pad's signer as the fourth account, signer, not writable, in no
// instruction). The key holds nothing and can do nothing but sign: a leak costs the pad its label until the key is rotated. It is made on the server
// (ops/keys-setup.sh <instance> signer) and read by the API, which co-signs launches; the keeper never needs it. Local mode makes one in engine/keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair, MessageV0, type PublicKey } from "@solana/web3.js";
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

/**
 * The same message with `signer` as one more required signature: read-only, named by no instruction, placed last among the signers (after the
 * writable ones, where the message layout puts read-only signers). Instruction account indexes at or past that slot move up by one; address table
 * lookups index their own tables and do not move. Everything else, the blockhash included, stays as compiled.
 */
export function withExtraReadonlySigner(message: MessageV0, signer: PublicKey): MessageV0 {
  const at = message.header.numRequiredSignatures;
  if (message.staticAccountKeys.some((k) => k.equals(signer))) throw new Error("the launch signer is already an account of the launch");
  const shift = (i: number): number => (i >= at ? i + 1 : i);
  return new MessageV0({
    header: {
      numRequiredSignatures: at + 1,
      numReadonlySignedAccounts: message.header.numReadonlySignedAccounts + 1,
      numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts,
    },
    staticAccountKeys: [...message.staticAccountKeys.slice(0, at), signer, ...message.staticAccountKeys.slice(at)],
    recentBlockhash: message.recentBlockhash,
    compiledInstructions: message.compiledInstructions.map((ix) => ({ programIdIndex: shift(ix.programIdIndex), accountKeyIndexes: ix.accountKeyIndexes.map(shift), data: ix.data })),
    addressTableLookups: message.addressTableLookups,
  });
}

/** `message` with the pad's signer added when this instance has one; unchanged otherwise. */
export function withLaunchpadSigner(message: MessageV0): MessageV0 {
  const kp = launchpadSigner();
  return kp ? withExtraReadonlySigner(message, kp.publicKey) : message;
}
