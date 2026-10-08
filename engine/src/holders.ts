// Holder snapshot for a launched mint: every wallet that owns the coin, except
// the addresses that are not people (plan 2b, review 2026-09-30):
//   - every owner that is OFF the ed25519 curve: PDAs, Meteora's pool
//     authorities and vaults, lockers, Squads vaults, and any pool someone else
//     opens for the coin on Raydium/Orca/DLMM. ZEC sent to a program-owned
//     vault is lost, so only normal keypair wallets are ever paid;
//   - the keeper, the fee_claimer and, when the fee_claimer is a Squads vault,
//     every member of that multisig (named explicitly: they are on the curve).
// The coin's own creator is NOT excluded: its first-buy wallet is paid like any
// holder and flagged in the ledger (epoch/engine.ts planPayouts).
// The base mint's ACTUAL token program is read from the mint account rather
// than assumed (DBC launches Token-2022 here, but a config can also be SPL).
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { deriveDammV2PoolAuthority, deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getConnection } from "./solana";
import * as db from "./db";

export interface TokenAccountEntry {
  owner: string;
  tokenAccount: string;
  balance: bigint;
}

/** The token program that owns `mint`. Throws for anything that is not a token mint. */
export async function getMintTokenProgram(mint: PublicKey): Promise<PublicKey> {
  const info = await getConnection().getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}, not a token program`);
}

/** All token accounts for `mint`, decoded, unfiltered, under the mint's own token program. */
export async function getAllTokenAccountsForMint(mint: PublicKey): Promise<TokenAccountEntry[]> {
  const programId = await getMintTokenProgram(mint);
  // No dataSize filter: Token-2022 accounts vary in length depending on which
  // extensions apply. The mint memcmp at offset 0 is enough to narrow this to
  // exactly this coin's accounts.
  const accounts = await getConnection().getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  return accounts.map(({ pubkey, account }) => {
    const decoded = unpackAccount(pubkey, { ...account, data: account.data }, programId);
    return { owner: decoded.owner.toBase58(), tokenAccount: pubkey.toBase58(), balance: decoded.amount };
  });
}

/**
 * Owners that are never paid even though they sit on the curve: the keeper and
 * every fee claimer, plus both Meteora pool-authority PDAs (off-curve, so the
 * curve rule would catch them anyway; listed so the intent is explicit and a
 * change to the curve rule cannot silently start paying a vault). Takes PUBLIC
 * keys only: nothing here may touch a secret key (the API calls it, INV-17).
 */
export function getExcludedOwners(keeper: PublicKey | null, feeClaimers: PublicKey[]): Set<string> {
  return new Set([
    deriveDbcPoolAuthority().toBase58(),
    deriveDammV2PoolAuthority().toBase58(),
    ...(keeper ? [keeper.toBase58()] : []),
    ...feeClaimers.map((k) => k.toBase58()),
  ]);
}

/** Meta key under which the keeper-side scripts record the keeper's PUBLIC address for the API. */
export const KEEPER_PUBKEY_META = "keeper_pubkey";

/** Meta key under which the Squads claimer records the multisig's member addresses (JSON array of base58). */
export const SQUADS_MEMBERS_META = "squads_members";

/** The exclusion set from what the DB knows: the recorded keeper, the fee claimer of every config and the recorded Squads members. */
export function recordedExcludedOwners(): Set<string> {
  const keeper = db.getMeta(KEEPER_PUBKEY_META);
  const members: string[] = JSON.parse(db.getMeta(SQUADS_MEMBERS_META) ?? "[]");
  const claimers = [...db.listDbcConfigs().map((c) => c.feeClaimer), ...members].map((k) => new PublicKey(k));
  return getExcludedOwners(keeper ? new PublicKey(keeper) : null, claimers);
}

export function isNormalWallet(owner: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(owner).toBytes());
  } catch {
    return false;
  }
}

export interface HolderSnapshotParams {
  mint: PublicKey;
  excludeOwners: Set<string>; // keeper, fee claimer, pool authorities
  minBalance: bigint;
}

export interface Holder {
  wallet: string;
  balance: bigint; // summed across every token account that owner holds for this mint
}

/** Pure: the eligibility rules applied to already-fetched token accounts. */
export function eligibleHolders(all: TokenAccountEntry[], excludeOwners: Set<string>, minBalance: bigint): Holder[] {
  const byOwner = new Map<string, bigint>();
  for (const a of all) {
    if (excludeOwners.has(a.owner) || !isNormalWallet(a.owner)) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.balance);
  }
  return [...byOwner.entries()].filter(([, balance]) => balance >= minBalance).map(([wallet, balance]) => ({ wallet, balance }));
}

export async function snapshotHolders(p: HolderSnapshotParams): Promise<Holder[]> {
  return eligibleHolders(await getAllTokenAccountsForMint(p.mint), p.excludeOwners, p.minBalance);
}
