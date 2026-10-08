// Facts about the chain and the programs the money paths rely on, read off the
// local validator (which runs the MAINNET Meteora binaries and clones the
// mainnet ZEC mint and DAMM v2 config). PORT-ASSUMPTIONS D9, D10, D21, D25, S1,
// S5. Skipped when no validator is up.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { config } from "../src/config";
import { getConnection, getCpAmm } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { sendSolanaZecPayouts } from "../src/epoch/solanaPayout";

async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

describe.if(await validatorUp())("chain facts (live validator)", () => {
  test("the Solana-ZEC quote mint is classic SPL, 8 decimals, with no freeze authority (no payout account can be frozen)", async () => {
    const mint = await getMint(getConnection(), config.solana.dbc.quoteMint, "confirmed", TOKEN_PROGRAM_ID);
    expect(mint.decimals).toBe(8);
    expect(mint.decimals).toBe(config.solana.dbc.quoteDecimals);
    expect(mint.freezeAuthority).toBeNull();
  });

  test("the DAMM v2 config the 1% migration option forces: base fee exactly 1%, no schedule, protocol share 20%, fees collected in the quote token", async () => {
    const key = config.solana.dbc.dammConfig;
    expect(key.toBase58()).toBe("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp");
    const state = await getCpAmm().fetchConfigState(key);
    const data = Buffer.from(state.poolFees.baseFee.data);
    expect(data.readBigUInt64LE(0)).toBe(10_000_000n); // cliff fee numerator over 1e9 = 1%
    expect(data.subarray(8, 32).every((b: number) => b === 0)).toBe(true); // no scheduler periods or reduction (migrate_damm_v2_initialize_pool.rs:419-460)
    expect(state.poolFees.protocolFeePercent).toBe(20);
    expect(state.collectFeeMode).toBe(1);
  });

  test("a 165-byte token account costs 2,039,280 lamports on THIS validator; mainnet and devnet read 1,488,440 on 2026-10-01, so local costs overstate them", async () => {
    expect(await getConnection().getMinimumBalanceForRentExemption(165)).toBe(2_039_280);
    // The mainnet figure is not asserted against the network here (no network in tests). The 30,000-zat
    // new-account threshold must cover the rent in zats: lamports / 1e9 * SOL price / zat price (ZEC $1,587.48, F-033).
    const zatUsd = 1587.48 / 1e8;
    const rentInZats = (rentLamports: number, solUsd: number) => BigInt(Math.ceil(((rentLamports / 1e9) * solUsd) / zatUsd));
    expect(config.epoch.newAccountMinZats).toBeGreaterThan(rentInZats(2_039_280, 200)); // local rent, the plan's SOL $200
    expect(config.epoch.newAccountMinZats).toBeGreaterThan(rentInZats(1_488_440, 300)); // mainnet rent, with room up to SOL $300
  });

  test("a payout batch of 8 recipients that each need a new account lands in one legacy transaction, under 1,232 bytes", async () => {
    const conn = getConnection();
    const keeper = loadKeeperKeypair();
    const quote = config.solana.dbc.quoteMint;
    const keeperAta = (await getOrCreateAssociatedTokenAccount(conn, keeper, quote, keeper.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
    await mintTo(conn, keeper, quote, keeperAta, keeper, 80_000_000n);
    const wallets = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
    const shares = wallets.map((w, i) => ({ wallet: w.toBase58(), amount: BigInt(1_000_000 + i) }));
    const sigs: string[] = [];
    await sendSolanaZecPayouts(shares, { onPending: (_w, sig) => void sigs.push(sig), onSent: () => {} });
    expect(sigs).toHaveLength(1); // 8 recipients = one batch
    const tx = await conn.getTransaction(sigs[0]!, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const size = 1 + 64 + tx!.transaction.message.serialize().length; // one signature (the keeper)
    expect(size).toBeLessThanOrEqual(1232);
    for (const [i, w] of wallets.entries()) {
      const ata = getAssociatedTokenAddressSync(quote, w, false, TOKEN_PROGRAM_ID);
      expect((await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID)).amount).toBe(BigInt(1_000_000 + i));
    }
  }, 60_000);
});
