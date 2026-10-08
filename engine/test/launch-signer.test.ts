// The pad's launch signer (Meteora's ask, 2026-10-08): every launch carries one fixed key as a read-only signer that no instruction names, so trading
// terminals can attribute the launch to the pad; the engine adds it where it signs, and the co-sign step signs with it after the wallet. No chain.
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config } from "../src/config";
import { cosignLaunch, holdLaunchKey } from "../src/dbc/cosign";
import { forgetLaunchpadSigner, launchpadSigner, launchpadSignerAddress, withExtraReadonlySigner, withLaunchpadSigner } from "../src/dbc/launchSigner";

const blockhash = () => bs58.encode(Keypair.generate().publicKey.toBytes());
const PROGRAM = Keypair.generate().publicKey;

function launchLike() {
  const creator = Keypair.generate();
  const coin = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const ixs = [
    new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }, { pubkey: coin.publicKey, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }], data: Buffer.from("create") }),
    SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: pool, lamports: 1 }),
  ];
  const hash = blockhash();
  const message = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions: ixs }).compileToV0Message();
  return { creator, coin, pool, ixs, hash, message };
}

describe("a read-only signer no instruction names, the shape terminals index", () => {
  test("the signer is the last required signature, read-only; every instruction decompiles as before; the blockhash stays", () => {
    const { creator, coin, ixs, hash, message } = launchLike();
    const pad = Keypair.generate().publicKey;
    const out = withExtraReadonlySigner(message, pad);
    expect(out.header).toEqual({ numRequiredSignatures: 3, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts });
    expect(out.staticAccountKeys.slice(0, 3).map((k) => k.toBase58())).toEqual([creator.publicKey, coin.publicKey, pad].map((k) => k.toBase58()));
    expect(out.isAccountSigner(2) && !out.isAccountWritable(2)).toBe(true);
    expect(out.recentBlockhash).toBe(hash);
    const back = TransactionMessage.decompile(out).instructions;
    expect(back.map((ix) => ({ p: ix.programId.toBase58(), k: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), d: Buffer.from(ix.data).toString("hex") })))
      .toEqual(ixs.map((ix) => ({ p: ix.programId.toBase58(), k: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), d: Buffer.from(ix.data).toString("hex") })));
    expect(back.some((ix) => ix.keys.some((k) => k.pubkey.equals(pad)))).toBe(false); // named by no instruction
    // the message round-trips through the wire format with the signer in place
    const wire = VersionedTransaction.deserialize(new VersionedTransaction(out).serialize()).message;
    expect(wire.staticAccountKeys[2]!.equals(pad) && wire.header.numRequiredSignatures === 3).toBe(true);
  });

  test("a signer already among the launch's accounts is refused rather than listed twice", () => {
    const { creator, message } = launchLike();
    expect(() => withExtraReadonlySigner(message, creator.publicKey)).toThrow(/already an account/);
  });

  test("local mode makes the pad's key once and reads it back; the address is published", () => {
    const path = config.paths.launchpadSigner;
    forgetLaunchpadSigner();
    const first = launchpadSigner()!;
    expect(existsSync(path)).toBe(true);
    forgetLaunchpadSigner();
    expect(launchpadSigner()!.publicKey.equals(first.publicKey)).toBe(true);
    expect(launchpadSignerAddress()).toBe(first.publicKey.toBase58());
    const { message } = launchLike();
    expect(withLaunchpadSigner(message).staticAccountKeys[2]!.equals(first.publicKey)).toBe(true);
    void rmSync; // the key file stays for the other tests of this run (the chain lane launches with it)
  });
});

describe("the co-sign step signs with the pad's key after the wallet", () => {
  const allSigned = (b64: string): boolean => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const m = tx.message.serialize();
    return tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).every((k, i) => nacl.sign.detached.verify(m, tx.signatures[i]!, k.toBytes()));
  };
  const walletSigned = (message: ReturnType<typeof withLaunchpadSigner>, payer: Keypair): string => {
    const tx = new VersionedTransaction(message);
    tx.signatures[0] = nacl.sign.detached(message.serialize(), payer.secretKey);
    return Buffer.from(tx.serialize()).toString("base64");
  };

  test("a launch built with the signer comes back with three valid signatures: wallet, coin, pad", () => {
    const { creator, coin, message } = launchLike();
    const built = withLaunchpadSigner(message);
    holdLaunchKey(coin, built, creator.publicKey);
    const out = cosignLaunch(coin.publicKey.toBase58(), walletSigned(built, creator));
    const tx = VersionedTransaction.deserialize(Buffer.from(out, "base64"));
    expect(tx.message.header.numRequiredSignatures).toBe(3);
    expect(tx.message.staticAccountKeys[2]!.toBase58()).toBe(launchpadSignerAddress()!);
    expect(allSigned(out)).toBe(true);
  });

  test("a wallet copy that dropped the pad's signer, or swapped it for another key, is refused", () => {
    const { creator, coin, message } = launchLike();
    const built = withLaunchpadSigner(message);
    holdLaunchKey(coin, built, creator.publicKey);
    expect(() => cosignLaunch(coin.publicKey.toBase58(), walletSigned(message, creator))).toThrow("tx_mismatch");
    holdLaunchKey(coin, built, creator.publicKey);
    const other = withExtraReadonlySigner(message, new PublicKey(Keypair.generate().publicKey));
    expect(() => cosignLaunch(coin.publicKey.toBase58(), walletSigned(other, creator))).toThrow("tx_mismatch");
  });
});
