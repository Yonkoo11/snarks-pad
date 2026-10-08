// What may be stored as a coin's image docs/API.md v2.7, POST /uploads). The kind is decided by the first bytes of the file and by
// nothing else: not the name, not the media type the client claims. Four kinds pass (PNG, JPEG, WEBP, GIF); an SVG, an HTML page, a PDF,
// anything else is refused before any decoder sees it. PNG, JPEG and WEBP are decoded and written again by sharp, so what is stored is
// bytes this engine produced: no EXIF or other metadata, fitted inside 1000 x 1000, never enlarged, and no byte of a polyglot that rode
// along after the picture. A GIF keeps its frames, so it is stored as sent, but only after its own blocks are walked end to end (the
// last byte must be the GIF trailer) and its first frame has decoded.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DecodeQueueFull, makeDecodeGate } from "./decodeGate";
import type { ImageKind } from "./paths";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** A PNG, JPEG or WEBP is fitted inside this square; a smaller one is not enlarged. */
export const MAX_SIDE = 1000;
const JPEG_QUALITY = 90;
const WEBP_QUALITY = 90;
/** A picture with more pixels than this (a 5,000 x 5,000 square) is refused before it is decoded: a small file can unpack into gigabytes. A 1,000 x 1,000 copy is all that is kept (S4-03). */
export const MAX_INPUT_PIXELS = 25_000_000;
/** At most this many pictures are being decoded at once, and this many more may wait their turn; the next is refused (src/publicFiles/decodeGate.ts, S4-03). */
export const MAX_DECODES = 2;
export const MAX_WAITING_DECODES = 9;
export const decodeGate = makeDecodeGate(MAX_DECODES, MAX_WAITING_DECODES);
/** A GIF is stored as sent, so its size is bounded instead of resized. */
export const MAX_GIF_SIDE = 4096;
export const MAX_GIF_FRAMES = 500;

export interface ProcessedImage {
  /** The bytes to store (and to hash for the name). */
  bytes: Uint8Array;
  kind: ImageKind;
  width: number;
  height: number;
}

/** The file is not a picture this pad stores. The message is for the log; a caller never sends it on. */
export class BadImageError extends Error {}

const ascii = (b: Uint8Array, from: number, len: number): string => String.fromCharCode(...b.subarray(from, from + len));

/** The kind of image the first bytes of `b` say it is, or null when they say none of the four. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  const head = ascii(b, 0, 6);
  return head === "GIF87a" || head === "GIF89a" ? "gif" : null;
}

async function reencode(input: Uint8Array, kind: Exclude<ImageKind, "gif">): Promise<ProcessedImage> {
  // failOn "error": a warning (a PNG with an odd colour profile, a slightly short JPEG) still gives a clean picture; an error does not.
  const fitted = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
    .rotate() // apply the EXIF orientation first, then the metadata (EXIF included) is left out of the output
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
  const encoded = kind === "png" ? fitted.png({ compressionLevel: 9 }) : kind === "jpg" ? fitted.jpeg({ quality: JPEG_QUALITY }) : fitted.webp({ quality: WEBP_QUALITY });
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
  return { bytes: data, kind, width: info.width, height: info.height };
}

/** Skips the data sub-blocks that start at `pos` (each is a size byte and that many bytes, ended by a zero size); the position after them, or null. */
function skipSubBlocks(b: Uint8Array, start: number): number | null {
  let pos = start;
  for (;;) {
    if (pos >= b.length) return null;
    const size = b[pos]!;
    pos += 1 + size;
    if (pos > b.length) return null;
    if (size === 0) return pos;
  }
}

const colourTableBytes = (packed: number): number => 3 * 2 ** ((packed & 7) + 1);

/**
 * Walks a GIF block by block: header, screen descriptor, then extensions and frames until the trailer. The number of frames when the blocks end
 * exactly at the last byte of the file (nothing hidden after the picture), or null when they do not.
 */
export function gifFrameCount(b: Uint8Array): number | null {
  if (b.length < 14) return null;
  let pos = 13 + (b[10]! & 0x80 ? colourTableBytes(b[10]!) : 0);
  let frames = 0;
  while (pos < b.length) {
    const tag = b[pos]!;
    if (tag === 0x3b) return pos === b.length - 1 && frames > 0 ? frames : null;
    let next: number | null;
    if (tag === 0x21) next = skipSubBlocks(b, pos + 2);
    else if (tag === 0x2c && pos + 10 <= b.length) {
      const flags = b[pos + 9]!;
      next = skipSubBlocks(b, pos + 10 + (flags & 0x80 ? colourTableBytes(flags) : 0) + 1); // + the LZW minimum code size byte
      frames += 1;
    } else return null;
    if (next === null) return null;
    pos = next;
  }
  return null;
}

async function checkGif(input: Uint8Array): Promise<ProcessedImage> {
  const frames = gifFrameCount(input);
  if (frames === null || frames > MAX_GIF_FRAMES) throw new BadImageError("the GIF's blocks are not a picture that ends at its trailer");
  // The logical screen (bytes 6-9) is what a viewer allocates; sharp reports the first frame's own size, which can be 2 x 2 on a 65535 x 65535 screen (S4 stress ST-UP-05).
  const screenW = input[6]! | (input[7]! << 8);
  const screenH = input[8]! | (input[9]! << 8);
  if (screenW < 1 || screenH < 1 || screenW > MAX_GIF_SIDE || screenH > MAX_GIF_SIDE) throw new BadImageError(`the GIF's screen is ${screenW} x ${screenH}`);
  const open = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
  const { width = 0, height = 0 } = await open().metadata();
  if (width < 1 || height < 1 || width > MAX_GIF_SIDE || height > MAX_GIF_SIDE) throw new BadImageError(`the GIF is ${width} x ${height}`);
  await open().resize({ width: 16, height: 16, fit: "inside" }).raw().toBuffer(); // the first frame must decode
  return { bytes: input, kind: "gif", width, height };
}

/** The image to store for an upload, or a BadImageError when it is not one of the four kinds or does not decode; DecodeQueueFull when too many are waiting to be decoded. Never reads its name or its claimed type. */
export async function processImage(input: Uint8Array): Promise<ProcessedImage> {
  const kind = sniffImage(input);
  if (!kind) throw new BadImageError("the first bytes are not those of a PNG, JPEG, WEBP or GIF");
  try {
    return await decodeGate.run(() => (kind === "gif" ? checkGif(input) : reencode(input, kind)));
  } catch (err) {
    if (err instanceof BadImageError || err instanceof DecodeQueueFull) throw err;
    throw new BadImageError(`the ${kind} did not decode: ${(err as Error).message}`);
  }
}

/** The name a stored image gets: the first 24 hex digits of the sha256 of the stored bytes, then the extension of the stored kind. */
export function storedName(bytes: Uint8Array, kind: ImageKind): string {
  return `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}.${kind}`;
}
