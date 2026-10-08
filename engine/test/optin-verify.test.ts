import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { verifyWalletSignature } from "../src/optin/verify";
import { optinMessage, optoutMessage } from "../src/optin/message";

function sign(kp: Keypair, message: string): string {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
  return bs58.encode(sig);
}

describe("optin message format", () => {
  test("matches the exact contract text", () => {
    const msg = optinMessage("WALLET111", "u1abc", "nonce123");
    expect(msg).toBe("SNARKS pad: deliver my rewards shielded\nwallet: WALLET111\nzcash: u1abc\nnonce: nonce123");
  });

  test("opt-out message matches the exact contract text", () => {
    const msg = optoutMessage("WALLET111", "nonce123");
    expect(msg).toBe("SNARKS pad: stop shielded delivery\nwallet: WALLET111\nnonce: nonce123");
  });
});

describe("verifyWalletSignature", () => {
  test("accepts a genuine signature over the exact message", () => {
    const kp = Keypair.generate();
    const message = optinMessage(kp.publicKey.toBase58(), "u1fakeaddress", "n1");
    const sig = sign(kp, message);
    expect(verifyWalletSignature(kp.publicKey.toBase58(), message, sig)).toBe(true);
  });

  test("rejects a signature from a different wallet", () => {
    const signer = Keypair.generate();
    const claimedWallet = Keypair.generate();
    const message = optinMessage(claimedWallet.publicKey.toBase58(), "u1fakeaddress", "n1");
    const sig = sign(signer, message);
    expect(verifyWalletSignature(claimedWallet.publicKey.toBase58(), message, sig)).toBe(false);
  });

  test("rejects a signature over a mutated message (tampered address)", () => {
    const kp = Keypair.generate();
    const original = optinMessage(kp.publicKey.toBase58(), "u1original", "n1");
    const sig = sign(kp, original);
    const tampered = optinMessage(kp.publicKey.toBase58(), "u1attacker", "n1");
    expect(verifyWalletSignature(kp.publicKey.toBase58(), tampered, sig)).toBe(false);
  });

  test("rejects garbage signature bytes", () => {
    const kp = Keypair.generate();
    const message = optinMessage(kp.publicKey.toBase58(), "u1x", "n1");
    expect(verifyWalletSignature(kp.publicKey.toBase58(), message, bs58.encode(new Uint8Array(64)))).toBe(false);
  });

  test("rejects a malformed wallet or signature string without throwing", () => {
    expect(verifyWalletSignature("not-a-pubkey", "msg", "not-a-sig")).toBe(false);
  });
});
