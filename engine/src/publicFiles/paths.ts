// Where the files this engine hosts live and what their addresses look like docs/API.md v2.7. Two directories under
// PUBLIC_DIR: `i` holds uploaded coin images, named by the hash of their bytes; `m` holds one metadata JSON per coin, named by its mint.
// Every address handed out is `PUBLIC_BASE_URL` + `/i/<name>` or `/m/<mint>.json`, and a name is only ever one of the shapes below:
// nothing a client sends is ever joined into a path.
import { join } from "node:path";
import { config } from "../config";

export type ImageKind = "png" | "jpg" | "webp" | "gif";

/** An uploaded image: the first 24 hex digits of the sha256 of the stored bytes, and the extension of what was stored. */
export const UPLOAD_NAME = /^[0-9a-f]{24}\.(png|jpg|webp|gif)$/;
/** The picture a coin launched without an image shows in a wallet or an explorer. */
export const PLACEHOLDER_NAME = "placeholder.png";
export const METADATA_NAME = /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/;
/** Metaplex stores at most this many characters of a token's uri on chain. */
export const MAX_URI_CHARS = 200;

const MIME: Record<ImageKind, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export const imagesDir = (root: string = config.publicFiles.dir): string => join(root, "i");
export const metadataDir = (root: string = config.publicFiles.dir): string => join(root, "m");

export function mimeOfKind(kind: ImageKind): string {
  return MIME[kind];
}

/** The media type of a stored image name (an upload or the placeholder). */
export function mimeOfName(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1) as ImageKind;
  return MIME[ext] ?? "application/octet-stream";
}

export const uploadUrl = (name: string): string => `${config.publicFiles.baseUrl}/i/${name}`;
export const placeholderUrl = (): string => uploadUrl(PLACEHOLDER_NAME);

/** The address written on chain as a coin's uri. Refused when it would not fit (a configuration the startup check already rules out). */
export function metadataUrl(mint: string): string {
  const url = `${config.publicFiles.baseUrl}/m/${mint}.json`;
  if (url.length > MAX_URI_CHARS) throw new Error(`the metadata address is ${url.length} characters, over the ${MAX_URI_CHARS} Metaplex stores: shorten PUBLIC_BASE_URL`);
  return url;
}

/** The stored name an address names, when it is exactly one of THIS pad's upload addresses; null for any other address. */
export function uploadNameOfUrl(url: string): string | null {
  const prefix = `${config.publicFiles.baseUrl}/i/`;
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return UPLOAD_NAME.test(name) ? name : null;
}

const NAME_AT_END = /\/i\/([0-9a-f]{24}\.(?:png|jpg|webp|gif))$/;

/**
 * The stored name at the end of any address that looks like an upload address, whatever host it names. A coin launched before the live
 * name moved to another server still points at the old host, and the sweep must still count that file as used.
 */
export function uploadNameInAnyUrl(url: string): string | null {
  return NAME_AT_END.exec(url)?.[1] ?? null;
}
