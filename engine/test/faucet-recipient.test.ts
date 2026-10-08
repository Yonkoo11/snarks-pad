// Found on the live devnet server 2026-10-03: POST /faucet for an address that cannot receive (the system program,
// an off-curve PDA) sent or tried to send the 0.1 SOL first, then failed with a 500, and the failure deleted the
// cooldown row, so the same request could be repeated to drain the faucet. Such recipients are refused up front,
// nothing is sent, and no cooldown row is left behind for them.
import { afterEach, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as db from "../src/db";
import { faucetFund } from "../src/faucet";
import { getConnection } from "../src/solana";

const conn = getConnection();
const realInfo = conn.getAccountInfo.bind(conn);
const realBalance = conn.getBalance.bind(conn);
afterEach(() => {
  conn.getAccountInfo = realInfo;
  conn.getBalance = realBalance;
});
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { code?: string }) => e.code ?? e.message);
const claims = (w: string) => (db.getDb().query("SELECT COUNT(*) AS n FROM faucet_claims WHERE wallet = $w").get({ $w: w }) as { n: number }).n;

describe("faucet recipients that cannot receive", () => {
  test("an off-curve address (PDA) is refused as bad_wallet before any RPC call", async () => {
    const pda = PublicKey.findProgramAddressSync([Buffer.from("not-a-wallet")], SystemProgram.programId)[0].toBase58();
    let rpcCalls = 0;
    conn.getAccountInfo = (async () => { rpcCalls++; return null; }) as unknown as typeof conn.getAccountInfo;
    conn.getBalance = (async () => { rpcCalls++; return 0; }) as unknown as typeof conn.getBalance;
    expect(await codeOf(faucetFund(pda))).toBe("bad_wallet");
    expect(rpcCalls).toBe(0);
    expect(claims(pda)).toBe(0);
  });

  test("a program account (the system program itself) is refused as bad_wallet; nothing is sent", async () => {
    const sys = SystemProgram.programId.toBase58();
    let balanceReads = 0;
    conn.getAccountInfo = (async () => ({ executable: true, owner: new PublicKey("NativeLoader1111111111111111111111111111111"), lamports: 1, data: Buffer.alloc(0) })) as unknown as typeof conn.getAccountInfo;
    conn.getBalance = (async () => { balanceReads++; return 10e9; }) as unknown as typeof conn.getBalance;
    expect(await codeOf(faucetFund(sys))).toBe("bad_wallet");
    expect(balanceReads).toBe(0); // fundTestWallet never started
    expect(claims(sys)).toBe(0);
  });

  test("an account owned by another program (a token account, say) is refused as bad_wallet", async () => {
    const w = Keypair.generate().publicKey.toBase58();
    conn.getAccountInfo = (async () => ({ executable: false, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), lamports: 1, data: Buffer.alloc(165) })) as unknown as typeof conn.getAccountInfo;
    expect(await codeOf(faucetFund(w))).toBe("bad_wallet");
    expect(claims(w)).toBe(0);
  });
});
