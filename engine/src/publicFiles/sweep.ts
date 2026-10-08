// The clean-up of the hosted files docs/API.md v2.7, v2.8.2), run when the API starts and every hour:
//   - a launch that was prepared and never confirmed is looked up after an hour: when its pool exists it is recorded as
//     launched (a launch the browser sent but never confirmed IS a coin, and its uri must keep answering); when the pool is absent its coin row and metadata
//     file are dropped, oldest first; when the chain cannot be read it waits for the next sweep. The pool decides, not the mint address: anyone can send
//     lamports to an address, which once kept such a row (and its place under the 2,000 cap) forever. The transaction it holds is good for about two
//     minutes, so after an hour nothing signed can still land. The metadata file of a mint with no row at all goes after 24 h unless the mint exists;
//   - an uploaded image no coin uses is removed after 24 h. "In use" is: a launched coin's image, a coin prepared in the last 24 h, or the picture a
//     metadata file that still exists names. The age is the file's own time, which an upload of the same picture renews;
//   - a temporary file left by a crash in the middle of a write is removed after an hour.
// It never throws into the API: a failed sweep is a log line and the next hour tries again.
// It never holds the API either (S4-01): the directories are read through the async file API, the files in batches of SWEEP_BATCH with the event loop given a
// turn between batches, so a request waits for at most a batch. The sweep is no longer atomic against the routes, so a picture is asked about once more, in
// the database, right before it is deleted: a launch prepared after the sweep began may have come to name it.
import { PublicKey } from "@solana/web3.js";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import * as db from "../db";
import { getConnection } from "../solana";
import { METADATA_NAME, UPLOAD_NAME, imagesDir, metadataDir, uploadNameInAnyUrl } from "./paths";
import { lookForPool, type PoolLook } from "../dbc/reconcile";

export const SWEEP_AFTER_MS = 24 * 3_600_000;
/** How long a launch may stay unconfirmed before the sweep drops it (S4-05). */
export const PENDING_AFTER_MS = 3_600_000;
export const SWEEP_EVERY_MS = 3_600_000;
/** Directory entries handled between two turns of the event loop (S4-01). */
export const SWEEP_BATCH = 200;
const TMP_AFTER_MS = 3_600_000;

export interface SweepDeps {
  now: () => number;
  /** Whether a mint account exists on chain (a metadata file with no coin row). A read that fails must answer true: a file is kept when nobody can say it is unused. */
  mintExists: (mint: string) => Promise<boolean>;
  /** What the chain says about the pool a pending launch would have made (dbc/reconcile.ts). A read that fails must answer "unknown". */
  poolOf: (mint: string) => Promise<PoolLook>;
}

export interface SweepReport {
  /** Mints whose metadata file was removed (with a dropped launch, or alone when it had no row). */
  metadataRemoved: string[];
  /** Mints older than the limit that were kept because the mint exists on chain. */
  metadataKept: string[];
  /** Mints whose unconfirmed launch (the coin row) was dropped. */
  pendingRemoved: string[];
  /** Mints whose unconfirmed launch had landed (its pool exists) and is now recorded as launched. */
  pendingRecorded: string[];
  imagesRemoved: string[];
  tmpRemoved: number;
}

/** Whether the mint account exists on chain. A read that fails (the RPC is down or slow) answers true: nobody can say the file is unused, so it stays. */
export async function mintExistsOnChain(mint: string, read: (key: PublicKey) => Promise<unknown | null> = (key) => getConnection().getAccountInfo(key, "confirmed")): Promise<boolean> {
  try {
    return (await read(new PublicKey(mint))) !== null;
  } catch {
    return true;
  }
}

const chainDeps: SweepDeps = { now: Date.now, mintExists: (mint) => mintExistsOnChain(mint), poolOf: (mint) => lookForPool(mint) };

const isGone = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The names in `dir`, none when it does not exist yet. The read waits on the disk, not on this thread. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isGone(err)) return [];
    throw err;
  }
}

/** The file's own time, or null when it is gone (an upload renamed it, or another sweep removed it). */
async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
}

/** Removes a file; whether it was there. */
async function removeFile(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (err) {
    if (isGone(err)) return false;
    throw err;
  }
}

/** `each` over `items`, SWEEP_BATCH at a time, in order: a batch's calls wait on the disk together, and the event loop gets a turn between batches. */
async function mapInBatches<T, R>(items: T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += SWEEP_BATCH) {
    out.push(...(await Promise.all(items.slice(i, i + SWEEP_BATCH).map(each))));
    await yieldToLoop();
  }
  return out;
}

const notNull = <T>(x: T | null): x is T => x !== null;
const mintOfFile = (name: string): string => name.slice(0, -".json".length);

async function removeStaleTemporaries(dirs: string[], now: number): Promise<number> {
  let removed = 0;
  for (const dir of dirs) {
    const left = (await listDir(dir)).filter((f) => f.startsWith(".tmp-"));
    const done = await mapInBatches(left, async (name) => {
      const mtime = await mtimeOf(join(dir, name));
      return mtime !== null && now - mtime > TMP_AFTER_MS && (await removeFile(join(dir, name))) ? 1 : 0;
    });
    removed += done.reduce<number>((a, b) => a + b, 0);
  }
  return removed;
}

interface PendingResult {
  /** Every mint decided here, dropped or kept: the metadata pass leaves them alone. */
  handled: Set<string>;
  dropped: string[];
  metadataRemoved: string[];
  kept: string[];
  recorded: string[];
}

/**
 * The launches prepared more than PENDING_AFTER_MS ago and never confirmed, oldest first: recorded when their pool exists, kept and reported when the chain
 * cannot say, dropped otherwise.
 */
async function dropStalePending(root: string, deps: SweepDeps): Promise<PendingResult> {
  const result: PendingResult = { handled: new Set(), dropped: [], metadataRemoved: [], kept: [], recorded: [] };
  for (const { mint } of db.listStalePendingCoins(new Date(deps.now() - PENDING_AFTER_MS).toISOString())) {
    result.handled.add(mint);
    const look = await deps.poolOf(mint);
    if (look.state === "landed") {
      db.markCoinLaunched(mint, look.poolId, look.activationPoint);
      result.recorded.push(mint);
    } else if (look.state === "unknown") {
      result.kept.push(mint);
    } else if (db.deleteUnconfirmedCoin(mint)) {
      // the row first, and only a row still unconfirmed: a launch confirmed while the chain was asked keeps its file
      result.dropped.push(mint);
      if (await removeFile(join(metadataDir(root), `${mint}.json`))) result.metadataRemoved.push(mint);
    }
  }
  return result;
}

/** Removes the metadata files of mints with no row to say otherwise, after 24 h; the mints that exist on chain anyway are reported as kept. */
async function sweepMetadataFiles(root: string, deps: SweepDeps, handled: Set<string>): Promise<Pick<SweepReport, "metadataRemoved" | "metadataKept">> {
  const old = await mapInBatches(await listDir(metadataDir(root)), async (name) => {
    if (!METADATA_NAME.test(name)) return null;
    const mint = mintOfFile(name);
    if (handled.has(mint) || db.getCoin(mint)?.status === "launched") return null;
    const mtime = await mtimeOf(join(metadataDir(root), name));
    return mtime !== null && deps.now() - mtime > SWEEP_AFTER_MS ? mint : null;
  });
  const removed: string[] = [];
  const kept: string[] = [];
  for (const mint of old.filter(notNull)) {
    if ((await deps.mintExists(mint)) || db.getCoin(mint)?.status === "launched") kept.push(mint); // launched while the chain was asked
    else if (await removeFile(join(metadataDir(root), `${mint}.json`))) removed.push(mint);
  }
  return { metadataRemoved: removed, metadataKept: kept };
}

/** Whether a coin row keeps the picture it names: launched, or prepared in the last 24 h. */
const rowKeepsImage = (row: { status: db.CoinRow["status"]; createdAt: string }, now: number): boolean => row.status === "launched" || now - Date.parse(row.createdAt) < SWEEP_AFTER_MS;

/** The picture a metadata file names, or null (a file that is not JSON, or is gone, names nothing). */
async function imageNamedBy(file: string): Promise<string | null> {
  try {
    const image = (JSON.parse(await readFile(file, "utf8")) as { image?: unknown }).image;
    return typeof image === "string" ? uploadNameInAnyUrl(image) : null;
  } catch {
    return null;
  }
}

/** The stored names something still points at: coins launched or prepared lately, and every metadata file that remains. */
async function namesInUse(root: string, now: number): Promise<Set<string>> {
  const used = new Set<string>();
  for (const row of db.listCoinImageRefs()) {
    const name = uploadNameInAnyUrl(row.imageUrl);
    if (name && rowKeepsImage(row, now)) used.add(name);
  }
  const named = await mapInBatches(await listDir(metadataDir(root)), async (f) => (METADATA_NAME.test(f) ? imageNamedBy(join(metadataDir(root), f)) : null));
  for (const name of named) if (name) used.add(name);
  return used;
}

async function sweepImages(root: string, now: number): Promise<string[]> {
  const used = await namesInUse(root, now);
  const old = await mapInBatches(await listDir(imagesDir(root)), async (name) => {
    if (!UPLOAD_NAME.test(name) || used.has(name)) return null;
    const mtime = await mtimeOf(join(imagesDir(root), name));
    return mtime !== null && now - mtime > SWEEP_AFTER_MS ? name : null;
  });
  const removed: string[] = [];
  for (const name of old.filter(notNull)) {
    if (db.listCoinsNamingImage(name).some((row) => rowKeepsImage(row, now))) continue; // a launch prepared since the scan began names it
    const mtime = await mtimeOf(join(imagesDir(root), name)); // an upload of the same picture may have renewed it meanwhile
    if (mtime !== null && now - mtime > SWEEP_AFTER_MS && (await removeFile(join(imagesDir(root), name)))) removed.push(name);
  }
  return removed;
}

export async function sweepPublicFiles(root: string = config.publicFiles.dir, deps: SweepDeps = chainDeps): Promise<SweepReport> {
  const tmpRemoved = await removeStaleTemporaries([imagesDir(root), metadataDir(root)], deps.now());
  const pending = await dropStalePending(root, deps); // first: a dropped launch's file no longer counts as naming its picture
  const files = await sweepMetadataFiles(root, deps, pending.handled);
  return {
    metadataRemoved: [...pending.metadataRemoved, ...files.metadataRemoved],
    metadataKept: [...pending.kept, ...files.metadataKept],
    pendingRemoved: pending.dropped,
    pendingRecorded: pending.recorded,
    imagesRemoved: await sweepImages(root, deps.now()),
    tmpRemoved,
  };
}

/** The one line a sweep that removed something leaves in the log. */
function describeSweep(r: SweepReport): string {
  return `[api] sweep recorded ${r.pendingRecorded.length} landed launch(es), removed ${r.pendingRemoved.length} unconfirmed launch(es), ${r.metadataRemoved.length} metadata file(s), ${r.imagesRemoved.length} unused image(s), ${r.tmpRemoved} temporary file(s)`;
}

/** Sweeps now and then every hour, for as long as the process lives (the timer does not hold it open). A failure is logged, never thrown; a sweep still running at the next hour is not started again. */
export function startPublicFilesSweep(): ReturnType<typeof setInterval> {
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await sweepPublicFiles();
      if (r.pendingRecorded.length + r.pendingRemoved.length + r.metadataRemoved.length + r.imagesRemoved.length + r.tmpRemoved > 0) console.log(describeSweep(r));
    } catch (err) {
      console.error(`[api] sweep of the hosted files failed: ${(err as Error)?.message ?? err}`);
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(run, SWEEP_EVERY_MS).unref();
}
