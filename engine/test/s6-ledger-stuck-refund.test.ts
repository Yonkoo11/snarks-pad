// Audit S6, three small money-side fixes:
//   lens 2-4  orphaned proceeds (claimed for a coin with no eligible holder, held in the keeper account) were missing from the
//             keeper-owed sum behind the isolation gate and from the public record (claimed on chain showed more than harvested).
//   lens 3-3  the stuck age counted from the draft, so a round the owner approved a day later was parked on its first paying run.
//   lens 4-3  the refund search read one page of 100 signatures: a hundred dust transfers into the keeper account hid a refund.
import { describe, expect, test } from "bun:test";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { config } from "../src/config";
import * as db from "../src/db";
import { stuckReason } from "../src/epoch/stuck";
import { REFUND_SEARCH_PAGE, makeSolanaDepositChain } from "../src/swap/near1click-chain";

const w = () => Keypair.generate().publicKey.toBase58();

describe("lens 2-4: orphaned proceeds are owed from the keeper and visible in the record", () => {
  test("sumOwedFromKeeper counts the orphaned bucket; the epochs route shows what the claims measured", async () => {
    const mint = w();
    const before = db.sumOwedFromKeeper();
    db.setOrphanedCoinProceeds(mint, 31_840n); // $SNKTEST on 2026-10-07: claimed, nobody eligible
    expect(db.sumOwedFromKeeper() - before).toBe(31_840n);
    expect(db.sumOrphanedZats() >= 31_840n).toBe(true);

    const id = `epoch-orph-${crypto.randomUUID()}`;
    db.upsertEpoch({ id, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "241690", feeZats: "0", status: "ok", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
    const paid = w();
    db.recordClaimSigned({ epochId: id, mint: paid, kind: "trading", sig: "s1-" + id, rawTx: "AA==", lastValidBlockHeight: 1, phase: "single" });
    db.recordClaimConfirmed(id, paid, "trading", 241_690n);
    db.recordClaimSigned({ epochId: id, mint, kind: "trading", sig: "s2-" + id, rawTx: "AA==", lastValidBlockHeight: 1, phase: "single" });
    db.recordClaimConfirmed(id, mint, "trading", 31_840n);
    expect(db.sumConfirmedClaims(id)).toBe(273_530n);
    const { handleRequest } = await import("../src/api");
    const body = (await (await handleRequest(new Request("http://api.test/api/epochs"))).json()) as { epochs?: unknown[] } | unknown[];
    const list = (Array.isArray(body) ? body : (body as { epochs: { id: string; harvestedZats: string; claimedZats: string }[] }).epochs) as { id: string; harvestedZats: string; claimedZats: string }[];
    const row = list.find((e) => e.id === id);
    expect(row).toMatchObject({ harvestedZats: "241690", claimedZats: "273530" }); // 273,530 claimed = 241,690 harvested + 31,840 orphaned
    db.setOrphanedCoinProceeds(mint, 0n);
    db.getDb().query("DELETE FROM claim_progress WHERE epochId = $e").run({ $e: id });
    db.getDb().query("DELETE FROM epochs WHERE id = $e").run({ $e: id });
  });
});

describe("lens 3-3: the stuck age counts from the first unfinished run, not from the draft", () => {
  const row = (at: string, unfinishedSince: string | null): db.EpochRow => ({
    id: "e", at, coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "partial", swapProvider: null, swapRef: null, swapState: "submitted", swapAmountOutZats: null, zcashTxids: "[]",
    attempts: 1, unfinishedSince,
  });
  test("a draft approved a day after it opened is not stuck on its first paying run; it is once it has been unfinished for the limit", () => {
    const now = Date.parse("2026-10-09T13:10:00Z");
    const draftAt = new Date(now - 36 * 3_600_000).toISOString(); // opened a day and a half ago, waiting for the owner
    const firstRun = new Date(now - 60_000).toISOString(); // the legs started a minute ago
    expect(stuckReason(row(draftAt, firstRun), now)).toBeNull();
    expect(stuckReason(row(draftAt, new Date(now - config.epoch.stuckMaxAgeMs).toISOString()), now)).toMatch(/unfinished for/);
    expect(stuckReason(row(draftAt, null), now)).toMatch(/unfinished for/); // a row from before the column: the old rule
  });
  test("bumpEpochAttempts stamps the first unfinished run once", () => {
    const id = `epoch-since-${crypto.randomUUID()}`;
    db.upsertEpoch({ id, at: new Date(Date.now() - 3_600_000).toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "partial", swapProvider: null, swapRef: null, swapState: "none", swapAmountOutZats: null, zcashTxids: "[]" });
    db.bumpEpochAttempts(id);
    const first = db.getEpoch(id)!.unfinishedSince;
    expect(first && Date.now() - Date.parse(first) < 10_000).toBe(true);
    db.bumpEpochAttempts(id);
    expect(db.getEpoch(id)!.unfinishedSince).toBe(first);
    db.getDb().query("DELETE FROM epochs WHERE id = $e").run({ $e: id });
  });
});

describe("lens 4-3: the refund search pages back to the deposit", () => {
  const keeper = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const keeperAta = getAssociatedTokenAddressSync(mint, keeper.publicKey, false, TOKEN_PROGRAM_ID);
  const DEPOSIT = "deposit-sig";
  const REFUND = 230_081n;

  /** A transfer into the keeper account by someone else, as getTransaction returns it. */
  function transferTx(amount: bigint) {
    const payer = Keypair.generate().publicKey;
    const ix = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: keeperAta, isSigner: false, isWritable: true }], data: Buffer.alloc(1) });
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
    const idx = message.staticAccountKeys.findIndex((k) => k.equals(keeperAta));
    return { transaction: { message }, meta: { loadedAddresses: undefined, preTokenBalances: [{ accountIndex: idx, uiTokenAmount: { amount: "1000" } }], postTokenBalances: [{ accountIndex: idx, uiTokenAmount: { amount: (1000n + amount).toString() } }] } };
  }

  /** `dust` transfers newer than the refund, then the refund, then the deposit; pages served newest first with until/before like the RPC. */
  function chainWith(dust: number) {
    const history = [...Array.from({ length: dust }, (_, i) => ({ signature: `dust-${i}`, amount: 1n })), { signature: "refund-sig", amount: REFUND }];
    const txs = new Map(history.map((h) => [h.signature, transferTx(h.amount)]));
    const calls: number[] = [];
    const stub = {
      async getSignaturesForAddress(_addr: PublicKey, opts: { before?: string; until?: string; limit?: number }) {
        expect(opts.until).toBe(DEPOSIT);
        const start = opts.before ? history.findIndex((h) => h.signature === opts.before) + 1 : 0;
        const page = history.slice(start, start + (opts.limit ?? 100));
        calls.push(page.length);
        return page.map((h) => ({ signature: h.signature, err: null }));
      },
      async getTransaction(sig: string) {
        return txs.get(sig) ?? null;
      },
    };
    return { chain: makeSolanaDepositChain({ keeper, mint, priorityMicroLamports: 0, connection: stub as unknown as Connection }), calls };
  }

  test("a refund buried under 250 dust transfers is still found (three pages)", async () => {
    const { chain, calls } = chainWith(250);
    expect(await chain.findIncomingTransfer(DEPOSIT, REFUND)).toBe("refund-sig");
    expect(calls).toEqual([REFUND_SEARCH_PAGE, REFUND_SEARCH_PAGE, 51]);
  });
  test("no refund: the search stops at the deposit (a short last page) and answers null", async () => {
    const { chain } = chainWith(5);
    expect(await chain.findIncomingTransfer(DEPOSIT, REFUND + 1n)).toBeNull();
  });
});
