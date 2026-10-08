// The engine's own copy of what Caddy serves on a server: GET and HEAD of /i/<name> (an uploaded image or the placeholder) and /m/<mint>.json (a coin's
// metadata), straight from PUBLIC_DIR, so dev, tests and the mock-free local stack show the same addresses a wallet will read. Only the exact name shapes
// of src/publicFiles/paths.ts are served: no other path ever reaches the disk, whatever it contains. The headers are Caddy's (ops/templates/Caddyfile.site):
// a picture never changes under its hash name, so it is cached for a year; a metadata file for a minute.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { CORS_HEADERS, fail } from "../api/common";
import { METADATA_NAME, PLACEHOLDER_NAME, UPLOAD_NAME, imagesDir, metadataDir, mimeOfName } from "./paths";

const IMMUTABLE = "public, max-age=31536000, immutable";
const A_MINUTE = "public, max-age=60";

interface HostedFile {
  path: string;
  type: string;
  cache: string;
}

/** The file a request path names, or null when it is not exactly an upload name, the placeholder or a mint's JSON. */
export function hostedFileOf(pathname: string): HostedFile | null {
  if (pathname.startsWith("/i/")) {
    const name = pathname.slice(3);
    return UPLOAD_NAME.test(name) || name === PLACEHOLDER_NAME ? { path: join(imagesDir(), name), type: mimeOfName(name), cache: IMMUTABLE } : null;
  }
  if (pathname.startsWith("/m/")) {
    const name = pathname.slice(3);
    return METADATA_NAME.test(name) ? { path: join(metadataDir(), name), type: "application/json", cache: A_MINUTE } : null;
  }
  return null;
}

/** The response for GET or HEAD of a hosted file, 404 for one that is not there; null for any other request (the caller carries on). */
export function servePublicFile(req: Request, url: URL): Response | null {
  if (!url.pathname.startsWith("/i/") && !url.pathname.startsWith("/m/")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const file = hostedFileOf(url.pathname);
  if (!file || !existsSync(file.path) || !statSync(file.path).isFile()) return fail(404, "not_found");
  const headers = {
    "content-type": file.type, "cache-control": file.cache, "x-content-type-options": "nosniff", "content-length": String(statSync(file.path).size),
    "x-pad-mode": config.mode, ...CORS_HEADERS,
  };
  return new Response(req.method === "HEAD" ? null : Bun.file(file.path), { status: 200, headers });
}
