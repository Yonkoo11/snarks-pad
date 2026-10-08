// Shared by the devnet scripts that drive a DEPLOYED pad through its public API (scripts/devnet-showcase.ts, scripts/devnet-window-proof.ts): the same four calls a browser
// makes (launch-tx, confirm, trade-tx, trade-confirm) with test wallets whose keys this machine holds, and the chain reads that check what the pad said. Devnet only: every
// function that moves money refuses any other mode, and the test wallets' stand-in ZEC is minted by the faucet key (the quote mint's authority), which is a test key.
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { config } from "../../src/config";
import { loadFaucetKeypair } from "../../src/faucet";
import { getConnection, getDbcClient } from "../../src/solana";

if (config.mode !== "devnet") throw new Error("devnet only: run through scripts/devnet.sh");

export interface ApiAnswer<T = Record<string, any>> {
  status: number;
  body: T;
}

/** One call to the deployed pad's API. Never throws on a refusal: the caller reads `status` and `body.error`. */
export async function call(base: string, method: string, path: string, body?: unknown): Promise<ApiAnswer> {
  const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/** A call that must answer 200. The refusal's code is in the message, never the values sent. */
export async function must(base: string, method: string, path: string, body?: unknown): Promise<Record<string, any>> {
  const r = await call(base, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path.split("?")[0]} answered ${r.status} ${String(r.body.error ?? "")}`);
  return r.body;
}

/** Signs a transaction the pad built (its fee payer is `signer`; a launch already carries the new mint's signature) and sends it. Returns the signature once confirmed. */
export async function signAndSend(txBase64: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

const zecAta = (owner: PublicKey): PublicKey => getAssociatedTokenAddressSync(config.solana.dbc.quoteMint, owner, false, TOKEN_PROGRAM_ID);

export async function zecOf(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(getConnection(), zecAta(owner), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
}

/** Brings `wallet` up to `minSol` SOL and `minZecZats` stand-in ZEC from the faucet key (the quote mint's authority). Does nothing when it already holds both. */
export async function topUp(wallet: PublicKey, minSol: number, minZecZats: bigint): Promise<void> {
  const conn = getConnection();
  const faucet = loadFaucetKeypair();
  const wantLamports = Math.round(minSol * 1e9);
  const have = await conn.getBalance(wallet, "confirmed");
  if (have < wantLamports) {
    const pay = new Transaction().add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: wallet, lamports: wantLamports - have }));
    await sendAndConfirmTransaction(conn, pay, [faucet], { commitment: "confirmed" });
  }
  const held = await zecOf(wallet);
  if (held < minZecZats) {
    const ata = (await getOrCreateAssociatedTokenAccount(conn, faucet, config.solana.dbc.quoteMint, wallet, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
    await mintTo(conn, faucet, config.solana.dbc.quoteMint, ata, faucet, minZecZats - held);
  }
}

export interface Counters {
  partner: bigint;
  creator: bigint;
  protocol: bigint;
}

/** What the pool has accrued so far for the partner (the pad), the creator and Meteora: the fee the program really took, read off the pool account. */
export async function counters(poolId: string): Promise<Counters> {
  const s = (await getDbcClient().state.getPool(poolId))!.poolState;
  return { partner: BigInt(s.partnerQuoteFee.toString()), creator: BigInt(s.creatorQuoteFee.toString()), protocol: BigInt(s.protocolQuoteFee.toString()) };
}

export const total = (c: Counters): bigint => c.partner + c.creator + c.protocol;
export const minus = (a: Counters, b: Counters): Counters => ({ partner: a.partner - b.partner, creator: a.creator - b.creator, protocol: a.protocol - b.protocol });

/** The unix second of the block a transaction landed in (the clock the program priced it under). */
export async function blockTimeOf(sig: string): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const tx = await getConnection().getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx?.blockTime) return tx.blockTime;
    await Bun.sleep(300);
  }
  throw new Error(`transaction ${sig} has no block time yet`);
}

/** A wallet with the pad's own launch-and-buy calls: the page's flow, driven from here. */
export interface Launched {
  mint: string;
  poolId: string;
  sig: string;
  activation: number;
}

export async function launch(base: string, creator: Keypair, p: { name: string; symbol: string; description: string; imageUrl: string; feeTier: number; firstBuyZats: bigint; creatorWallet?: string; socials?: { website?: string; x?: string; telegram?: string } }): Promise<Launched> {
  const made = await must(base, "POST", "/coins/launch-tx", {
    creator: creator.publicKey.toBase58(), name: p.name, symbol: p.symbol, description: p.description, imageUrl: p.imageUrl, feeTier: p.feeTier,
    ...(p.firstBuyZats > 0n ? { initialBuyZec: p.firstBuyZats.toString() } : {}), ...(p.creatorWallet ? { creatorWallet: p.creatorWallet } : {}), ...(p.socials ? { socials: p.socials } : {}),
  });
  const sig = await signAndSend(made.tx as string, creator);
  const confirmed = await must(base, "POST", "/coins/confirm", { sig, mint: made.mint });
  const pool = (await getDbcClient().state.getPool(confirmed.poolId as string))!;
  return { mint: made.mint as string, poolId: confirmed.poolId as string, sig, activation: Number(pool.poolState.activationPoint.toString()) };
}

/** One trade through the pad: trade-tx, the wallet signs and sends, trade-confirm records it. Returns the signature and the quote the pad built the transaction with. */
export async function trade(base: string, mint: string, wallet: Keypair, side: "buy" | "sell", amount: bigint, slippageBps = 5000): Promise<{ sig: string; quote: Record<string, any> }> {
  const built = await must(base, "POST", `/coins/${mint}/trade-tx`, { wallet: wallet.publicKey.toBase58(), side, amount: amount.toString(), slippageBps });
  const sig = await signAndSend(built.tx as string, wallet);
  await call(base, "POST", `/coins/${mint}/trade-confirm`, { sig }); // records it for the tape; the trade has already landed whatever this answers
  return { sig, quote: built.quote as Record<string, any> };
}

/** Fee numerator (out of 1e9) of period `second` of a window on a tier whose fee after it is `tierBps`: cliff - second x reduction, the program's linear arithmetic. */
export function numeratorAtSecond(tierBps: number, second: number): bigint {
  const cliff = 990_000_000n;
  const reduction = (cliff - BigInt(tierBps) * 100_000n) / 5n;
  return cliff - BigInt(Math.min(Math.max(second, 0), 5)) * reduction;
}
