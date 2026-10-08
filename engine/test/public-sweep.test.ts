// The clean-up of the hosted files (src/publicFiles/sweep.ts, docs/API.md v2.7 and v2.8.2). A fake clock and fake chain stand in; file times are set with
// utimes relative to that clock. What must hold: nothing a coin still needs is ever removed (above all a launch the browser sent but never confirmed,
// which exists on chain), what nothing needs goes after 24 hours, an unconfirmed launch goes after an hour (S4-05), and the sweep gives the event loop a
// turn between batches of files (S4-01).
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import * as db from "../src/db";
import { imagesDir, metadataDir, uploadUrl } from "../src/publicFiles/paths";
import { PENDING_AFTER_MS, SWEEP_AFTER_MS, SWEEP_BATCH, mintExistsOnChain, sweepPublicFiles, type SweepDeps } from "../src/publicFiles/sweep";
import type { PoolLook } from "../src/dbc/reconcile";

const NOW = Date.now();
const HOUR = 3_600_000;
const roots: string[] = [];
const minted: string[] = [];
const dropRows = () => {
  for (const m of minted.splice(0)) db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: m });
};
// The sweep drops every stale unconfirmed launch in the database it is given, and the test database is shared with other files: each test sees only the rows it made.
const allStale = db.listStalePendingCoins;
const staleSpy = spyOn(db, "listStalePendingCoins").mockImplementation((before) => allStale(before).filter((r) => minted.includes(r.mint)));
afterEach(dropRows);
afterAll(() => {
  staleSpy.mockRestore();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  dropRows();
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sweep-"));
  roots.push(root);
  mkdirSync(imagesDir(root), { recursive: true });
  mkdirSync(metadataDir(root), { recursive: true });
  return root;
}

/** A file whose own time is `ageH` hours before the fake clock. */
function put(path: string, ageH: number, content = "x"): string {
  writeFileSync(path, content);
  const t = new Date(NOW - ageH * HOUR);
  utimesSync(path, t, t);
  return path;
}

const mintKey = () => Keypair.generate().publicKey.toBase58();
let n = 0;
const imageName = () => `${(n++).toString(16).padStart(24, "0")}.png`;

function coin(mint: string, status: "pending" | "launched", ageH: number, imageUrl = "") {
  minted.push(mint);
  db.upsertCoin({
    mint, name: "S", symbol: "S", imageUrl, description: "", creator: mint, createdAt: new Date(NOW - ageH * HOUR).toISOString(), feeBps: 100,
    poolId: status === "launched" ? mintKey() : null, mintDecimals: 6, status,
  });
}

/** `onChain`: mints that exist; for a pending launch, that its pool exists (the launch landed). `asked` lists every chain question, of either kind. */
const deps = (onChain: string[] = []): SweepDeps & { asked: string[] } => {
  const asked: string[] = [];
  return {
    now: () => NOW,
    mintExists: async (m) => (asked.push(m), onChain.includes(m)),
    poolOf: async (m): Promise<PoolLook> => (asked.push(m), onChain.includes(m) ? { state: "landed", poolId: mintKey(), activationPoint: null } : { state: "absent" }),
    asked,
  };
};
const unreadable = async (): Promise<PoolLook> => ({ state: "unknown" });
const absent = async (): Promise<PoolLook> => ({ state: "absent" });

describe("the metadata file of a launch", () => {
  test("never confirmed for 24 hours and no such mint on chain: removed", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 30);
    const file = put(join(metadataDir(root), `${m}.json`), 30);
    const report = await sweepPublicFiles(root, deps());
    expect(report.metadataRemoved).toEqual([m]);
    expect(existsSync(file)).toBe(false);
  });

  test("never confirmed but its pool exists (the browser sent it and never called confirm): recorded as launched, its file kept (plan 13 F3)", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 30);
    const file = put(join(metadataDir(root), `${m}.json`), 30);
    const report = await sweepPublicFiles(root, deps([m]));
    expect(report.pendingRecorded).toEqual([m]);
    expect(report.pendingRemoved).toEqual([]);
    expect(report.metadataRemoved).toEqual([]);
    expect(db.getCoin(m)?.status).toBe("launched");
    expect(existsSync(file)).toBe(true);
  });

  test("an account someone funded at the mint address is not a launch: with no pool the row and the file go (plan 13 F4)", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 30);
    const file = put(join(metadataDir(root), `${m}.json`), 30);
    const report = await sweepPublicFiles(root, { now: () => NOW, mintExists: async () => true, poolOf: absent });
    expect(report.pendingRemoved).toEqual([m]);
    expect(report.metadataRemoved).toEqual([m]);
    expect(db.getCoin(m)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("a launched coin's file is kept without asking the chain, however old", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "launched", 500);
    const file = put(join(metadataDir(root), `${m}.json`), 500);
    const d = deps();
    await sweepPublicFiles(root, d);
    expect(existsSync(file)).toBe(true);
    expect(d.asked).toEqual([]);
  });

  test("a launch prepared less than an hour ago is kept: its creator may still be in the wallet", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 0.5);
    const file = put(join(metadataDir(root), `${m}.json`), 0.5);
    const d = deps();
    await sweepPublicFiles(root, d);
    expect(existsSync(file)).toBe(true);
    expect(d.asked).toEqual([]);
  });

  test("a file with no coin row at all and no mint on chain goes after 24 hours; with the mint on chain it stays", async () => {
    const root = scratch();
    const gone = mintKey();
    const real = mintKey();
    put(join(metadataDir(root), `${gone}.json`), 48);
    put(join(metadataDir(root), `${real}.json`), 48);
    const report = await sweepPublicFiles(root, deps([real]));
    expect(report.metadataRemoved).toEqual([gone]);
    expect(existsSync(join(metadataDir(root), `${real}.json`))).toBe(true);
  });

  test("when the chain cannot be read the file is kept: the chain reader answers true for an RPC error, false only for an account that is not there", async () => {
    const m = mintKey();
    expect(await mintExistsOnChain(m, async () => null)).toBe(false);
    expect(await mintExistsOnChain(m, async () => ({ lamports: 1 }))).toBe(true);
    expect(await mintExistsOnChain(m, async () => { throw new Error("429 Too Many Requests"); })).toBe(true);
    const root = scratch();
    put(join(metadataDir(root), `${m}.json`), 48);
    await sweepPublicFiles(root, { now: () => NOW, mintExists: (mint) => mintExistsOnChain(mint, async () => { throw new Error("rpc down"); }), poolOf: unreadable });
    expect(existsSync(join(metadataDir(root), `${m}.json`))).toBe(true);
  });

  test("a file that is not named like a mint is left alone", async () => {
    const root = scratch();
    const odd = put(join(metadataDir(root), "notes.txt"), 500);
    await sweepPublicFiles(root, deps());
    expect(existsSync(odd)).toBe(true);
  });
});

describe("an uploaded image", () => {
  test("no coin and no metadata file uses it, and it is older than 24 hours: removed", async () => {
    const root = scratch();
    const name = imageName();
    const file = put(join(imagesDir(root), name), 25);
    const report = await sweepPublicFiles(root, deps());
    expect(report.imagesRemoved).toEqual([name]);
    expect(existsSync(file)).toBe(false);
  });

  test("younger than 24 hours: kept, used or not (a creator may be filling in the form)", async () => {
    const root = scratch();
    const file = put(join(imagesDir(root), imageName()), 23);
    await sweepPublicFiles(root, deps());
    expect(existsSync(file)).toBe(true);
  });

  test("a launched coin's image is kept, however old", async () => {
    const root = scratch();
    const name = imageName();
    const file = put(join(imagesDir(root), name), 900);
    coin(mintKey(), "launched", 800, uploadUrl(name));
    await sweepPublicFiles(root, deps());
    expect(existsSync(file)).toBe(true);
  });

  test("a launched coin that still points at the host the live name used to have still counts: the match is by the stored name, not the host", async () => {
    const root = scratch();
    const name = imageName();
    const file = put(join(imagesDir(root), name), 900);
    coin(mintKey(), "launched", 800, `https://an-older-host.example/i/${name}`);
    await sweepPublicFiles(root, deps());
    expect(existsSync(file)).toBe(true);
  });

  test("a coin prepared in the last hour counts; one prepared longer ago and never confirmed does not (and its metadata file goes with it)", async () => {
    const root = scratch();
    const young = imageName();
    const old = imageName();
    const youngFile = put(join(imagesDir(root), young), 40);
    const oldFile = put(join(imagesDir(root), old), 60);
    coin(mintKey(), "pending", 0.5, uploadUrl(young));
    const stale = mintKey();
    coin(stale, "pending", 50, uploadUrl(old));
    put(join(metadataDir(root), `${stale}.json`), 50, JSON.stringify({ image: uploadUrl(old) }));
    const report = await sweepPublicFiles(root, deps());
    expect(existsSync(youngFile)).toBe(true);
    expect(existsSync(oldFile)).toBe(false);
    expect(report.metadataRemoved).toEqual([stale]);
    expect(report.imagesRemoved).toEqual([old]);
  });

  test("the picture a metadata file that stays names is kept even with no coin row (the file is what a wallet reads)", async () => {
    const root = scratch();
    const name = imageName();
    const m = mintKey();
    const image = put(join(imagesDir(root), name), 100);
    put(join(metadataDir(root), `${m}.json`), 100, JSON.stringify({ image: uploadUrl(name) }));
    await sweepPublicFiles(root, deps([m]));
    expect(existsSync(image)).toBe(true);
  });

  test("the placeholder, a file with another kind of name and a directory are never touched", async () => {
    const root = scratch();
    const placeholder = put(join(imagesDir(root), "placeholder.png"), 9999);
    const other = put(join(imagesDir(root), "readme.txt"), 9999);
    mkdirSync(join(imagesDir(root), "0123456789abcdef01234567.png.d"));
    await sweepPublicFiles(root, deps());
    expect([existsSync(placeholder), existsSync(other)]).toEqual([true, true]);
  });
});

describe("a temporary file", () => {
  test("left by a write that was cut off is removed after an hour, not before", async () => {
    const root = scratch();
    const old = put(join(imagesDir(root), ".tmp-aaaaaaaaaaaa"), 2);
    const fresh = put(join(metadataDir(root), ".tmp-bbbbbbbbbbbb"), 0.1);
    const report = await sweepPublicFiles(root, deps());
    expect(report.tmpRemoved).toBe(1);
    expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
  });
});

test("24 hours is the stated limit", () => {
  expect(SWEEP_AFTER_MS).toBe(24 * HOUR);
});

test("a directory that does not exist yet is an empty sweep, not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-empty-"));
  roots.push(root);
  expect(await sweepPublicFiles(join(root, "nothing-here"), deps())).toEqual({ metadataRemoved: [], metadataKept: [], pendingRemoved: [], pendingRecorded: [], imagesRemoved: [], tmpRemoved: 0 });
});

describe("an unconfirmed launch is dropped after an hour (S4-05)", () => {
  const row = (mint: string) => db.getCoin(mint);

  test("an hour is the stated limit, and it is shorter than the 24 hours of everything else", () => {
    expect(PENDING_AFTER_MS).toBe(HOUR);
    expect(PENDING_AFTER_MS).toBeLessThan(SWEEP_AFTER_MS);
  });

  test("prepared 2 hours ago, never confirmed, no such mint on chain: the coin row and its metadata file are both gone, and the report says so", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 2);
    const file = put(join(metadataDir(root), `${m}.json`), 2);
    const report = await sweepPublicFiles(root, deps());
    expect(report.pendingRemoved).toEqual([m]);
    expect(report.metadataRemoved).toEqual([m]);
    expect(row(m)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("prepared 2 hours ago and its pool exists (the browser sent it and never called confirm): recorded as launched, the file stays (plan 13 F3; it once stayed pending for good)", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 2);
    const file = put(join(metadataDir(root), `${m}.json`), 2);
    const d = deps([m]);
    const report = await sweepPublicFiles(root, d);
    expect(report.pendingRemoved).toEqual([]);
    expect(report.pendingRecorded).toEqual([m]);
    expect(row(m)?.status).toBe("launched");
    expect(existsSync(file)).toBe(true);
    expect(d.asked).toEqual([m]); // asked once, not once per pass
  });

  test("a launch confirmed while the chain was being asked is not dropped, and its file stays", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 2);
    const file = put(join(metadataDir(root), `${m}.json`), 2);
    const confirming: SweepDeps = {
      now: () => NOW,
      mintExists: async () => false,
      poolOf: async () => {
        db.markCoinLaunched(m, mintKey()); // the browser's confirm lands while the sweep waits for the RPC
        return { state: "absent" };
      },
    };
    const report = await sweepPublicFiles(root, confirming);
    expect(report.pendingRemoved).toEqual([]);
    expect(report.metadataRemoved).toEqual([]);
    expect(row(m)?.status).toBe("launched");
    expect(existsSync(file)).toBe(true);
  });

  test("a pending row with no metadata file is dropped too (the row is what counts against the cap), and only the file reports are about files", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 3);
    const report = await sweepPublicFiles(root, deps());
    expect(report.pendingRemoved).toEqual([m]);
    expect(report.metadataRemoved).toEqual([]);
    expect(row(m)).toBeNull();
  });

  test("oldest first, and only the pending ones: a launched coin of the same age is never asked about", async () => {
    const root = scratch();
    const [newer, older, launched] = [mintKey(), mintKey(), mintKey()];
    coin(newer, "pending", 3);
    coin(older, "pending", 9);
    coin(launched, "launched", 9);
    const d = deps();
    const report = await sweepPublicFiles(root, d);
    expect(d.asked).toEqual([older, newer]);
    expect(report.pendingRemoved).toEqual([older, newer]);
    expect(row(launched)?.status).toBe("launched");
  });

  test("a metadata file with no row at all keeps the 24 hours: an hour is for launches this pad recorded", async () => {
    const root = scratch();
    const m = mintKey();
    const file = put(join(metadataDir(root), `${m}.json`), 5);
    const d = deps();
    await sweepPublicFiles(root, d);
    expect(existsSync(file)).toBe(true);
    expect(d.asked).toEqual([]);
  });

  test("when the chain cannot be read the launch is kept, row and file: a read that fails never makes a launch look unconfirmed", async () => {
    const root = scratch();
    const m = mintKey();
    coin(m, "pending", 5);
    const file = put(join(metadataDir(root), `${m}.json`), 5);
    const report = await sweepPublicFiles(root, { now: () => NOW, mintExists: (mint) => mintExistsOnChain(mint, async () => { throw new Error("rpc down"); }), poolOf: unreadable });
    expect(report.pendingRemoved).toEqual([]);
    expect(row(m)?.status).toBe("pending");
    expect(existsSync(file)).toBe(true);
  });
});

describe("the sweep does not hold the process (S4-01)", () => {
  /** Files `n` metadata and `n / 10` pictures, all fresh, so a sweep reads and stats every one of them and removes none. */
  function many(n: number): string {
    const root = scratch();
    for (let i = 0; i < n; i++) writeFileSync(join(metadataDir(root), `${mintKey()}.json`), JSON.stringify({ image: uploadUrl(imageName()) }));
    for (let i = 0; i < n / 10; i++) writeFileSync(join(imagesDir(root), imageName()), "x");
    return root;
  }

  test("the event loop gets a turn between batches: a timer fires many times during a sweep of several batches (a sweep that never yielded would let it fire once, after)", async () => {
    const root = many(SWEEP_BATCH * 6);
    let turns = 0;
    const heartbeat = setInterval(() => turns++, 1);
    const report = await sweepPublicFiles(root, deps());
    clearInterval(heartbeat);
    expect(report).toEqual({ metadataRemoved: [], metadataKept: [], pendingRemoved: [], pendingRecorded: [], imagesRemoved: [], tmpRemoved: 0 });
    expect(turns).toBeGreaterThanOrEqual(6);
  });

  test("a metadata file that disappears between the listing and the stat (another process removed it) is skipped, not an error", async () => {
    const root = scratch();
    const m = mintKey();
    put(join(metadataDir(root), `${m}.json`), 48);
    const real = db.getCoin;
    const spy = spyOn(db, "getCoin").mockImplementation((mint) => {
      rmSync(join(metadataDir(root), `${mint}.json`), { force: true }); // after the directory was listed, before the file is looked at
      return real(mint);
    });
    try {
      expect(await sweepPublicFiles(root, deps())).toEqual({ metadataRemoved: [], metadataKept: [], pendingRemoved: [], pendingRecorded: [], imagesRemoved: [], tmpRemoved: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  test("a launch prepared after the scan began that names an old picture keeps it (the sweep is not atomic, so it asks the database again before it deletes)", async () => {
    const root = scratch();
    const name = imageName();
    const file = put(join(imagesDir(root), name), 30);
    const later = mintKey();
    const real = db.listCoinImageRefs;
    const spy = spyOn(db, "listCoinImageRefs").mockImplementation(() => {
      const refs = real();
      coin(later, "pending", 0, uploadUrl(name)); // the launch lands right after the scan read the rows
      return refs;
    });
    try {
      const report = await sweepPublicFiles(root, deps());
      expect(report.imagesRemoved).toEqual([]);
      expect(existsSync(file)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("an upload of the same picture that renews its time after the scan saw it old keeps it: the time is read again right before the delete", async () => {
    const root = scratch();
    const name = imageName();
    const file = put(join(imagesDir(root), name), 30);
    const real = db.listCoinsNamingImage;
    const spy = spyOn(db, "listCoinsNamingImage").mockImplementation((n) => {
      const t = new Date(); // storeUpload's renewal of an existing file, between the scan and the delete
      utimesSync(file, t, t);
      return real(n);
    });
    try {
      const report = await sweepPublicFiles(root, { now: () => Date.now(), mintExists: async () => false, poolOf: absent });
      expect(report.imagesRemoved).toEqual([]);
      expect(existsSync(file)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
