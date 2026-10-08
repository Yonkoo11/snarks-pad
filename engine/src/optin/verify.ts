// Ed25519 verification of a Solana wallet's signature over the opt-in/opt-out message.
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { verifyEd25519 } from "../crypto/ed25519";

/** Returns true iff `signatureB58` is a valid ed25519 signature by `walletBase58` over `message`. */
export function verifyWalletSignature(walletBase58: string, message: string, signatureB58: string): boolean {
  let pubkeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubkeyBytes = new PublicKey(walletBase58).toBytes();
    sigBytes = bs58.decode(signatureB58);
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;
  return verifyEd25519(new TextEncoder().encode(message), sigBytes, pubkeyBytes);
}
