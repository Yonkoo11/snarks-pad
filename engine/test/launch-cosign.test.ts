// dbc/cosign.ts (audit S5-01): the engine adds the coin's signature only to the launch it built, after the creator's wallet signed it. A wallet may add
// instructions that name no key the pad signs with (a priority fee, Phantom's Lighthouse checks, its own guards) and may replace a built Compute Budget
// instruction; nothing else may change.
import { describe, expect, test } from "bun:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { HOLD_MS, LIGHTHOUSE_PROGRAM_ID, cosignLaunch, holdLaunchKey } from "../src/dbc/cosign";

const PROGRAM = Keypair.generate().publicKey;
const blockhash = () => bs58.encode(Keypair.generate().publicKey.toBytes());

function setup() {
  const creator = Keypair.generate();
  const coin = Keypair.generate();
  const pool = Keypair.generate().publicKey;
  const hash = blockhash();
  const ixs = [
    new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }, { pubkey: coin.publicKey, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }], data: Buffer.from("create") }),
    new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: pool, isSigner: false, isWritable: true }], data: Buffer.from("buy") }),
  ];
  const built = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions: ixs }).compileToV0Message();
  holdLaunchKey(coin, built, creator.publicKey);
  const mint = coin.publicKey.toBase58();
  /** What a wallet returns: the instructions it was given (or changed ones), recompiled, signed by the creator. */
  const walletSigned = (instructions = ixs, opts: { payer?: Keypair; hash?: string; sign?: boolean } = {}) => {
    const payer = opts.payer ?? creator;
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: opts.hash ?? hash, instructions }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    if (opts.sign !== false) tx.signatures[0] = nacl.sign.detached(msg.serialize(), payer.secretKey);
    return Buffer.from(tx.serialize()).toString("base64");
  };
  return { creator, coin, pool, ixs, mint, walletSigned };
}

const allSigned = (b64: string): boolean => {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const m = tx.message.serialize();
  return tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).every((k, i) => nacl.sign.detached.verify(m, tx.signatures[i]!, k.toBytes()));
};
const lighthouse = (keys: PublicKey[]) => new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: Buffer.from([1, 2, 3]) });

describe("the engine signs only the launch it built, after the wallet", () => {
  test("the wallet's signed copy comes back with the coin's signature, both valid", () => {
    const s = setup();
    expect(allSigned(cosignLaunch(s.mint, s.walletSigned()))).toBe(true);
  });

  test("a wallet's priority fee and Phantom's Lighthouse checks are allowed", () => {
    const s = setup();
    const fee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
    const out = cosignLaunch(s.mint, s.walletSigned([fee, ...s.ixs, lighthouse([s.creator.publicKey, s.pool])]));
    expect(allSigned(out)).toBe(true);
  });

  test("an added transfer (a new signer), a changed or dropped instruction, or any added instruction naming the coin is refused", () => {
    const steal = SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const other = Keypair.generate().publicKey;
    for (const change of [
      (s: ReturnType<typeof setup>) => [...s.ixs, steal],
      (s: ReturnType<typeof setup>) => [s.ixs[0]!, new TransactionInstruction({ ...s.ixs[1]!, data: Buffer.from("sell") })],
      (s: ReturnType<typeof setup>) => [s.ixs[0]!],
      (s: ReturnType<typeof setup>) => [...s.ixs, lighthouse([s.coin.publicKey])],
      (s: ReturnType<typeof setup>) => [...s.ixs, new TransactionInstruction({ programId: other, keys: [{ pubkey: s.coin.publicKey, isSigner: false, isWritable: true }], data: Buffer.from([9]) })],
    ]) {
      const s = setup();
      expect(() => cosignLaunch(s.mint, s.walletSigned(change(s)))).toThrow("tx_mismatch");
    }
  });

  test("an added instruction from any program naming neither the coin nor the pad's signer is allowed (a wallet's own guard or memo)", () => {
    const s = setup();
    const guard = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: s.pool, isSigner: false, isWritable: true }, { pubkey: s.creator.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([7, 7, 7, 7]) });
    expect(allSigned(cosignLaunch(s.mint, s.walletSigned([guard, ...s.ixs, guard])))).toBe(true);
  });

  test("a built Compute Budget instruction is optional: the wallet may drop it or set its own; the rest must stay", () => {
    const creator = Keypair.generate();
    const coin = Keypair.generate();
    const hash = blockhash();
    const create = new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }, { pubkey: coin.publicKey, isSigner: true, isWritable: true }], data: Buffer.from("create") });
    const builtIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), create];
    const signed = (instructions: TransactionInstruction[]) => {
      const msg = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.signatures[0] = nacl.sign.detached(msg.serialize(), creator.secretKey);
      return Buffer.from(tx.serialize()).toString("base64");
    };
    const hold = () => holdLaunchKey(coin, new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions: builtIxs }).compileToV0Message(), creator.publicKey);
    hold();
    expect(allSigned(cosignLaunch(coin.publicKey.toBase58(), signed([create])))).toBe(true);
    hold();
    expect(allSigned(cosignLaunch(coin.publicKey.toBase58(), signed([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }), create])))).toBe(true);
    hold();
    expect(() => cosignLaunch(coin.publicKey.toBase58(), signed([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]))).toThrow("tx_mismatch");
  });

  test("a refusal says what the wallet added or changed, in the log's shape", () => {
    const s = setup();
    // An unknown program's instruction naming the coin, with no new signer (a new signer is refused earlier, as "signers").
    const other = Keypair.generate().publicKey;
    const added = new TransactionInstruction({ programId: other, keys: [{ pubkey: s.coin.publicKey, isSigner: false, isWritable: true }], data: Buffer.from([7, 7, 7, 7]) });
    let detail = "";
    try {
      cosignLaunch(s.mint, s.walletSigned([...s.ixs, added]));
    } catch (e) {
      detail = (e as { detail: string }).detail;
    }
    const prog = PROGRAM.toBase58().slice(0, 8);
    expect(detail).toBe(`instructions: got =${prog}:3k/6b! =${prog}:1k/3b ?${other.toBase58().slice(0, 8)}:1k/4b!; built ${prog}:3k/6b! ${prog}:1k/3b; found 2 of 2`);
  });

  test("an added instruction naming the pad's launch signer (a read-only signer after the coin) is refused; one naming only the creator is not", () => {
    const creator = Keypair.generate();
    const coin = Keypair.generate();
    const pad = Keypair.generate();
    const hash = blockhash();
    const ixs = [
      new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }, { pubkey: coin.publicKey, isSigner: true, isWritable: true }], data: Buffer.from("create") }),
      new TransactionInstruction({ programId: PROGRAM, keys: [{ pubkey: pad.publicKey, isSigner: true, isWritable: false }], data: Buffer.from("memo") }),
    ];
    const signed = (instructions: TransactionInstruction[]) => {
      const msg = new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.signatures[0] = nacl.sign.detached(msg.serialize(), creator.secretKey);
      return Buffer.from(tx.serialize()).toString("base64");
    };
    const hold = () => holdLaunchKey(coin, new TransactionMessage({ payerKey: creator.publicKey, recentBlockhash: hash, instructions: ixs }).compileToV0Message(), creator.publicKey);
    hold();
    expect(() => cosignLaunch(coin.publicKey.toBase58(), signed([...ixs, lighthouse([pad.publicKey])]))).toThrow("tx_mismatch");
    hold();
    expect(() => cosignLaunch(coin.publicKey.toBase58(), signed([lighthouse([creator.publicKey]), ...ixs]))).not.toThrow();
  });

  test("not signed by the creator, another fee payer, or another blockhash is refused", () => {
    let s = setup();
    expect(() => cosignLaunch(s.mint, s.walletSigned(s.ixs, { sign: false }))).toThrow("tx_mismatch");
    s = setup();
    const other = Keypair.generate();
    const theirs = s.ixs.map((ix) => new TransactionInstruction({ ...ix, keys: ix.keys.map((k) => (k.pubkey.equals(s.creator.publicKey) ? { ...k, pubkey: other.publicKey } : k)) }));
    expect(() => cosignLaunch(s.mint, s.walletSigned(theirs, { payer: other }))).toThrow("tx_mismatch");
    s = setup();
    expect(() => cosignLaunch(s.mint, s.walletSigned(s.ixs, { hash: blockhash() }))).toThrow("tx_mismatch");
  });

  test("the key is used once: a second request, or one after the hold, finds no launch", () => {
    let s = setup();
    cosignLaunch(s.mint, s.walletSigned());
    expect(() => cosignLaunch(s.mint, s.walletSigned())).toThrow("unknown_launch");
    s = setup();
    expect(() => cosignLaunch(s.mint, s.walletSigned(), Date.now() + HOLD_MS + 1)).toThrow("unknown_launch");
    s = setup();
    expect(() => cosignLaunch(s.mint, "not base64 at all")).toThrow("bad_tx");
    expect(() => cosignLaunch(s.mint, s.walletSigned())).toThrow("unknown_launch"); // a refused request used the key up too
  });
});
