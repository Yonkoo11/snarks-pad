// POST /api/uploads docs/API.md v2.7: a coin's image from the creator's device. One multipart field `file`, at most 5 MB; only the
// first bytes decide what it is (src/publicFiles/image.ts); what is stored is written by this engine, named by the hash of the stored bytes and
// answered as an address under PUBLIC_BASE_URL. Public like every route here, so it is paid for in work: 10 uploads per client address per minute, and the
// decoding is gated (src/publicFiles/decodeGate.ts): 2 pictures are decoded at once, 9 more wait their turn, and one more upload than that is refused 503 busy
// with retry-after before its body is read (S4-03).
import { MAX_UPLOAD_BYTES, BadImageError, MAX_DECODES, MAX_WAITING_DECODES } from "../publicFiles/image";
import { DecodeQueueFull } from "../publicFiles/decodeGate";
import { storeUpload } from "../publicFiles/store";
import { fail, json, type RequestContext } from "./common";
import { ApiFail, readBodyCapped } from "./validate";
import { makeWindowLimiter } from "./windowLimiter";

export const UPLOADS_PER_MINUTE = 10;
/** Uploads being handled at once, each holding its body in memory (up to about 15 MB with the copies the form parser makes): the ones decoding and the ones waiting to. */
export const MAX_UPLOADS_IN_FLIGHT = MAX_DECODES + MAX_WAITING_DECODES;
/** Room for the multipart framing around a file of the largest allowed size. */
const FRAMING_ALLOWANCE = 64 * 1024;
const MAX_BODY = MAX_UPLOAD_BYTES + FRAMING_ALLOWANCE;

export const uploadLimiter = makeWindowLimiter(UPLOADS_PER_MINUTE, 60_000);
let inFlight = 0;

/** The one `file` part of a multipart body, read with a byte cap. Anything else is a 400 naming `file`; a file over 5 MB is a 413. */
async function readUploadedFile(req: Request): Promise<File> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new ApiFail(400, "bad_request", "file");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new ApiFail(413, "body_too_large");
  const body = await readBodyCapped(req, MAX_BODY, "bad_request");
  const form = await new Response(body, { headers: { "content-type": type } }).formData().catch(() => null);
  if (!form) throw new ApiFail(400, "bad_request", "file");
  const parts = form.getAll("file");
  const file = parts[0];
  if (parts.length !== 1 || !(file instanceof File)) throw new ApiFail(400, "bad_request", "file");
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiFail(413, "body_too_large");
  return file;
}

async function acceptUpload(req: Request): Promise<Response> {
  const file = await readUploadedFile(req);
  try {
    const stored = await storeUpload(new Uint8Array(await file.arrayBuffer()));
    return json({ url: stored.url, width: stored.width, height: stored.height, bytes: stored.bytes });
  } catch (err) {
    if (err instanceof BadImageError) {
      console.warn(`[api] upload refused: ${err.message}`);
      throw new ApiFail(400, "bad_image", "file");
    }
    throw err;
  }
}

/** The upload route if this request is for it, else null (the caller carries on). */
export async function handleUploadRoute(req: Request, url: URL, ctx: RequestContext): Promise<Response | null> {
  if (url.pathname !== "/api/uploads") return null;
  if (req.method !== "POST") return fail(404, "not_found");
  const wait = uploadLimiter.take(ctx.ip ?? "unknown");
  if (wait !== null) return fail(429, "rate_limited", undefined, { "retry-after": String(wait) });
  if (inFlight >= MAX_UPLOADS_IN_FLIGHT) return fail(503, "busy", undefined, { "retry-after": "5" });
  inFlight += 1;
  try {
    return await acceptUpload(req);
  } catch (err) {
    if (err instanceof DecodeQueueFull) return fail(503, "busy", undefined, { "retry-after": "5" });
    throw err;
  } finally {
    inFlight -= 1;
  }
}
