// Shared helpers for the stress harness (audit/STRESS-REPORT.md). Local mode only: they mint the cloned ZEC with the
// local keeper key (the mint authority local-up.ts wrote) and airdrop SOL from the test validator.
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { join } from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackAccount,
} from "@solana/spl-token";
import { config } from "../src/config";

if (!config.isLocal) throw new Error("stress helpers are local-only");

export const ZEC = config.solana.dbc.quoteMint;
/** A direct connection to the validator, never through the fault proxy: the harness's own reads must not be faulted or counted. */
export const direct = new Connection("http://127.0.0.1:8899", { commitment: "confirmed", wsEndpoint: "ws://127.0.0.1:8900" });
export const STRESS_DIR = join(config.paths.dataDir, "stress");

/** The ZEC mint authority on the local chain: the key local-up.ts wrote into the cloned mint (keys/keeper-local.json). */
export function mintAuthority(): Keypair {
  const path = join(config.paths.keysDir, "keeper-local.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const sig = await direct.requestAirdrop(to, Math.round(sol * 1e9));
  await direct.confirmTransaction(sig, "confirmed");
}

/** Broadcasts signed bytes and keeps offering them every 2 s until confirmed (the local validator drops some under load). */
export async function sendRawUntilLanded(raw: Uint8Array, sig: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await direct.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    for (let i = 0; i < 4; i++) {
      const st = (await direct.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
      await Bun.sleep(500);
    }
    if (Date.now() > deadline) throw new Error(`tx ${sig} did not land within ${timeoutMs} ms`);
  }
}

export async function send(tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer = tx.feePayer ?? signers[0]!.publicKey;
  tx.recentBlockhash = (await direct.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  return sendRawUntilLanded(tx.serialize(), bs58.encode(tx.signature!));
}

export async function sendV0(txBase64: string, signer: Keypair): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  return sendRawUntilLanded(tx.serialize(), bs58.encode(tx.signatures[0]!));
}

/** Creates ZEC accounts and mints `zats` to each owner, several per transaction. */
export async function mintZecTo(owners: PublicKey[], zats: bigint, perTx = 6): Promise<void> {
  const auth = mintAuthority();
  for (let i = 0; i < owners.length; i += perTx) {
    const tx = new Transaction();
    for (const o of owners.slice(i, i + perTx)) {
      const ata = getAssociatedTokenAddressSync(ZEC, o, true, TOKEN_PROGRAM_ID);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, ata, o, ZEC, TOKEN_PROGRAM_ID));
      if (zats > 0n) tx.add(createMintToCheckedInstruction(ZEC, ata, auth.publicKey, zats, config.solana.dbc.quoteDecimals, [], TOKEN_PROGRAM_ID));
    }
    await send(tx, [auth]);
  }
}

/** SOL to many wallets from one funded payer, 20 transfers per transaction. */
export async function fundSol(payer: Keypair, owners: PublicKey[], sol: number): Promise<void> {
  for (let i = 0; i < owners.length; i += 20) {
    const tx = new Transaction();
    for (const o of owners.slice(i, i + 20)) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: o, lamports: Math.round(sol * 1e9) }));
    await send(tx, [payer]);
  }
}

/** Token-2022 base-token transfers from `from` to many owners (creating their accounts), `perTx` per transaction. */
export async function distributeTokens(from: Keypair, mint: PublicKey, items: { to: PublicKey; raw: bigint }[], perTx = 8): Promise<void> {
  const src = getAssociatedTokenAddressSync(mint, from.publicKey, false, TOKEN_2022_PROGRAM_ID);
  for (let i = 0; i < items.length; i += perTx) {
    const tx = new Transaction();
    for (const it of items.slice(i, i + perTx)) {
      const dest = getAssociatedTokenAddressSync(mint, it.to, true, TOKEN_2022_PROGRAM_ID);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dest, it.to, mint, TOKEN_2022_PROGRAM_ID));
      tx.add(createTransferCheckedInstruction(src, mint, dest, from.publicKey, it.raw, config.solana.dbc.baseDecimals, [], TOKEN_2022_PROGRAM_ID));
    }
    await send(tx, [from]);
  }
}

/** Every token account of `mint` (under `program`), decoded: owner -> summed balance. Read directly from the validator. */
export async function tokenBalancesByOwner(mint: PublicKey, program: PublicKey): Promise<Map<string, bigint>> {
  const accounts = await direct.getProgramAccounts(program, { filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }] });
  const out = new Map<string, bigint>();
  for (const { pubkey, account } of accounts) {
    const a = unpackAccount(pubkey, account, program);
    out.set(a.owner.toBase58(), (out.get(a.owner.toBase58()) ?? 0n) + a.amount);
  }
  return out;
}

/** ZEC balance per owner's associated account (null = no account), read in chunks of 100. */
export async function zecAtaBalances(owners: string[]): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  for (let i = 0; i < owners.length; i += 100) {
    const slice = owners.slice(i, i + 100);
    const atas = slice.map((o) => getAssociatedTokenAddressSync(ZEC, new PublicKey(o), true, TOKEN_PROGRAM_ID));
    const infos = await direct.getMultipleAccountsInfo(atas, "confirmed");
    slice.forEach((o, j) => {
      const info = infos[j];
      out.set(o, info ? unpackAccount(atas[j]!, info, TOKEN_PROGRAM_ID).amount : null);
    });
  }
  return out;
}

/** Runs `fn` over `items` with at most `n` in flight; collects errors instead of stopping. */
export async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<Error[]> {
  const errors: Error[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i]!, i);
      } catch (e) {
        errors.push(e as Error);
      }
    }
  }));
  return errors;
}

export const kpToJson = (k: Keypair): number[] => Array.from(k.secretKey);
export const kpFromJson = (a: number[]): Keypair => Keypair.fromSecretKey(Uint8Array.from(a));

/** Largest-remainder pro-rata split, written here independently of src/epoch/math.ts. Ties go to the earlier item. */
export function independentSplit(total: bigint, weights: { id: string; w: bigint }[]): Map<string, bigint> {
  const sum = weights.reduce((a, x) => a + x.w, 0n);
  const out = new Map<string, bigint>();
  if (sum === 0n) return out;
  const parts = weights.map((x, idx) => ({ id: x.id, idx, base: (total * x.w) / sum, rem: (total * x.w) % sum }));
  let left = total - parts.reduce((a, p) => a + p.base, 0n);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? a.idx - b.idx : a.rem > b.rem ? -1 : 1));
  for (const p of parts) out.set(p.id, p.base);
  for (const p of order) {
    if (left === 0n) break;
    out.set(p.id, out.get(p.id)! + 1n);
    left--;
  }
  return out;
}
