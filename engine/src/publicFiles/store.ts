// Writing the files this engine hosts. Every write goes to a temporary name in the same directory and is renamed into place, so a reader (Caddy,
// the engine's own static route) never sees half a file; a file is group-readable (0640) and a directory 0750 whatever the unit's umask says.
// On a server the directory is group `caddy` with the setgid bit (ops/remote-setup.sh), so what is written here is readable by Caddy and nobody else.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { processImage, storedName } from "./image";
import { PLACEHOLDER_NAME, imagesDir, metadataDir, uploadUrl } from "./paths";

const DIR_MODE = 0o750;
const FILE_MODE = 0o640;

export interface StoredUpload {
  name: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export function ensurePublicDirs(root: string = config.publicFiles.dir): void {
  for (const dir of [imagesDir(root), metadataDir(root)]) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Writes `bytes` as `dir/name`: temporary file, mode, rename. Replaces a file of that name. */
export function writeFileAtomic(dir: string, name: string, bytes: Uint8Array | string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, bytes, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, join(dir, name));
}

/**
 * Checks an uploaded file and stores what comes out of the check (src/publicFiles/image.ts). The name is the hash of the STORED bytes, so the
 * same picture sent twice is one file: the second send only renews the file's time (the sweep counts from it). Throws BadImageError.
 */
export async function storeUpload(input: Uint8Array, root: string = config.publicFiles.dir): Promise<StoredUpload> {
  const img = await processImage(input);
  const name = storedName(img.bytes, img.kind);
  const dir = imagesDir(root);
  if (existsSync(join(dir, name))) {
    const now = new Date();
    utimesSync(join(dir, name), now, now);
  } else {
    writeFileAtomic(dir, name, img.bytes);
  }
  return { name, url: uploadUrl(name), width: img.width, height: img.height, bytes: img.bytes.length };
}

/** The picture of a coin with no image of its own: this repository's engine/assets/placeholder.png, copied under /i when it is missing or differs. */
export function ensurePlaceholder(root: string = config.publicFiles.dir): void {
  const source = readFileSync(join(config.paths.engineRoot, "assets", PLACEHOLDER_NAME));
  const target = join(imagesDir(root), PLACEHOLDER_NAME);
  if (existsSync(target) && Buffer.compare(readFileSync(target), source) === 0) return;
  writeFileAtomic(imagesDir(root), PLACEHOLDER_NAME, source);
}
