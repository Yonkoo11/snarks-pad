// The per-epoch snapshot: what is published, what is hidden, that its sha256 reaches Solana in a memo the keeper
// signs, that a failing memo never stops payouts, and that the verify script's arithmetic catches a doctored file.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { claimRemainingCoins, runEpoch, type ClaimDeps } from "../src/epoch/engine";
import { buildSnapshot, rowCommitment, rowSalt, serializeSnapshot, snapshotMemoText, snapshotSha256, type Snapshot } from "../src/epoch/snapshotFile";
import { buildMemoTransaction, ensureSnapshotMemo } from "../src/epoch/snapshotMemo";
import { loadKeeperKeypair } from "../src/keeper";
import { epochReceiptMessage } from "../src/optin/message";
import { getConnection } from "../src/solana";
import type { SwapAdapter } from "../src/swap/types";
import { arithmeticProblems, commitment, type Snapshot as VerifierSnapshot } from "../scripts/verify-snapshot";

const SECRET = "test-secret-not-a-real-one";
const input = {
  epochId: "epoch-1", at: "2026-10-02T00:00:00.000Z", network: "local", teamShareBps: 2500, meteoraShareOfFeeBps: 2000, saltSecret: SECRET,
  coins: [{
    mint: "MintA", claimedZats: 1_000_000n, teamZats: 250_000n,
    rows: [
      { wallet: "Sol1", weight: 100n, shareZats: 250_000n },
      { wallet: "Sol2", weight: 300n, shareZats: 250_000n + 250_000n }, // weights deliberately not proportional here: arithmetic is checked separately
      { wallet: "Shd1", weight: 100n, shareZats: 125_000n },
      { wallet: "Shd2", weight: 100n, shareZats: 125_000n },
    ],
  }],
  shieldedWallets: new Set(["Shd1", "Shd2"]),
};

describe("buildSnapshot: what is published and what is not", () => {
  const snap = buildSnapshot(input);
  const text = serializeSnapshot(snap);

  test("Solana rows are published in full; shielded rows only as a count, a total and one commitment each", () => {
    const c = snap.coins[0]!;
    expect(c.solana.map((r) => r.wallet)).toEqual(["Sol1", "Sol2"]);
    expect(c.shielded.count).toBe(2);
    expect(c.shielded.totalShareZats).toBe("250000");
    expect(c.shielded.commitments.length).toBe(2);
    // The file contains no shielded wallet and no per-recipient shielded amount.
    expect(text).not.toContain("Shd1");
    expect(text).not.toContain("Shd2");
    expect(text).not.toMatch(/"shareZats": "125000"/);
  });

  test("a commitment opens only with its salt, and the salt needs the secret", () => {
    const c = snap.coins[0]!;
    const salt = rowSalt(SECRET, "epoch-1", "MintA", "Shd1");
    expect(c.shielded.commitments).toContain(rowCommitment("epoch-1", "MintA", salt, "Shd1", 125_000n));
    expect(commitment("epoch-1", "MintA", salt, "Shd1", 125_000n)).toBe(rowCommitment("epoch-1", "MintA", salt, "Shd1", 125_000n)); // the standalone verifier agrees
    // Guessing the amount without the secret does not find it: an unsalted guess matches nothing.
    expect(c.shielded.commitments).not.toContain(rowCommitment("epoch-1", "MintA", "", "Shd1", 125_000n));
    expect(c.shielded.commitments).not.toContain(rowCommitment("epoch-1", "MintA", rowSalt("another-secret", "epoch-1", "MintA", "Shd1"), "Shd1", 125_000n));
  });

  test("the bytes are deterministic, so the hash is: same input, same sha256; any change, a different one", () => {
    expect(snapshotSha256(serializeSnapshot(buildSnapshot(input)))).toBe(snapshotSha256(text));
    const other = { ...input, coins: [{ ...input.coins[0]!, claimedZats: 1_000_001n }] };
    expect(snapshotSha256(serializeSnapshot(buildSnapshot(other)))).not.toBe(snapshotSha256(text));
  });

  test("the memo text carries the epoch and the hash", () => {
    expect(snapshotMemoText("epoch-1", "ab".repeat(32))).toBe(`snarks-pad snapshot epoch-1 sha256:${"ab".repeat(32)}`);
  });
});

describe("the verify script's arithmetic", () => {
  // A snapshot whose numbers are exactly right: holders' pool 750,000; weights 1:3:1:1 -> shares 125,000 x ...
  const good = (): VerifierSnapshot => {
    const s = buildSnapshot({
      ...input,
      coins: [{ mint: "MintA", claimedZats: 1_000_000n, teamZats: 250_000n, rows: [
        { wallet: "Sol1", weight: 100n, shareZats: 125_000n }, { wallet: "Sol2", weight: 300n, shareZats: 375_000n },
        { wallet: "Shd1", weight: 100n, shareZats: 125_000n }, { wallet: "Shd2", weight: 100n, shareZats: 125_000n },
      ] }],
    });
    return JSON.parse(JSON.stringify(s)) as VerifierSnapshot;
  };

  test("an honest snapshot has no problems", () => expect(arithmeticProblems(good())).toEqual([]));

  test("each doctoring is caught: a bigger team cut, a changed share, a dropped commitment, a wrong total", () => {
    const team = good(); team.coins[0]!.teamZats = "300000"; team.coins[0]!.holdersZats = "700000";
    expect(arithmeticProblems(team).join("\n")).toMatch(/team 300000 is not 2500 bps/);
    const share = good(); share.coins[0]!.solana[0]!.shareZats = "130000";
    expect(arithmeticProblems(share).join("\n")).toMatch(/Sol1 has share 130000/);
    const dropped = good(); dropped.coins[0]!.shielded.commitments.pop();
    expect(arithmeticProblems(dropped).join("\n")).toMatch(/1 commitments for a count of 2/);
    const total = good(); total.coins[0]!.shielded.totalShareZats = "1";
    expect(arithmeticProblems(total).join("\n")).toMatch(/is not the holders' pool/);
    const claimed = good(); claimed.coins[0]!.claimedZats = "2000000";
    expect(arithmeticProblems(claimed).join("\n")).toMatch(/is not claimed/);
  });

  test("a share one zat above the pro-rata floor is the rounding zat and is allowed; two is not", () => {
    const s = good(); s.coins[0]!.solana[0]!.shareZats = "125001"; s.coins[0]!.solana[1]!.shareZats = "374999";
    expect(arithmeticProblems(s).join("\n")).not.toMatch(/Sol1/);
    s.coins[0]!.solana[0]!.shareZats = "125002";
    expect(arithmeticProblems(s).join("\n")).toMatch(/Sol1/);
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
const LIVE = await validatorUp();
const COIN = Keypair.generate().publicKey.toBase58();
const MINT = config.solana.dbc.quoteMint;
const settled: SwapAdapter = { provider: "near-1click", quote: async () => ({ outZats: 0n }), submit: async (a) => ({ ref: `fake-${a}` }), status: async () => ({ status: "settled", amountOutZats: 10n ** 12n }) };

async function fundKeeper(zats: bigint): Promise<void> {
  const k = loadKeeperKeypair();
  // On a fresh chain the keeper has no ZEC account yet: create it rather than depend on another test file having done so.
  const ata = (await getOrCreateAssociatedTokenAccount(getConnection(), k, MINT, k.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  await mintTo(getConnection(), k, MINT, ata, k, zats);
}
function claimOf(claimed: bigint, holders: { wallet: string; balance: bigint }[]) {
  const deps: ClaimDeps = { claimCoin: async (_e, c) => (c.mint === COIN ? claimed : 0n), currentHolders: async () => holders };
  return (epochId: string) => claimRemainingCoins(epochId, deps);
}
function reset(): void {
  (config.epoch.snapshots as { minWindowSamples: number }).minWindowSamples = 0;
  db.getDb().query("DELETE FROM epochs WHERE status = 'harvesting'").run();
  db.getDb().query("UPDATE payouts SET sentAt = 'set-aside', sig = COALESCE(sig, 'set-aside') WHERE sentAt IS NULL").run();
  db.getDb().query("DELETE FROM carry").run();
  db.getDb().query("DELETE FROM optins").run();
  db.getDb().query("UPDATE epochs SET status = 'ok' WHERE status IN ('partial','needs_attention')").run();
  db.getDb().query("UPDATE epoch_snapshots SET memoAt = COALESCE(memoAt, 'set-aside')").run();
}
const team = config.epoch.team as { wallet: string | null };
const savedWallet = team.wallet;
afterEach(() => { team.wallet = savedWallet; });

async function memoText(sig: string): Promise<string | null> {
  const tx = await getConnection().getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const ix = tx?.transaction.message.instructions.find((i) => "program" in i && i.program === "spl-memo") as { parsed?: unknown } | undefined;
  return typeof ix?.parsed === "string" ? ix.parsed : null;
}

describe.if(LIVE)("the snapshot through runEpoch and the real chain", () => {
  beforeAll(() => {
    db.upsertCoin({ mint: COIN, name: "Snap", symbol: "SNP", imageUrl: "", description: "", creator: Keypair.generate().publicKey.toBase58(), createdAt: new Date().toISOString(), feeBps: 100, poolId: null, mintDecimals: 6, status: "pending" });
    db.markCoinLaunched(COIN, Keypair.generate().publicKey.toBase58());
  });
  afterAll(() => db.upsertCoin({ ...db.getCoin(COIN)!, status: "pending" }));

  test("an epoch writes its snapshot with the plan; the keeper's memo carries the file's sha256; the API serves the same bytes", async () => {
    reset();
    const a = Keypair.generate(), b = Keypair.generate();
    await fundKeeper(1_000_000n);
    const id = (await runEpoch(settled, claimOf(1_000_000n, [{ wallet: a.publicKey.toBase58(), balance: 100n }, { wallet: b.publicKey.toBase58(), balance: 300n }]))).epoch!.id;

    const snap = db.getEpochSnapshot(id)!;
    expect(snap.sha256).toBe(snapshotSha256(snap.json));
    expect(snap.memoAt).not.toBeNull();
    expect(await memoText(snap.memoSig!)).toBe(snapshotMemoText(id, snap.sha256)); // on chain, signed by the keeper
    const tx = await getConnection().getTransaction(snap.memoSig!, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx!.transaction.message.staticAccountKeys[0]!.toBase58()).toBe(loadKeeperKeypair().publicKey.toBase58());

    const res = await handleRequest(new Request(`http://x/api/epochs/${id}/snapshot`));
    expect(res.status).toBe(200);
    const served = await res.text();
    expect(served).toBe(snap.json); // byte for byte
    expect(snapshotSha256(served)).toBe(snap.sha256);
    expect(res.headers.get("x-snapshot-sha256")).toBe(snap.sha256);
    const parsed = JSON.parse(served) as Snapshot;
    expect(parsed.coins[0]!.solana.map((r) => r.wallet).sort()).toEqual([a.publicKey.toBase58(), b.publicKey.toBase58()].sort());
    expect(arithmeticProblems(parsed as unknown as VerifierSnapshot)).toEqual([]); // what the verify script runs
    const listed = ((await (await handleRequest(new Request("http://x/api/epochs"))).json()) as { epochs: { id: string; snapshot: { sha256: string; memoSig: string | null; url: string } | null }[] }).epochs.find((e) => e.id === id)!;
    expect(listed.snapshot).toEqual({ sha256: snap.sha256, memoSig: snap.memoSig, url: `/api/epochs/${id}/snapshot` });
  }, 120_000);

  test("a second run writes no second memo and never changes the stored file", async () => {
    reset();
    const a = Keypair.generate();
    await fundKeeper(1_000_000n);
    const id = (await runEpoch(settled, claimOf(1_000_000n, [{ wallet: a.publicKey.toBase58(), balance: 1n }]))).epoch!.id;
    const first = db.getEpochSnapshot(id)!;
    await runEpoch(settled, async () => {});
    await runEpoch(settled, async () => {});
    const after = db.getEpochSnapshot(id)!;
    expect([after.memoSig, after.json, after.sha256]).toEqual([first.memoSig, first.json, first.sha256]);
    expect(await ensureSnapshotMemo(id)).toBe("landed");
    expect(db.getEpochSnapshot(id)!.memoSig).toBe(first.memoSig);
  }, 120_000);

  test("FAULT: a memo that cannot be sent never stops the payouts; it alerts, and the next run writes it once", async () => {
    reset();
    const a = Keypair.generate();
    await fundKeeper(1_000_000n);
    const conn = getConnection();
    const real = conn.getLatestBlockhash.bind(conn);
    let calls = 0;
    (conn as { getLatestBlockhash: typeof real }).getLatestBlockhash = (async (...args: Parameters<typeof real>) => {
      if (calls++ === 0) throw new Error("rpc unreachable (injected)"); // the memo is the first thing that asks for a blockhash
      return real(...args);
    }) as typeof real;
    let id: string;
    try {
      id = (await runEpoch(settled, claimOf(1_000_000n, [{ wallet: a.publicKey.toBase58(), balance: 1n }]))).epoch!.id;
    } finally {
      (conn as { getLatestBlockhash: typeof real }).getLatestBlockhash = real;
    }
    expect(db.getEpoch(id!)!.status).toBe("ok");
    expect(db.getPayouts(id!).every((p) => p.sentAt !== null)).toBe(true); // holders were paid
    expect(db.getEpochSnapshot(id!)!.memoAt).toBeNull(); // the memo was not
    expect(db.listOpenAlerts().some((x) => x.kind === "snapshot_memo" && x.epochId === id)).toBe(true);

    await runEpoch(settled, async () => {});
    const snap = db.getEpochSnapshot(id!)!;
    expect(snap.memoAt).not.toBeNull();
    expect(await memoText(snap.memoSig!)).toBe(snapshotMemoText(id!, snap.sha256));
    expect(db.listOpenAlerts().some((x) => x.kind === "snapshot_memo" && x.epochId === id)).toBe(false);
  }, 120_000);

  test("CRASH after signing, before broadcasting: the resume sends the SAME signed bytes, once", async () => {
    reset();
    const a = Keypair.generate();
    await fundKeeper(1_000_000n);
    team.wallet = null;
    // Make the memo fail so it stays unsent, then hand-sign the pending state exactly as ensureSnapshotMemo does.
    const conn = getConnection();
    const real = conn.getLatestBlockhash.bind(conn);
    let calls = 0;
    (conn as { getLatestBlockhash: typeof real }).getLatestBlockhash = (async (...args: Parameters<typeof real>) => {
      if (calls++ === 0) throw new Error("down (injected)"); // the memo's call; the payouts that follow are not affected
      return real(...args);
    }) as typeof real;
    let id: string;
    try {
      id = (await runEpoch(settled, claimOf(1_000_000n, [{ wallet: a.publicKey.toBase58(), balance: 1n }]))).epoch!.id;
    } finally {
      (conn as { getLatestBlockhash: typeof real }).getLatestBlockhash = real;
    }
    const snap = db.getEpochSnapshot(id!)!;
    expect(snap.memoSig).toBeNull();
    const keeper = loadKeeperKeypair();
    const tx = buildMemoTransaction(snapshotMemoText(id!, snap.sha256), keeper.publicKey);
    tx.feePayer = keeper.publicKey;
    const { blockhash, lastValidBlockHeight } = await real("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(keeper);
    const sig = bs58.encode(tx.signature!);
    db.markSnapshotMemoPending(id!, sig, Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight);
    expect((await conn.getSignatureStatuses([sig])).value[0]).toBeNull(); // never broadcast

    await runEpoch(settled, async () => {});
    const after = db.getEpochSnapshot(id!)!;
    expect(after.memoSig).toBe(sig); // the original signature, not a second memo
    expect(after.memoAt).not.toBeNull();
    expect(await memoText(sig)).toBe(snapshotMemoText(id!, snap.sha256));
  }, 120_000);

  test("a shielded holder opens their own row with a signed request; a stranger, a bad signature and a replayed nonce get nothing", async () => {
    reset();
    const a = Keypair.generate(), shielded = Keypair.generate();
    db.upsertOptin(shielded.publicKey.toBase58(), "u1" + "q".repeat(120));
    await fundKeeper(4_000_000n);
    // Below the shielded thresholds the opted-in share is carried, which is fine here: the snapshot still lists the row.
    const id = (await runEpoch(settled, claimOf(4_000_000n, [{ wallet: a.publicKey.toBase58(), balance: 100n }, { wallet: shielded.publicKey.toBase58(), balance: 100n }]), { includeShielded: false })).epoch!.id;
    const snap = JSON.parse(db.getEpochSnapshot(id)!.json) as Snapshot;
    expect(JSON.stringify(snap)).not.toContain(shielded.publicKey.toBase58()); // the opted-in wallet is not named in the file
    expect(snap.coins[0]!.shielded.count).toBe(1);

    const nonce = async (w: Keypair) => ((await (await handleRequest(new Request(`http://x/api/optin/nonce?wallet=${w.publicKey.toBase58()}`))).json()) as { nonce: string }).nonce;
    const open = async (w: Keypair, n: string, signer: Keypair = w) => {
      const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(epochReceiptMessage(w.publicKey.toBase58(), id, n)), signer.secretKey));
      return handleRequest(new Request(`http://x/api/epochs/${id}/receipt?wallet=${w.publicKey.toBase58()}&nonce=${n}&signature=${sig}`));
    };

    const n1 = await nonce(shielded);
    const res = await open(shielded, n1);
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { rows: { mint: string; shareZats: string; salt: string; commitment: string }[] }).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.shareZats).toBe("1500000"); // 4,000,000 claimed: holders 3,000,000, half is theirs
    expect(snap.coins[0]!.shielded.commitments).toContain(rows[0]!.commitment); // it opens a commitment that is in the published file
    expect(commitment(id, rows[0]!.mint, rows[0]!.salt, shielded.publicKey.toBase58(), 1_500_000n)).toBe(rows[0]!.commitment);

    expect((await open(shielded, n1)).status).toBe(400); // the nonce was spent
    const forged = await open(shielded, await nonce(shielded), a); // signed by someone else
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "invalid_signature" });
    const stranger = await open(a, await nonce(a)); // a Solana-rail holder: valid request, nothing to open
    expect(((await stranger.json()) as { rows: unknown[] }).rows).toEqual([]);
  }, 120_000);
});

describe("GET /api/epochs/:id/snapshot", () => {
  test("an epoch with no snapshot (older than this feature) is a 404 no_snapshot, not a crash", async () => {
    const res = await handleRequest(new Request("http://x/api/epochs/epoch-does-not-exist/snapshot"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_snapshot" });
  });
});
