// Holder snapshot rules (plan 2b, review 2026-09-30). Pure parts need no chain;
// the token-program test runs against the local validator when it is up.
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { deriveDammV2PoolAuthority, deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { eligibleHolders, getExcludedOwners, getAllTokenAccountsForMint, getMintTokenProgram, isNormalWallet } from "../src/holders";

const entry = (owner: string, balance: bigint) => ({ owner, tokenAccount: Keypair.generate().publicKey.toBase58(), balance });
const wallet = () => Keypair.generate().publicKey.toBase58();
const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], TOKEN_2022_PROGRAM_ID)[0].toBase58();

describe("eligibleHolders", () => {
  test("an owner that is off the ed25519 curve (a PDA: a pool vault, locker or Squads vault) is never a holder", () => {
    const vault = pda("vault-seed");
    expect(isNormalWallet(vault)).toBe(false);
    const person = wallet();
    const out = eligibleHolders([entry(vault, 900n), entry(person, 100n)], new Set(), 1n);
    expect(out).toEqual([{ wallet: person, balance: 100n }]);
  });

  test("the incinerator address is off the curve, so tokens burned to it are never a holder", () => {
    expect(isNormalWallet("1nc1nerator11111111111111111111111111111111")).toBe(false);
  });

  test("the keeper, the fee claimer and both Meteora pool authorities are excluded by name", () => {
    const feeClaimer = Keypair.generate().publicKey;
    const keeper = loadKeeperKeypair().publicKey;
    const excluded = getExcludedOwners(keeper, [feeClaimer]);
    for (const a of [keeper, feeClaimer, deriveDbcPoolAuthority(), deriveDammV2PoolAuthority()]) {
      expect(excluded.has(a.toBase58())).toBe(true);
    }
    const person = wallet();
    const out = eligibleHolders([entry(feeClaimer.toBase58(), 5n), entry(keeper.toBase58(), 5n), entry(person, 5n)], excluded, 1n);
    expect(out.map((h) => h.wallet)).toEqual([person]);
  });

  test("a coin's creator is NOT excluded: it is paid like any holder", () => {
    const creator = wallet();
    expect(eligibleHolders([entry(creator, 10n)], getExcludedOwners(null, [Keypair.generate().publicKey]), 1n)).toEqual([{ wallet: creator, balance: 10n }]);
  });

  test("balances sum across an owner's token accounts, and the minimum balance applies to the sum", () => {
    const a = wallet();
    const b = wallet();
    const out = eligibleHolders([entry(a, 3n), entry(a, 4n), entry(b, 2n)], new Set(), 5n);
    expect(out).toEqual([{ wallet: a, balance: 7n }]);
  });
});

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

describe.if(await validatorUp())("the base mint's actual token program (live validator)", () => {
  test("a classic SPL mint is read under the SPL Token program; the old hard-wired Token-2022 query found nothing", async () => {
    const conn = getConnection();
    const keeper = loadKeeperKeypair();
    const mint = await createMint(conn, keeper, keeper.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    const holder = Keypair.generate().publicKey;
    const ata = (await getOrCreateAssociatedTokenAccount(conn, keeper, mint, holder, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
    await mintTo(conn, keeper, mint, ata, keeper, 1234n);

    expect((await getMintTokenProgram(mint)).equals(TOKEN_PROGRAM_ID)).toBe(true);
    const all = await getAllTokenAccountsForMint(mint);
    expect(all.map((a) => [a.owner, a.balance])).toEqual([[holder.toBase58(), 1234n]]);
  });

  test("a Token-2022 mint is read under Token-2022", async () => {
    const conn = getConnection();
    const keeper = loadKeeperKeypair();
    const mint = await createMint(conn, keeper, keeper.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    expect((await getMintTokenProgram(mint)).equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  test("an account that is not a token mint is refused", async () => {
    await expect(getMintTokenProgram(Keypair.generate().publicKey)).rejects.toThrow(/not found/);
    await expect(getMintTokenProgram(new PublicKey("11111111111111111111111111111111"))).rejects.toThrow(/not a token program/);
  });
});
