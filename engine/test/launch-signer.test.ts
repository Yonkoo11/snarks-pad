// The pad's launch signer (Meteora's ask, 2026-10-08): every launch carries one fixed key as a read-only signer, named by a memo instruction so a wallet
// that rebuilds the transaction (Phantom) keeps it; the engine adds it where it signs, and the co-sign step signs with it after the wallet. No chain.
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, type MessageV0, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config } from "../src/config";
import { LIGHTHOUSE_PROGRAM_ID, cosignLaunch, holdLaunchKey } from "../src/dbc/cosign";
import { LAUNCH_MEMO, attributionIx, forgetLaunchpadSigner, launchpadSigner, launchpadSignerAddress, withLaunchpadSigner } from "../src/dbc/launchSigner";
import { MEMO_PROGRAM_ID } from "../src/memoProgram";

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
  const compile = (instructions: TransactionInstruction[]) => new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions }).compileToV0Message();
  return { creator, coin, pool, ixs, hash, message: compile(ixs), compile };
}

describe("a read-only signer named by one memo instruction, last among the signatures", () => {
  test("the signer is the last required signature, read-only; the launch's own instructions are as before; the memo names only the signer", () => {
    const { creator, coin, ixs, hash } = launchLike();
    const pad = Keypair.generate().publicKey;
    const instructions = [...ixs, attributionIx(pad)];
    const out = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions }).compileToV0Message();
    expect(out.header.numRequiredSignatures).toBe(3);
    expect(out.header.numReadonlySignedAccounts).toBe(1);
    expect(out.staticAccountKeys.slice(0, 3).map((k) => k.toBase58())).toEqual([creator.publicKey, coin.publicKey, pad].map((k) => k.toBase58()));
    expect(out.isAccountSigner(2) && !out.isAccountWritable(2)).toBe(true);
    const back = TransactionMessage.decompile(out).instructions;
    const shape = (ix: TransactionInstruction) => ({ p: ix.programId.toBase58(), k: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), d: Buffer.from(ix.data).toString("hex") });
    expect(back.slice(0, -1).map(shape)).toEqual(ixs.map(shape));
    const memo = back.at(-1)!;
    expect(memo.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(memo.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([[pad.toBase58(), true, false]]);
    expect(Buffer.from(memo.data).toString("utf8")).toBe(LAUNCH_MEMO);
    // the message round-trips through the wire format with the signer in place
    const wire = VersionedTransaction.deserialize(new VersionedTransaction(out).serialize()).message;
    expect(wire.staticAccountKeys[2]!.equals(pad) && wire.header.numRequiredSignatures === 3).toBe(true);
  });

  test("local mode makes the pad's key once and reads it back; the address is published; with no key the instructions are untouched", () => {
    const path = config.paths.launchpadSigner;
    forgetLaunchpadSigner();
    const first = launchpadSigner()!;
    expect(existsSync(path)).toBe(true);
    forgetLaunchpadSigner();
    expect(launchpadSigner()!.publicKey.equals(first.publicKey)).toBe(true);
    expect(launchpadSignerAddress()).toBe(first.publicKey.toBase58());
    const { ixs } = launchLike();
    const out = withLaunchpadSigner(ixs);
    expect(out.length).toBe(ixs.length + 1);
    expect(out.at(-1)!.keys[0]!.pubkey.equals(first.publicKey)).toBe(true);
    void rmSync; // the key file stays for the other tests of this run (the chain lane launches with it)
  });
});

describe("the co-sign step signs with the pad's key after the wallet", () => {
  const allSigned = (b64: string): boolean => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const m = tx.message.serialize();
    return tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).every((k, i) => nacl.sign.detached.verify(m, tx.signatures[i]!, k.toBytes()));
  };
  const walletSigned = (message: MessageV0, payer: Keypair): string => {
    const tx = new VersionedTransaction(message);
    tx.signatures[0] = nacl.sign.detached(message.serialize(), payer.secretKey);
    return Buffer.from(tx.serialize()).toString("base64");
  };

  test("a launch built with the signer comes back with three valid signatures: wallet, coin, pad", () => {
    const { creator, coin, ixs, compile } = launchLike();
    const built = compile(withLaunchpadSigner(ixs));
    holdLaunchKey(coin, built, creator.publicKey);
    const out = cosignLaunch(coin.publicKey.toBase58(), walletSigned(built, creator));
    const tx = VersionedTransaction.deserialize(Buffer.from(out, "base64"));
    expect(tx.message.header.numRequiredSignatures).toBe(3);
    expect(tx.message.staticAccountKeys[2]!.toBase58()).toBe(launchpadSignerAddress()!);
    expect(allSigned(out)).toBe(true);
  });

  test("a wallet copy that dropped the pad's signer (memo and all), or swapped it for another key, is refused", () => {
    const { creator, coin, ixs, message, compile } = launchLike();
    const built = compile(withLaunchpadSigner(ixs));
    holdLaunchKey(coin, built, creator.publicKey);
    expect(() => cosignLaunch(coin.publicKey.toBase58(), walletSigned(message, creator))).toThrow("tx_mismatch");
    holdLaunchKey(coin, built, creator.publicKey);
    const other = compile([...ixs, attributionIx(new PublicKey(Keypair.generate().publicKey))]);
    expect(() => cosignLaunch(coin.publicKey.toBase58(), walletSigned(other, creator))).toThrow("tx_mismatch");
  });
});

describe("the signer survives a wallet that rebuilds the launch from its instructions (Phantom, measured 2026-10-11)", () => {
  const allSigned = (b64: string): boolean => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const m = tx.message.serialize();
    return tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).every((k, i) => nacl.sign.detached.verify(m, tx.signatures[i]!, k.toBytes()));
  };
  /** Phantom decompiles the launch, adds its Lighthouse checks and compiles a fresh message: only the payer and the accounts instructions name survive. */
  const phantomSigned = (built: MessageV0, payer: Keypair, extra: TransactionInstruction[]): string => {
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: built.recentBlockhash, instructions: [...TransactionMessage.decompile(built).instructions, ...extra] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.signatures[0] = nacl.sign.detached(msg.serialize(), payer.secretKey);
    return Buffer.from(tx.serialize()).toString("base64");
  };

  test("three attempts on mainnet were refused 'signers' because no instruction named the pad; the rebuilt launch must still carry it", () => {
    const { creator, coin, pool, ixs, compile } = launchLike();
    const built = compile(withLaunchpadSigner(ixs));
    holdLaunchKey(coin, built, creator.publicKey);
    const lighthouse = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [{ pubkey: creator.publicKey, isSigner: false, isWritable: false }, { pubkey: pool, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
    const out = cosignLaunch(coin.publicKey.toBase58(), phantomSigned(built, creator, [lighthouse]));
    const tx = VersionedTransaction.deserialize(Buffer.from(out, "base64"));
    expect(tx.message.header.numRequiredSignatures).toBe(3);
    expect(tx.message.staticAccountKeys[2]!.toBase58()).toBe(launchpadSignerAddress()!);
    expect(tx.message.isAccountSigner(2) && !tx.message.isAccountWritable(2)).toBe(true);
    expect(allSigned(out)).toBe(true);
  });
});
