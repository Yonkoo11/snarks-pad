// Fixes verified defect (review finding 3): getAssociatedTokenAddressSync
// throws for an off-curve (PDA) owner, which used to crash the whole batch
// build for one bad recipient. Pure/local (PDA derivation only) -- no chain
// needed. (The Raydium-only "pool vault exclusion" tests that lived here were
// deleted with the module they tested; test/holders.test.ts covers exclusion.)
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { resolveDestinations } from "../src/epoch/solanaPayout";

const QUOTE_MINT = new PublicKey("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS"); // mainnet Solana-ZEC mint (matches config.ts)

describe("resolveDestinations (finding 3)", () => {
  test("a normal on-curve wallet resolves via the standard ATA, and is never skipped", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const { resolved, skipped } = resolveDestinations(QUOTE_MINT, [{ wallet, amount: 100n }]);

    expect(skipped).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.ata.toBase58()).toBe(getAssociatedTokenAddressSync(QUOTE_MINT, new PublicKey(wallet), false, TOKEN_PROGRAM_ID).toBase58());
  });

  test("an off-curve owner (a PDA) does not crash resolution and does not halt the batch: it still gets a valid destination", () => {
    // A PDA that is provably off the ed25519 curve.
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("some-seed")], new PublicKey("11111111111111111111111111111111"));
    expect(PublicKey.isOnCurve(pda.toBytes())).toBe(false);

    // The strict derivation must reject it (this is exactly what used to throw and crash the batch).
    expect(() => getAssociatedTokenAddressSync(QUOTE_MINT, pda, false, TOKEN_PROGRAM_ID)).toThrow();

    const { resolved, skipped } = resolveDestinations(QUOTE_MINT, [{ wallet: pda.toBase58(), amount: 250n }]);

    expect(skipped).toEqual([]); // never diverted to carry just for being a PDA
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.ata.toBase58()).toBe(getAssociatedTokenAddressSync(QUOTE_MINT, pda, true, TOKEN_PROGRAM_ID).toBase58());
  });

  test("a malformed wallet string is diverted to `skipped` with a reason, and never halts the rest of the batch", () => {
    const good = Keypair.generate().publicKey.toBase58();
    const { resolved, skipped } = resolveDestinations(QUOTE_MINT, [
      { wallet: "not-a-real-pubkey", amount: 999n },
      { wallet: good, amount: 1n },
    ]);

    expect(skipped).toEqual([{ wallet: "not-a-real-pubkey", amount: 999n, reason: "invalid_wallet_pubkey" }]);
    expect(resolved.map((r) => r.wallet)).toEqual([good]); // the rest of the batch proceeds normally
  });

  test("one bad recipient among several never halts resolution of the others", () => {
    const wallets = [Keypair.generate().publicKey.toBase58(), "garbage", Keypair.generate().publicKey.toBase58()];
    const { resolved, skipped } = resolveDestinations(QUOTE_MINT, wallets.map((wallet) => ({ wallet, amount: 5n })));

    expect(resolved).toHaveLength(2);
    expect(skipped).toHaveLength(1);
  });
});
