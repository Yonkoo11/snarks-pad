// GET /api/rewards/:wallet and POST /api/rewards/verify-memo docs/API.md v2.6, and the shielded part of a wallet's rewards that v2.9 moved behind
// its signature (POST /api/optin/status). Built from the rows the keeper writes (an epoch, its payouts, its per-wallet shares, its published snapshot), so the
// privacy rules are checked against the real snapshot code: a public answer holds only Solana-rail payouts, never anything about the shielded rail (not
// even whether the wallet opted in), a shielded amount, a salt, a Zcash address or a transaction id; a wallet's own rows come only with its signed proof;
// nothing here answers 500. No chain needed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import * as db from "../src/db";
import { buildSnapshot, rowCommitment, rowSalt, serializeSnapshot, snapshotSha256, type Snapshot } from "../src/epoch/snapshotFile";
import { epochReceiptMessage, shieldedViewMessage } from "../src/optin/message";
import { checkMemo, MEMO_MAX_BYTES } from "../src/rewards";
import { rewardMemo } from "../src/zcash/devtool";

const B = "http://pad.test/api";
// Everything that can reach a response text is derived from counters, never from the clock or the OS: the answer a Solana-rail wallet gets is checked for that
// wallet's amount (`not.toContain("500")` below), and any random hex in it (an epoch id, a transaction id, the snapshot's digest, which depends on the wallets and
// the salt) held "500" by chance in roughly one run in thirty. With fixed inputs the answer is the same text on every run, so the check is a fact, not a draw.
let counter = 0;
const derived = (label: string) => createHash("sha256").update(`rewards.test ${label} ${counter++}`).digest();
const key = () => Keypair.fromSeed(derived("wallet"));
const pub = (k: Keypair) => k.publicKey.toBase58();
const ZADDR = "uregtest1thisisarecognisableunifiedaddressforrewardstests0123456789abcdefghijklmnopqrstuv";
const run = "rewardstest";
const SALT_SECRET = "rewards.test fixed salt secret, so the published snapshots have the same digest on every run";
let saltBefore: string | null = null;
beforeAll(() => {
  saltBefore = db.getMeta("snapshot_salt_secret");
  db.setMeta("snapshot_salt_secret", SALT_SECRET);
});
const epochIds: string[] = [];
const mints: string[] = [];
const optinWallets: string[] = [];

interface Round {
  id: string;
  mint: string;
  txid: string;
  solana: { w: Keypair; zats: bigint }[];
  shielded: { w: Keypair; zats: bigint }[];
}

let clock = Date.parse("2026-09-01T00:00:00.000Z");

/**
 * An epoch of one coin as the keeper leaves it: shares per wallet, a payout row each (Solana rows with a signature, shielded rows with a
 * 64-hex txid), and the snapshot built and stored by the real snapshot code. `unsent` and `carried` wallets get the rows a skipped payout leaves.
 */
function makeRound(o: { solana?: [Keypair, bigint][]; shielded?: [Keypair, bigint][]; carried?: [Keypair, bigint][]; unsent?: [Keypair, bigint][]; fallback?: [Keypair, bigint][]; draft?: boolean; noSnapshot?: boolean }): Round {
  const id = `epoch-${run}-${epochIds.length}`;
  const mint = key();
  db.upsertCoin({ mint: pub(mint), name: `Rewards ${run}`, symbol: `RW${epochIds.length}`, imageUrl: "", description: "", creator: pub(mint), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
  db.markCoinLaunched(pub(mint), pub(key()));
  mints.push(pub(mint));
  epochIds.push(id);
  const at = new Date((clock += 3_600_000)).toISOString();
  const txid = derived("txid").toString("hex"); // 64 lowercase hex, the shape of a Zcash transaction id, the same on every run
  const solana = (o.solana ?? []).map(([w, zats]) => ({ w, zats }));
  const shielded = (o.shielded ?? []).map(([w, zats]) => ({ w, zats }));
  const all = [...solana, ...shielded, ...(o.carried ?? []).map(([w, zats]) => ({ w, zats })), ...(o.unsent ?? []).map(([w, zats]) => ({ w, zats })), ...(o.fallback ?? []).map(([w, zats]) => ({ w, zats }))];
  const holders = all.reduce((a, r) => a + r.zats, 0n);
  db.upsertEpoch({
    id, at, coinMints: JSON.stringify([pub(mint)]), harvestedZats: (holders * 4n / 3n).toString(), feeZats: "0", status: o.draft ? "harvesting" : "ok",
    swapProvider: null, swapRef: null, swapState: "settled", swapAmountOutZats: null, zcashTxids: JSON.stringify(shielded.length > 0 ? [txid] : []),
  });
  db.recordEpochCoinHarvest(id, pub(mint), holders * 4n / 3n, all.map((r) => ({ wallet: pub(r.w), amount: r.zats, weight: 100n })), undefined, holders / 3n);
  for (const r of solana) { db.planPayout({ epochId: id, wallet: pub(r.w), kind: "solana", amountZats: r.zats.toString() }); db.markPayoutSent(id, pub(r.w), "solana", `solsig-${id}`); }
  for (const r of shielded) { db.planPayout({ epochId: id, wallet: pub(r.w), kind: "shielded", amountZats: r.zats.toString(), zcashAddress: ZADDR }); db.markPayoutSent(id, pub(r.w), "shielded", txid); }
  for (const [w, zats] of o.carried ?? []) { db.planPayout({ epochId: id, wallet: pub(w), kind: "solana", amountZats: zats.toString() }); db.markPayoutSent(id, pub(w), "solana", "carried:new_account_below_rent"); }
  for (const [w, zats] of o.unsent ?? []) db.planPayout({ epochId: id, wallet: pub(w), kind: "solana", amountZats: zats.toString() });
  for (const [w, zats] of o.fallback ?? []) { db.planPayout({ epochId: id, wallet: pub(w), kind: "shielded", amountZats: zats.toString(), zcashAddress: ZADDR }); db.markPayoutSent(id, pub(w), "shielded", `fallback_solana:fallbacksig-${id}`); }
  if (!o.noSnapshot) {
    const shieldedSet = new Set([...shielded, ...(o.fallback ?? []).map(([w, zats]) => ({ w, zats })), ...(o.carried ? [] : [])].map((r) => pub(r.w)));
    const snap = buildSnapshot({
      epochId: id, at, network: "local", teamShareBps: 2500, meteoraShareOfFeeBps: 2000, saltSecret: db.snapshotSaltSecret(), shieldedWallets: shieldedSet,
      coins: [{ mint: pub(mint), claimedZats: holders * 4n / 3n, teamZats: holders / 3n, rows: all.map((r) => ({ wallet: pub(r.w), weight: 100n, shareZats: r.zats })) }],
    });
    const text = serializeSnapshot(snap);
    db.insertEpochSnapshot(id, text, snapshotSha256(text), [...shieldedSet]);
    db.markSnapshotMemoPending(id, "memosig-" + id, "raw", 1);
    db.markSnapshotMemoLanded(id);
  }
  return { id, mint: pub(mint), txid, solana, shielded };
}

afterAll(() => {
  const d = db.getDb();
  if (saltBefore === null) d.query("DELETE FROM meta WHERE key = 'snapshot_salt_secret'").run();
  else db.setMeta("snapshot_salt_secret", saltBefore);
  for (const id of epochIds) for (const table of ["epochs", "payouts", "epoch_coin_shares", "epoch_coin_harvests", "epoch_snapshots"]) d.query(`DELETE FROM ${table} WHERE ${table === "epochs" ? "id" : "epochId"} = $id`).run({ $id: id });
  for (const m of mints) d.query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
  for (const w of optinWallets) d.query("DELETE FROM optins WHERE wallet = $w").run({ $w: w });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(B + path, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
  const text = await res.text();
  expect(res.status).not.toBe(500);
  expect(text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:/);
  return { status: res.status, text, body: JSON.parse(text) as any };
}

const nonceOf = async (w: Keypair) => ((await call("GET", `/optin/nonce?wallet=${pub(w)}`)).body.nonce as string);
const sign = (signer: Keypair, message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey));
const proofFor = async (w: Keypair, epochId: string, signer: Keypair = w) => {
  const nonce = await nonceOf(w);
  return { wallet: pub(w), nonce, signature: sign(signer, epochReceiptMessage(pub(w), epochId, nonce)) };
};
const optIn = (w: Keypair) => { db.upsertOptin(pub(w), ZADDR); optinWallets.push(pub(w)); };
/** What the wallet's own signature opens (v2.9): its shielded delivery and the shielded rounds it was paid in. */
const shieldedOf = async (w: Keypair) => {
  const nonce = await nonceOf(w);
  return call("POST", "/optin/status", { wallet: pub(w), nonce, signature: sign(w, shieldedViewMessage(pub(w), nonce)) });
};

describe("GET /rewards/:wallet", () => {
  test("a Solana-rail wallet: every round it was paid, newest first, with the transaction, what was sent and its share from each coin", async () => {
    const w = key();
    const r1 = makeRound({ solana: [[w, 1_000n], [key(), 500n]] });
    const r2 = makeRound({ solana: [[w, 2_500n]] });
    const r = await call("GET", `/rewards/${pub(w)}`);
    expect(r.status).toBe(200);
    expect(r.body.wallet).toBe(pub(w));
    expect(r.body.solana.count).toBe(2);
    expect(r.body.solana.totalZats).toBe("3500");
    expect(r.body.solana.payouts.map((p: any) => p.epochId)).toEqual([r2.id, r1.id]);
    expect(r.body.solana.payouts[0]).toMatchObject({ sig: `solsig-${r2.id}`, zats: "2500", coins: [{ mint: r2.mint, shareZats: "2500" }] });
    expect(typeof r.body.solana.payouts[0].at).toBe("string");
    expect(Object.keys(r.body).sort()).toEqual(["memoFormat", "solana", "wallet"]); // v2.9: nothing about the shielded rail, not even a flag
    expect(r.body.memoFormat).toBe("SNARKS pad reward, epoch <epochId>");
    expect(r.body.memoFormat.replace("<epochId>", "epoch-9")).toBe(rewardMemo("epoch-9")); // the one text the batch writes
  });

  test("limit and offset page the Solana payouts; count and total always cover all of them", async () => {
    const w = key();
    const rounds = [1n, 2n, 3n].map((z) => makeRound({ solana: [[w, z * 100n]] }));
    const page = await call("GET", `/rewards/${pub(w)}?limit=1&offset=1`);
    expect(page.body.solana.payouts.map((p: any) => p.epochId)).toEqual([rounds[1]!.id]);
    expect(page.body.solana.count).toBe(3);
    expect(page.body.solana.totalZats).toBe("600");
    expect((await call("GET", `/rewards/${pub(w)}?offset=3`)).body.solana.payouts).toEqual([]);
  });

  test("a payout that moved no money (carried, or still unsent) is in no list and in no total", async () => {
    const w = key();
    makeRound({ solana: [[key(), 100n]], carried: [[w, 5_000n]], unsent: [[w, 7_000n]] });
    const r = await call("GET", `/rewards/${pub(w)}`);
    expect(r.body.solana).toEqual({ count: 0, totalZats: "0", payouts: [] });
    expect((await shieldedOf(w)).body.shielded.rounds).toBe(0);
  });

  test("a shielded holder paid on Solana after a failed swap: the public answer does not list that payout (it would show the wallet had opted in); its own signature does, with the real signature (no bookkeeping prefix), apart from its shielded rounds (v2.9)", async () => {
    const w = key();
    const ordinary = key();
    optIn(w);
    const r1 = makeRound({ fallback: [[w, 900n]], solana: [[ordinary, 400n]] });
    // what a stranger sees for the shielded holder is what it sees for a wallet that was never paid: nothing
    const anyone = await call("GET", `/rewards/${pub(w)}`);
    expect(anyone.body.solana).toEqual({ count: 0, totalZats: "0", payouts: [] });
    expect(anyone.text).not.toMatch(/fallback|900/);
    // an ordinary Solana-rail wallet of the same round still sees its payout
    expect((await call("GET", `/rewards/${pub(ordinary)}`)).body.solana.payouts[0]).toMatchObject({ epochId: r1.id, sig: `solsig-${r1.id}`, zats: "400" });
    // the shielded holder's own signature lists it, as a payout on Solana in place of a shielded one: not one of its shielded rounds
    const own = (await shieldedOf(w)).body.shielded;
    expect(own.rounds).toBe(0);
    expect(own.fallback).toMatchObject({ count: 1, totalZats: "900", payouts: [{ epochId: r1.id, sig: `fallbacksig-${r1.id}`, zats: "900" }] });
    expect(JSON.stringify(own)).not.toContain("fallback_solana");
    // a wallet that was only ever on the Solana rail has no such list
    expect((await shieldedOf(ordinary)).body.shielded.fallback).toEqual({ count: 0, totalZats: "0", payouts: [] });
  });

  test("a shielded holder: the public answer says nothing about it; its own signature shows the count of rounds and its salted commitments, found in the published snapshot, and nothing that opens one", async () => {
    const w = key();
    const other = key();
    optIn(w);
    const r1 = makeRound({ shielded: [[w, 123_457n], [other, 777_001n]], solana: [[key(), 400n]] });
    const r = await call("GET", `/rewards/${pub(w)}`);
    expect(r.status).toBe(200);
    expect(r.body.solana.count).toBe(0);
    expect(r.body.shielded).toBeUndefined();
    expect(r.text).not.toMatch(/shielded|optedIn|commitment/i);
    const s = await shieldedOf(w);
    expect(s.status).toBe(200);
    expect(s.body.optedIn).toBe(true);
    expect(s.body.shielded.rounds).toBe(1);
    const round = s.body.shielded.commitments[0];
    expect(round.epochId).toBe(r1.id);
    expect(round.snapshotSha256).toBe(db.getEpochSnapshot(r1.id)!.sha256);
    expect(round.commitments.length).toBe(1); // one coin, one row
    const published = (JSON.parse(db.getEpochSnapshot(r1.id)!.json) as Snapshot).coins[0]!.shielded.commitments;
    expect(published).toContain(round.commitments[0]);
    expect(round.commitments[0]).toBe(rowCommitment(r1.id, r1.mint, rowSalt(db.snapshotSaltSecret(), r1.id, r1.mint, pub(w)), pub(w), 123_457n));
    // what must not be there, in either answer: the amount, the other holder's commitment, the salt, the Zcash address, the batch's transaction id
    for (const answer of [r.text, s.text]) {
      expect(answer).not.toContain("123457");
      expect(answer).not.toContain("777001");
      expect(answer).not.toContain(round.commitments[0] === published[0] ? published[1]! : published[0]!);
      expect(answer).not.toContain(rowSalt(db.snapshotSaltSecret(), r1.id, r1.mint, pub(w)));
      expect(answer).not.toContain(ZADDR);
      expect(answer).not.toContain("uregtest1");
      expect(answer).not.toContain(r1.txid);
      expect(answer).not.toContain(pub(other));
    }
  });

  test("a round without a published snapshot (older than snapshots) is listed with no commitments and no hash", async () => {
    const w = key();
    makeRound({ shielded: [[w, 1_000n]], noSnapshot: true });
    const s = await shieldedOf(w);
    expect(s.body.shielded.rounds).toBe(1);
    expect(s.body.shielded.commitments[0]).toMatchObject({ snapshotSha256: null, commitments: [] });
  });

  test("whether a wallet opted in is shown to its signature alone: the signed read follows the registry, the public answer never has it", async () => {
    const w = key();
    optIn(w);
    expect((await shieldedOf(w)).body).toMatchObject({ optedIn: true, shielded: { rounds: 0, commitments: [] } });
    expect(Object.keys((await call("GET", `/rewards/${pub(w)}`)).body).sort()).toEqual(["memoFormat", "solana", "wallet"]);
    db.deactivateOptin(pub(w));
    expect((await shieldedOf(w)).body.optedIn).toBe(false);
    expect(Object.keys((await call("GET", `/rewards/${pub(w)}`)).body).sort()).toEqual(["memoFormat", "solana", "wallet"]); // the same shape, opted in or not
  });

  test("a wallet nobody paid is 200 with zeros, never a 404", async () => {
    const r = await call("GET", `/rewards/${pub(key())}`);
    expect(r.status).toBe(200);
    expect(r.body.solana).toEqual({ count: 0, totalZats: "0", payouts: [] });
  });

  test("hostile paths and parameters: 400 bad_wallet or bad_request, naming the field, echoing nothing", async () => {
    const real = pub(key());
    for (const bad of ["abc", "0".repeat(44), "verify-memo", "%E0%A4%A", encodeURIComponent("$(id)"), "..%2F..%2Fetc%2Fpasswd", "1".repeat(45), encodeURIComponent("' OR 1=1 --")]) {
      const r = await call("GET", `/rewards/${bad}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_wallet", field: "wallet" });
    }
    for (const [qs, field] of [["limit=0", "limit"], ["limit=201", "limit"], ["limit=-1", "limit"], ["limit=x", "limit"], ["offset=-1", "offset"], ["offset=1.5", "offset"], ["offset=1000001", "offset"], ["limit=1&limit=2", "limit"]]) {
      const r = await call("GET", `/rewards/${real}?${qs}`);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field });
    }
    expect((await call("GET", `/rewards/${real}/extra`)).status).toBe(404);
    expect((await call("DELETE", `/rewards/${real}`)).status).toBe(404);
  });
});

describe("POST /rewards/verify-memo", () => {
  const ask = (body: unknown) => call("POST", "/rewards/verify-memo", body);

  test("a memo that is not the pad's, or names a round that does not exist, is 200 with no round and no match, not an error", async () => {
    for (const memo of ["hello", "SNARKS pad reward", "SNARKS pad reward, epoch ", "snarks pad reward, epoch epoch-1", "SNARKS pad reward, epoch epoch-1 extra", "SNARKS pad reward, epoch ../../x", `SNARKS pad reward, epoch epoch-nope-${run}`, "SNARKS pad reward, epoch " + "a".repeat(65)]) {
      const r = await ask({ memo });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ epochId: null, matches: false, coins: [], round: null, checks: { memo: false, txid: null, commitment: null } });
    }
    expect((await ask({ memo: "hello", txid: "a".repeat(64) })).body.checks).toEqual({ memo: false, txid: false, commitment: null });
  });

  test("the memo of a round that paid a shielded batch: the round's public numbers, nothing about any wallet", async () => {
    const a = key(), b = key();
    const r1 = makeRound({ shielded: [[a, 700_001n], [b, 300_007n]], solana: [[key(), 50n]] });
    const r = await ask({ memo: rewardMemo(r1.id) });
    expect(r.status).toBe(200);
    expect(r.body.epochId).toBe(r1.id);
    expect(r.body.matches).toBe(true);
    expect(r.body.checks).toEqual({ memo: true, txid: null, commitment: null });
    expect(r.body.coins).toEqual([{ mint: r1.mint, symbol: db.getCoin(r1.mint)!.symbol }]);
    expect(r.body.round).toMatchObject({ status: "ok", shielded: { count: 2, totalZats: "1000008" }, zcashTxids: [r1.txid] });
    expect(r.body.round.snapshot).toMatchObject({ sha256: db.getEpochSnapshot(r1.id)!.sha256, memoSig: `memosig-${r1.id}`, url: `/api/epochs/${r1.id}/snapshot` });
    expect(r.body.rows).toBeUndefined();
    for (const secret of [pub(a), pub(b), "700001", "300007", ZADDR]) expect(r.text).not.toContain(secret);
  });

  test("surrounding whitespace is ignored (a paste carries a newline); anything inside is not", async () => {
    const r1 = makeRound({ shielded: [[key(), 1_000n]] });
    expect((await ask({ memo: `  ${rewardMemo(r1.id)}\n` })).body.matches).toBe(true);
    expect((await ask({ memo: rewardMemo(r1.id).replace("reward,", "reward ,") })).body.epochId).toBeNull();
  });

  test("a round that paid no shielded batch is a published round but not a memo the pad wrote: epochId is named, the memo check fails", async () => {
    const r1 = makeRound({ solana: [[key(), 1_000n]] });
    const r = await ask({ memo: rewardMemo(r1.id) });
    expect(r.body.epochId).toBe(r1.id);
    expect(r.body.checks.memo).toBe(false);
    expect(r.body.matches).toBe(false);
    expect(r.body.round.shielded).toEqual({ count: 0, totalZats: "0" });
  });

  test("a draft round (still collecting claims) is not a round yet", async () => {
    const r1 = makeRound({ shielded: [[key(), 1_000n]], draft: true });
    expect((await ask({ memo: rewardMemo(r1.id) })).body.epochId).toBeNull();
  });

  test("txid: the right one of the batch matches; a wrong one fails the whole check; uppercase is accepted; a malformed one is 400 bad_request txid", async () => {
    const r1 = makeRound({ shielded: [[key(), 1_000n]] });
    const memo = rewardMemo(r1.id);
    expect((await ask({ memo, txid: r1.txid })).body).toMatchObject({ matches: true, checks: { memo: true, txid: true } });
    expect((await ask({ memo, txid: r1.txid.toUpperCase() })).body.matches).toBe(true);
    const wrong = await ask({ memo, txid: "f".repeat(64) });
    expect(wrong.body).toMatchObject({ matches: false, checks: { memo: true, txid: false } });
    for (const bad of ["abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), 5, {}, [], true]) {
      const r = await ask({ memo, txid: bad });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field: "txid" });
    }
  });

  test("a signed proof from the shielded wallet opens ITS rows (mint, share, commitment), says each is in the published file, and spends the nonce", async () => {
    const mine = key(), theirs = key();
    optIn(mine);
    const r1 = makeRound({ shielded: [[mine, 123_457n], [theirs, 777_001n]] });
    const memo = rewardMemo(r1.id);
    const proof = await proofFor(mine, r1.id);
    const r = await ask({ memo, ...proof });
    expect(r.status).toBe(200);
    expect(r.body.matches).toBe(true);
    expect(r.body.checks).toEqual({ memo: true, txid: null, commitment: true });
    expect(r.body.rows).toEqual([{ mint: r1.mint, shareZats: "123457", commitment: rowCommitment(r1.id, r1.mint, rowSalt(db.snapshotSaltSecret(), r1.id, r1.mint, pub(mine)), pub(mine), 123_457n) }]);
    for (const secret of ["777001", pub(theirs), ZADDR, rowSalt(db.snapshotSaltSecret(), r1.id, r1.mint, pub(mine))]) expect(r.text).not.toContain(secret);
    const replay = await ask({ memo, ...proof });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: "stale_nonce" });
  });

  test("a proof that is not the wallet's (signed by someone else, or for another round) is 400 invalid_signature, and burns no nonce", async () => {
    const mine = key(), thief = key();
    const r1 = makeRound({ shielded: [[mine, 1_000n]] });
    const r2 = makeRound({ shielded: [[mine, 2_000n]] });
    const nonce = await nonceOf(mine);
    const forged = { wallet: pub(mine), nonce, signature: sign(thief, epochReceiptMessage(pub(mine), r1.id, nonce)) };
    expect((await ask({ memo: rewardMemo(r1.id), ...forged })).body).toEqual({ error: "invalid_signature" });
    const otherRound = { wallet: pub(mine), nonce, signature: sign(mine, epochReceiptMessage(pub(mine), r2.id, nonce)) };
    expect((await ask({ memo: rewardMemo(r1.id), ...otherRound })).body).toEqual({ error: "invalid_signature" });
    const good = { wallet: pub(mine), nonce, signature: sign(mine, epochReceiptMessage(pub(mine), r1.id, nonce)) };
    expect((await ask({ memo: rewardMemo(r1.id), ...good })).body.matches).toBe(true); // the nonce was still there
  });

  test("a wallet that was paid on the Solana rail proves ownership and gets no rows and no match: its row is not in the commitments", async () => {
    const solanaHolder = key();
    const r1 = makeRound({ shielded: [[key(), 1_000n]], solana: [[solanaHolder, 500n]] });
    const r = await ask({ memo: rewardMemo(r1.id), ...(await proofFor(solanaHolder, r1.id)) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ matches: false, checks: { memo: true, commitment: false }, rows: [] });
    expect(r.text).not.toContain("500");
  });

  test("a proof for a memo that is not the pad's is not even checked: no row, no nonce spent", async () => {
    const w = key();
    const nonce = await nonceOf(w);
    const r = await ask({ memo: "hello", wallet: pub(w), nonce, signature: sign(w, "anything") });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ epochId: null, matches: false, checks: { commitment: false } });
    expect(r.body.rows).toBeUndefined();
  });

  test("a half-sent proof is refused naming the missing part", async () => {
    const w = key();
    const r1 = makeRound({ shielded: [[w, 1_000n]] });
    const memo = rewardMemo(r1.id);
    expect((await ask({ memo, wallet: pub(w) })).body).toEqual({ error: "bad_request", field: "nonce" });
    expect((await ask({ memo, wallet: pub(w), nonce: "n1" })).body).toEqual({ error: "invalid_signature", field: "signature" });
    expect((await ask({ memo, nonce: "n1", signature: "x" })).body).toEqual({ error: "bad_wallet", field: "wallet" });
    expect((await ask({ memo, wallet: "nope", nonce: "n1", signature: "x" })).body).toEqual({ error: "bad_wallet", field: "wallet" });
  });

  test("hostile memos and bodies: 400 bad_request field memo, or bad_json, or 413; never a 500, never an echo", async () => {
    const multibyte = "€".repeat(200); // 200 characters, 600 bytes
    for (const memo of [undefined, null, 5, true, {}, [], "", "   ", "a\u0000b", "SNARKS pad reward, epoch x\ny", "x".repeat(MEMO_MAX_BYTES + 1), multibyte]) {
      const r = await ask({ memo });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "bad_request", field: "memo" });
    }
    for (const bad of ["{bad", "", "[1]", "null", '"s"', "42"]) {
      const r = await ask(bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_json");
    }
    const huge = await ask({ memo: "x".repeat(50_000) });
    expect(huge.status).toBe(413);
    const proto = await ask({ memo: "hello", __proto__: { memo: "x" }, constructor: 1 });
    expect(proto.status).toBe(200);
    expect((await call("GET", "/rewards/verify-memo")).status).toBe(400); // a GET names a wallet called verify-memo, which is not one
  });

  test("a memo of exactly the longest size is checked, not refused (a Zcash memo field is 512 bytes)", async () => {
    const r = await ask({ memo: "x".repeat(MEMO_MAX_BYTES) });
    expect(r.status).toBe(200);
    expect(r.body.epochId).toBeNull();
  });

  test("checkMemo can be called without HTTP: same answers, and its result never carries more than the contract's keys", () => {
    const res = checkMemo({ memo: "hello", txid: null, proof: null });
    expect(res.ok).toBe(true);
    if (res.ok) expect(Object.keys(res.check).sort()).toEqual(["checks", "coins", "epochId", "matches", "round"]);
  });
});
