// dbc/trade.ts tradeFromTx: a trade's side and amounts come from the pool's own vault balances before and after the transaction, so a trade a router or
// terminal sent for the payer is recorded (2026-10-12: the first mainnet coin's tape showed 3 trades against ~1,500 on chain), and a liquidity add,
// which moves both vaults the same way, is not a trade. The launch transaction (no vault balance before it) falls back to the fee payer's own change.
import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import type { TokenBalance } from "@solana/web3.js";
import { config } from "../src/config";
import { tradeFromTx, type TradeTx } from "../src/dbc/trade";

const key = () => Keypair.generate().publicKey.toBase58();
const coin = { mint: key(), poolId: key(), dammPool: null as string | null };
const vaults = { base: key(), quote: key() };
const payer = key();
const router = key();
const QUOTE = config.solana.dbc.quoteMint.toBase58();

const bal = (accountIndex: number, mint: string, owner: string, amount: bigint): TokenBalance => ({
  accountIndex, mint, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: "0" },
});
/** keys: payer, pool, base vault, quote vault, then whatever else. */
const tx = (pre: TokenBalance[], post: TokenBalance[], keys = [payer, coin.poolId, vaults.base, vaults.quote, router]): TradeTx => ({ keys, preTokenBalances: pre, postTokenBalances: post, blockTime: 1_791_000_000 });

describe("tradeFromTx reads the pool's vaults", () => {
  test("a routed buy: ZEC into the quote vault, tokens out of the base vault, the payer's own balances unchanged", () => {
    const t = tx(
      [bal(2, coin.mint, coin.poolId, 1_000_000n), bal(3, QUOTE, coin.poolId, 500n), bal(4, coin.mint, router, 0n)],
      [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n), bal(4, coin.mint, router, 100_000n)],
    );
    const row = tradeFromTx(coin, "s1", t, vaults);
    expect(row).toMatchObject({ sig: "s1", mint: coin.mint, side: "buy", wallet: payer, amountToken: "100000", amountZec: "200", at: "2026-10-03T04:00:00.000Z" });
  });

  test("a sell: tokens into the base vault, ZEC out of the quote vault", () => {
    const t = tx(
      [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n)],
      [bal(2, coin.mint, coin.poolId, 950_000n), bal(3, QUOTE, coin.poolId, 610n)],
    );
    expect(tradeFromTx(coin, "s2", t, vaults)).toMatchObject({ side: "sell", amountToken: "50000", amountZec: "90" });
  });

  test("both vaults up (liquidity added) or both down (removed) is not a trade, even when the payer's token balance fell", () => {
    const add = tx(
      [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n), bal(4, coin.mint, payer, 50_000n)],
      [bal(2, coin.mint, coin.poolId, 950_000n), bal(3, QUOTE, coin.poolId, 800n), bal(4, coin.mint, payer, 0n)],
    );
    expect(() => tradeFromTx(coin, "s3", add, vaults)).toThrow("not_a_trade");
    const remove = tx([bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n)], [bal(2, coin.mint, coin.poolId, 800_000n), bal(3, QUOTE, coin.poolId, 600n)]);
    expect(() => tradeFromTx(coin, "s4", remove, vaults)).toThrow("not_a_trade");
  });

  test("a transaction that names the pool but moves neither vault is not a trade", () => {
    const t = tx([bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n)], [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n)]);
    expect(() => tradeFromTx(coin, "s5", t, vaults)).toThrow("not_a_trade");
  });

  test("the launch transaction (no base-vault balance before it) falls back to the launcher's own change: the first buy", () => {
    const t = tx(
      [bal(5, QUOTE, payer, 10_000n)],
      [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 1_000n), bal(5, QUOTE, payer, 9_000n), bal(6, coin.mint, payer, 100_000n)],
      [payer, coin.poolId, vaults.base, vaults.quote, router, key(), key()],
    );
    expect(tradeFromTx(coin, "s6", t, vaults)).toMatchObject({ side: "buy", wallet: payer, amountToken: "100000", amountZec: "1000" });
  });

  test("a launch with no first buy (the launcher's token balance did not move) is not a trade", () => {
    const t = tx([], [bal(2, coin.mint, coin.poolId, 1_000_000n), bal(3, QUOTE, coin.poolId, 0n)]);
    expect(() => tradeFromTx(coin, "s7", t, vaults)).toThrow("not_a_trade");
  });

  test("a transaction that names the pool but not its vaults is not a trade, even when the payer's own coin and ZEC balances moved (the forged-trade shape)", () => {
    // Before 2026-10-12 this fell through to the launch fallback and became a buy of 100,000 for 1,000 zats: any wallet could fill the tape and the chart.
    const other = key();
    const t = tx(
      [bal(2, coin.mint, other, 100_000n), bal(3, QUOTE, payer, 10_000n), bal(4, coin.mint, payer, 0n)],
      [bal(2, coin.mint, other, 0n), bal(3, QUOTE, payer, 9_000n), bal(4, coin.mint, payer, 100_000n)],
      [payer, coin.poolId, key(), key(), other],
    );
    expect(() => tradeFromTx(coin, "s11", t, vaults)).toThrow("not_a_trade");
    const oneVault = tx([bal(4, coin.mint, payer, 0n)], [bal(4, coin.mint, payer, 100_000n)], [payer, coin.poolId, vaults.base, key(), other]);
    expect(() => tradeFromTx(coin, "s12", oneVault, vaults)).toThrow("not_a_trade");
  });

  test("a transaction that names an existing base vault without moving it is not a trade, even when the payer's coin balance moved", () => {
    // The vault exists, so it has a balance before the transaction; the launch fallback is only for the transaction that creates it.
    const t = tx(
      [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n), bal(4, coin.mint, payer, 0n)],
      [bal(2, coin.mint, coin.poolId, 900_000n), bal(3, QUOTE, coin.poolId, 700n), bal(4, coin.mint, payer, 100_000n)],
    );
    expect(() => tradeFromTx(coin, "s13", t, vaults)).toThrow("not_a_trade");
    // Vaults named but with no balance entry before or after (never created in this transaction): not the launch either.
    const bare = tx([bal(4, coin.mint, payer, 0n)], [bal(4, coin.mint, payer, 100_000n)]);
    expect(() => tradeFromTx(coin, "s14", bare, vaults)).toThrow("not_a_trade");
  });

  test("a transaction that does not name the coin's pool (or its DAMM pool) is not a trade", () => {
    const t = tx([bal(2, coin.mint, coin.poolId, 1n)], [bal(2, coin.mint, coin.poolId, 0n)], [payer, key(), vaults.base, vaults.quote]);
    expect(() => tradeFromTx(coin, "s8", t, vaults)).toThrow("not_a_trade");
  });

  test("after graduation the DAMM pool's address counts, with the DAMM vaults", () => {
    const graduated = { ...coin, dammPool: key() };
    const damm = { base: key(), quote: key() };
    const t = tx(
      [bal(2, coin.mint, graduated.dammPool!, 1_000n), bal(3, QUOTE, graduated.dammPool!, 1_000n)],
      [bal(2, coin.mint, graduated.dammPool!, 900n), bal(3, QUOTE, graduated.dammPool!, 1_200n)],
      [payer, graduated.dammPool!, damm.base, damm.quote],
    );
    expect(tradeFromTx(graduated, "s9", t, damm)).toMatchObject({ side: "buy", amountToken: "100", amountZec: "200" });
  });

  test("a missing block time dates the trade now, not at 1970", () => {
    const t = { ...tx([bal(2, coin.mint, coin.poolId, 10n), bal(3, QUOTE, coin.poolId, 0n)], [bal(2, coin.mint, coin.poolId, 5n), bal(3, QUOTE, coin.poolId, 10n)]), blockTime: null };
    expect(Date.parse(tradeFromTx(coin, "s10", t, vaults).at)).toBeGreaterThan(Date.now() - 60_000);
  });
});
