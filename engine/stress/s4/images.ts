// Picture builders for the S4 upload stress (stress/s4/uploads.ts): PNG chunks and IHDR rewrites, JPEG comment segments, and a tiny GIF encoder
// (one colour, a clear code before every pixel, so no dictionary is ever built and the codes stay 3 bits) with comment padding, a chosen canvas
// and many frames. Test-only; nothing here is used by the engine.
import sharp from "sharp";

export const cat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
export const crc32 = (b: Uint8Array): number => Bun.hash.crc32(b) >>> 0;
export const has = (bytes: Uint8Array, needle: string): boolean => Buffer.from(bytes).includes(needle);

const solid = (w: number, h: number) => ({ create: { width: w, height: h, channels: 3 as const, background: { r: 196, g: 47, b: 108 } } });
export const png = async (w: number, h: number): Promise<Uint8Array> => new Uint8Array(await sharp(solid(w, h)).png({ compressionLevel: 9 }).toBuffer());
export const jpg = async (w: number, h: number): Promise<Uint8Array> => new Uint8Array(await sharp(solid(w, h)).jpeg().toBuffer());
export const webp = async (w: number, h: number): Promise<Uint8Array> => new Uint8Array(await sharp(solid(w, h)).webp().toBuffer());
/** A PNG that compresses badly (random pixels), for bodies of about `mb` megabytes. */
export async function noisyPng(mb: number): Promise<Uint8Array> {
  const side = Math.ceil(Math.sqrt((mb * 1024 * 1024) / 3));
  const raw = new Uint8Array(side * side * 3);
  crypto.getRandomValues(raw.subarray(0, Math.min(raw.length, 65_536)));
  for (let i = 65_536; i < raw.length; i += 65_536) raw.set(raw.subarray(0, Math.min(65_536, raw.length - i)), i);
  for (let i = 0; i < raw.length; i += 7919) raw[i] = (raw[i]! + (i >> 3)) & 255; // break the repeat so deflate finds little
  return new Uint8Array(await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer());
}

/** A PNG chunk: length, type, data, CRC over type + data. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(text(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** `chunk` inserted right after IHDR (signature 8 + IHDR 25 = 33 bytes). */
export const pngInsertAfterIhdr = (p: Uint8Array, chunk: Uint8Array): Uint8Array => cat(p.subarray(0, 33), chunk, p.subarray(33));
/** The same PNG bytes with IHDR claiming `w` x `h` (CRC recomputed): a header that lies about the picture behind it. */
export function pngClaiming(p: Uint8Array, w: number, h: number): Uint8Array {
  const out = Uint8Array.from(p);
  const dv = new DataView(out.buffer);
  dv.setUint32(16, w >>> 0);
  dv.setUint32(20, h >>> 0);
  dv.setUint32(29, crc32(out.subarray(12, 29)));
  return out;
}
/** A JPEG with a COM segment holding `comment` right after SOI. */
export function jpegWithComment(j: Uint8Array, comment: string): Uint8Array {
  const body = text(comment);
  const len = body.length + 2;
  return cat(j.subarray(0, 2), Uint8Array.from([0xff, 0xfe, len >> 8, len & 255]), body, j.subarray(2));
}

const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
function subBlocks(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const slice = data.subarray(i, Math.min(i + 255, data.length));
    parts.push(Uint8Array.from([slice.length]), slice);
  }
  parts.push(Uint8Array.from([0]));
  return cat(...parts);
}
/** LZW data for `n` pixels of colour index 0, a clear code before each, then end-of-information: every code 3 bits, LSB first. */
function lzwPixels(n: number): Uint8Array {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  const put = (code: number): void => {
    acc |= code << bits;
    bits += 3;
    while (bits >= 8) {
      bytes.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  for (let i = 0; i < n; i++) {
    put(4);
    put(0);
  }
  put(5);
  if (bits > 0) bytes.push(acc & 255);
  return Uint8Array.from(bytes);
}
export interface GifOptions {
  canvasW?: number;
  canvasH?: number;
  frames?: number;
  /** Comment extensions written before the first frame, one each. */
  comments?: Uint8Array[];
}
/** A GIF89a of `frames` identical w x h one-colour frames on a canvas (default w x h), with optional comment extensions first. */
export function gif(w: number, h: number, o: GifOptions = {}): Uint8Array {
  const header = cat(text("GIF89a"), Uint8Array.from([...le16(o.canvasW ?? w), ...le16(o.canvasH ?? h), 0x80, 0, 0]), Uint8Array.from([0, 0, 0, 255, 0, 0]));
  const comments = (o.comments ?? []).map((c) => cat(Uint8Array.from([0x21, 0xfe]), subBlocks(c)));
  const frame = cat(Uint8Array.from([0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2]), subBlocks(lzwPixels(w * h)));
  const all: Uint8Array[] = [header, ...comments];
  for (let i = 0; i < (o.frames ?? 1); i++) all.push(frame);
  all.push(Uint8Array.from([0x3b]));
  return cat(...all);
}
/** A GIF of exactly `total` bytes: a 2 x 2 picture padded with a comment (and an empty second comment when one alone cannot hit the size). */
export function gifOfSize(total: number): Uint8Array {
  const base = gif(2, 2).length;
  const sizeWith = (payload: number, extra: number): number => base + 3 + payload + Math.ceil(payload / 255) + extra;
  for (const extra of [0, 3]) {
    let payload = Math.max(0, total - base - 3 - extra - Math.ceil((total - base) / 255));
    for (let tries = 0; tries < 600; tries++, payload++) {
      if (sizeWith(payload, extra) !== total) continue;
      const comments = [new Uint8Array(payload).fill(0x41), ...(extra ? [new Uint8Array()] : [])];
      const out = gif(2, 2, { comments });
      if (out.length !== total) throw new Error(`built ${out.length}, wanted ${total}`);
      return out;
    }
  }
  throw new Error(`no comment padding reaches ${total} bytes`);
}
