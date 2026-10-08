#!/usr/bin/env bun
// A fake NEAR 1Click server for the chaos runs (audit/STRESS-REPORT.md scenario 3), so the REAL near1click adapter
// (quote checks, signed deposit, crash-safe phases, refund detection) runs against faults a live 1Click can produce.
// Quotes are signed with a throwaway key (test/helpers/fake-1click.ts); the deposit lands on the local validator in
// an address this server holds; settlement is a real regtest Zcash payment from the funding wallet into the treasury
// (same output as the simulated adapter: 25 bps spread + 32,000 zats), so the stress check's arithmetic is unchanged.
//   bun stress/fake-1click-server.ts [port=18950]
//   GET /__mode?m=<success|status5xx|quote5xx|noquote|refunded|slow>&n=<calls failing>&slowMs=<ms>
//   GET /__signer -> the quote signer to trust; GET /__state -> what happened per deposit address
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Fake1Click } from "../test/helpers/fake-1click";
import { config } from "../src/config";
import { payBatch, syncWallet, defaultUnifiedAddress } from "../src/zcash/devtool";
import { FUNDING_DIR, FUNDING_IDENTITY, TREASURY_DIR, mineBlocks, syncToTip } from "../src/zcash/regtest";
import { quoteSimulatedOut } from "../src/swap/simulated";
import { ZEC, airdrop, direct, send } from "./lib";

const port = Number(process.argv[2] ?? 18950);
const fake = new Fake1Click();
fake.unscripted = "PENDING_DEPOSIT";
let mode = { m: "success", n: 0, slowMs: 0 };
let failed = 0;
interface Deposit { kp: Keypair; amountIn: bigint; refundTo: string; seenAt?: number; txid?: string; refundSig?: string }
const deposits = new Map<string, Deposit>();

fake.beforeSign = (q) => {
  const kp = Keypair.generate();
  q.quote.depositAddress = kp.publicKey.toBase58();
  deposits.set(kp.publicKey.toBase58(), { kp, amountIn: BigInt(q.quote.amountIn), refundTo: q.quoteRequest.refundTo });
};

async function depositBalance(addr: string): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(ZEC, new PublicKey(addr), true, TOKEN_PROGRAM_ID);
  try {
    return BigInt((await direct.getTokenAccountBalance(ata, "confirmed")).value.amount);
  } catch {
    return 0n;
  }
}

/** Decides the scripted status for a deposit address from what is really on chain, acting (pay / refund) once. */
async function drive(addr: string): Promise<void> {
  const d = deposits.get(addr);
  if (!d) return;
  if (!d.seenAt) {
    if ((await depositBalance(addr)) < d.amountIn) return; // PENDING_DEPOSIT
    d.seenAt = Date.now();
  }
  if (mode.m === "refunded") {
    if (!d.refundSig) {
      await airdrop(d.kp.publicKey, 0.05);
      const src = getAssociatedTokenAddressSync(ZEC, d.kp.publicKey, true, TOKEN_PROGRAM_ID);
      const dst = getAssociatedTokenAddressSync(ZEC, new PublicKey(d.refundTo), true, TOKEN_PROGRAM_ID);
      d.refundSig = await send(new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(d.kp.publicKey, dst, new PublicKey(d.refundTo), ZEC, TOKEN_PROGRAM_ID),
        createTransferCheckedInstruction(src, ZEC, dst, d.kp.publicKey, d.amountIn, config.solana.dbc.quoteDecimals, [], TOKEN_PROGRAM_ID),
      ), [d.kp]);
    }
    fake.script(addr, { status: "REFUNDED", swapDetails: { refundedAmount: d.amountIn.toString(), refundReason: "injected" } });
    return;
  }
  if (mode.m === "slow" && Date.now() - d.seenAt < mode.slowMs) {
    fake.script(addr, { status: "PROCESSING" });
    return;
  }
  if (!d.txid) {
    syncWallet(FUNDING_DIR);
    d.txid = payBatch(FUNDING_DIR, FUNDING_IDENTITY, [{ address: defaultUnifiedAddress(TREASURY_DIR), zats: quoteSimulatedOut(d.amountIn) }]);
    await mineBlocks(10);
    await syncToTip(TREASURY_DIR);
  }
  fake.script(addr, { status: "SUCCESS", swapDetails: { amountOut: quoteSimulatedOut(d.amountIn).toString(), destinationChainTxHashes: [{ hash: d.txid }] } });
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__mode") {
      mode = { m: url.searchParams.get("m") ?? "success", n: Number(url.searchParams.get("n") ?? 0), slowMs: Number(url.searchParams.get("slowMs") ?? 0) };
      failed = 0;
      return Response.json({ ok: true, mode });
    }
    if (url.pathname === "/__signer") return Response.json({ signer: fake.signer });
    if (url.pathname === "/__state") {
      return Response.json([...deposits].map(([a, d]) => ({ a, amountIn: d.amountIn.toString(), seen: !!d.seenAt, txid: d.txid ?? null, refundSig: d.refundSig ?? null })));
    }
    const isQuote = url.pathname.endsWith("/quote");
    const isStatus = url.pathname.endsWith("/status");
    if (isQuote && mode.m === "noquote") return Response.json({ message: "Failed to get quote" }, { status: 400 });
    if ((isQuote && mode.m === "quote5xx") || (isStatus && mode.m === "status5xx")) {
      if (failed++ < mode.n) return new Response("injected 5xx", { status: 503 });
    }
    if (isStatus) await drive(url.searchParams.get("depositAddress") ?? "");
    const body = req.method === "POST" ? await req.text() : undefined;
    return fake.fetch(url.toString(), { method: req.method, body });
  },
});
console.log(`fake 1Click on :${port}, signer ${fake.signer}`);
