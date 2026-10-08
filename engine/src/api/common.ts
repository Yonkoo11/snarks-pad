// What every route of the HTTP API shares: the JSON answer and the error answer with the headers every route carries, the check that a
// path names a coin this pad launched, and what a handler is told about the connection it came in on.
import { config } from "../config";
import * as db from "../db";
import { withinDeadline } from "../rpcGuard";
import { toJson } from "../util/json";
import { ApiFail, isPubkey } from "./validate";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id",
  // Without this a browser on another origin cannot read x-pad-mode, and the
  // web app's mode banner never learns which network it is on.
  "access-control-expose-headers": "x-pad-mode",
};

export function json(body: unknown, status = 200): Response {
  return new Response(toJson(body), {
    status,
    headers: { "content-type": "application/json", "x-pad-mode": config.mode, ...CORS_HEADERS },
  });
}

export function fail(status: number, error: string, field?: string, extraHeaders: Record<string, string> = {}): Response {
  const res = json(field ? { error, field } : { error }, status);
  for (const [k, v] of Object.entries(extraHeaders)) res.headers.set(k, v);
  return res;
}

/** A mint from the path: must be a pubkey and a coin this pad launched. */
export function launchedMint(raw: string): string {
  let mint: string;
  try {
    mint = decodeURIComponent(raw);
  } catch {
    throw new ApiFail(404, "unknown_mint");
  }
  if (!isPubkey(mint)) throw new ApiFail(404, "unknown_mint");
  const coin = db.getCoin(mint);
  if (!coin || coin.status !== "launched") throw new ApiFail(404, "unknown_mint");
  return mint;
}

/** What a handler is told about the connection a request came in on. */
export interface RequestContext {
  /** The client's address: the socket's, or behind the reverse proxy the one it forwarded. null when nothing says (a test calling the handler directly). */
  ip: string | null;
  /** A route that streams calls this once: the server's idle timeout would otherwise cut a stream that is quiet for ten seconds. */
  keepOpen?: () => void;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.|0:0:0:0::\/64$)/;

/** A caller on this machine itself (no proxy header: an operator's curl, a test). Behind Caddy every client arrives with the header, so a loopback client is never a user. */
export const isLoopback = (address: string | null): boolean => address !== null && LOOPBACK.test(address);

/**
 * The address to rate-limit by. The API listens on 127.0.0.1 behind Caddy (ops/DEPLOY.md), so the socket's peer is always Caddy and
 * the client is the LAST entry of X-Forwarded-For (the one the proxy itself added; Caddy replaces what the client sent). A header is
 * believed only when the peer is loopback: anyone who can reach the port directly could write it.
 */
export function clientIp(forwardedFor: string | null, peer: string | null): string | null {
  if (peer && LOOPBACK.test(peer) && forwardedFor) {
    const last = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last && /^[0-9a-fA-F:.]{2,45}$/.test(last)) return limiterAddress(last);
  }
  return peer === null ? null : limiterAddress(peer);
}

/**
 * The address a client is counted under (audit S6, lens 5-4). An IPv6 host owns a whole /64 and can use a fresh address per
 * request, so every per-address cap (uploads, launches, streams, nonces) counted it once per address; the /64 is the unit
 * one client controls. IPv4, and IPv4 mapped into IPv6, count as the single address they are.
 */
export function limiterAddress(address: string): string {
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  const groups = expandIpv6(address);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
}

/** The eight 16-bit groups of an IPv6 address written with or without "::", lower-case and without leading zeros; null if it is not one. */
function expandIpv6(address: string): string[] | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

/**
 * The longest a route that needs the chain (launch-tx, trade-tx, the quote, and the views below) waits for it before it answers `503 chain_unavailable`
 * (contract v2.8.1: within 5 s). Each RPC call has its own timeout too (src/rpcGuard.ts); this bounds a route that makes several.
 */
export const CHAIN_ROUTE_DEADLINE_MS = Number(process.env.PAD_CHAIN_ROUTE_DEADLINE_MS ?? 4_000);

/** A chain read behind a view failed or ran past CHAIN_ROUTE_DEADLINE_MS: log what happened (never to the caller) and answer 503 so the page can say "try again". */
export async function chainRead<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await withinDeadline(read(), CHAIN_ROUTE_DEADLINE_MS);
  } catch (err) {
    if (err instanceof ApiFail) throw err;
    console.error(`[api] ${what} could not read the chain: ${(err as Error)?.message ?? err}`);
    throw new ApiFail(503, "chain_unavailable");
  }
}
