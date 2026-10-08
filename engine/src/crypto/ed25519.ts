// Ed25519 signature verification with the platform's crypto (OpenSSL/BoringSSL through node:crypto), replacing
// tweetnacl in the two places the pad verifies a signature: the opt-in/opt-out message a wallet signs
// (optin/verify.ts) and the signature 1Click puts on a quote (swap/near1click-api.ts). tweetnacl is a
// single-maintainer package that has not been released since 2020 (audit/S2-SUPPLY-CHAIN.md); this is no new
// dependency. It follows RFC 8032 strictly (a signature whose S is not reduced is refused, which tweetnacl
// accepts), and it never throws: anything malformed is simply "not valid".
import { createPublicKey, verify } from "node:crypto";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo: the 32 raw key bytes follow it. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True iff `signature` (64 bytes) is a valid Ed25519 signature of `message` under `publicKey` (32 bytes). */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
