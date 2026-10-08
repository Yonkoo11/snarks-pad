// Request validation for the HTTP API. Every rejection is a typed ApiFail that
// api.ts turns into a clean 4xx with a contract error code. Nothing here ever
// echoes a submitted value back (a submitted Zcash address must never appear
// in any response, docs/API.md privacy rule).
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { imagesDir, uploadNameOfUrl } from "../publicFiles/paths";
import { parseSocials, type Socials } from "../socials";

export class ApiFail extends Error {
  constructor(public status: number, public code: string, public field?: string) {
    super(code);
  }
}

export const MAX_BODY_BYTES = 16 * 1024;
const U64_MAX = (1n << 64n) - 1n;
/** A surrogate half with no partner: JSON can spell it (\ud800) but it is not text. The chain would write U+FFFD for it while the metadata file kept the escape, and the two names would differ (S4 stress ST-MD-03). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Reads a JSON object body with a byte cap. Never throws anything but ApiFail. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ApiFail(413, "body_too_large");
  const buf = await readBodyCapped(req, MAX_BODY_BYTES, "bad_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    throw new ApiFail(400, "bad_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ApiFail(400, "bad_json");
  return parsed as Record<string, unknown>;
}

/** Streams the body and stops at `maxBytes` (413 body_too_large), so a chunked upload with no content-length is never buffered whole.
 *  A stream that breaks half way is a 400 with `brokenCode`. */
export async function readBodyCapped(req: Request, maxBytes: number, brokenCode: string): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ApiFail(413, "body_too_large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ApiFail) throw e;
    throw new ApiFail(400, brokenCode);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** A base58 32-byte Solana public key, canonical form only. */
export function isPubkey(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(v)) return false;
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}

export function pubkeyField(body: Record<string, unknown>, field: string, code = "bad_wallet"): string {
  const v = body[field];
  if (!isPubkey(v)) throw new ApiFail(400, code, field);
  return v;
}

/** A wallet from the path: a canonical pubkey, else `400 bad_wallet` (also for a path that is not valid percent-encoding). */
export function decodeWallet(raw: string): string {
  let wallet: string;
  try {
    wallet = decodeURIComponent(raw);
  } catch {
    throw new ApiFail(400, "bad_wallet", "wallet");
  }
  if (!isPubkey(wallet)) throw new ApiFail(400, "bad_wallet", "wallet");
  return wallet;
}

export function stringField(body: Record<string, unknown>, field: string, opts: { min?: number; max: number; optional?: boolean }): string {
  const v = body[field];
  if (v === undefined || v === null) {
    if (opts.optional) return "";
    throw new ApiFail(400, "bad_request", field);
  }
  if (typeof v !== "string") throw new ApiFail(400, "bad_request", field);
  if (v.length < (opts.min ?? 0) || v.length > opts.max) throw new ApiFail(400, "bad_request", field);
  if (/[\u0000-\u001f\u007f]/.test(v) && field !== "description") throw new ApiFail(400, "bad_request", field);
  if (LONE_SURROGATE.test(v)) throw new ApiFail(400, "bad_request", field);
  if (INVISIBLE.test(v)) throw new ApiFail(400, "bad_request", field);
  return v;
}

/**
 * Characters that show nothing and change how the rest reads (audit S6, lens 5-8): the zero-width space, the bidi marks,
 * embeddings, overrides and isolates, the word joiner, the byte-order mark and the soft hyphen. They defeat the lookalike
 * check on names and are written on chain with the coin. The zero-width joiner and non-joiner stay allowed: emoji
 * sequences and several scripts need them.
 */
const INVISIBLE = /[­​‎‏‪-‮⁠⁦-⁩﻿]/;

/** A positive integer amount in base units, as a decimal string, that fits in a u64. */
export function amountField(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > U64_MAX) throw new ApiFail(400, "bad_amount", field);
  return v;
}

export function intField(body: Record<string, unknown>, field: string, min: number, max: number, dflt?: number): number {
  const v = body[field];
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ApiFail(400, "bad_request", field);
  return v;
}

export function oneOf<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const v = body[field];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ApiFail(400, "bad_request", field);
  return v as T;
}

/** A base58 ed25519 signature (64 bytes). */
export function signatureField(body: Record<string, unknown>, field: string, code = "bad_request"): string {
  const v = body[field];
  if (typeof v !== "string" || v.length > 100) throw new ApiFail(400, code, field);
  try {
    if (bs58.decode(v).length !== 64) throw new Error();
  } catch {
    throw new ApiFail(400, code, field);
  }
  return v;
}

/**
 * A coin's image (contract v2.7): empty (the placeholder is shown), or the address POST /uploads gave, for a file that is still on this server. Any other
 * address (another site, a site path, a data: URL, an upload address with another host or a name this pad never made) is `bad_image_url`; so is an
 * upload that has since been swept. At most 200 characters, like every address in a request.
 */
export function imageUrlField(body: Record<string, unknown>): string {
  const v = stringField(body, "imageUrl", { max: 200, optional: true });
  if (v === "") return v;
  const name = uploadNameOfUrl(v);
  if (!name || !existsSync(join(imagesDir(), name))) throw new ApiFail(400, "bad_image_url", "imageUrl");
  return v;
}

/** The creator's links of a launch request (src/socials.ts): none when absent, else only links that pass. A bad one is `bad_request` naming `socials` or `socials.<key>`. */
export function socialsField(body: Record<string, unknown>): Socials {
  const r = parseSocials(body.socials);
  if (!r.ok) throw new ApiFail(400, "bad_request", r.field);
  return r.socials;
}
