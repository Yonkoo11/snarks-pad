// The creator's links docs/API.md v2.7, `socials` on POST /coins/launch-tx and on every Coin). What a person types (a handle, a bare domain, a
// full link) becomes the ONE https address that is stored, or a plain reason why it cannot. These are the rules of web/src/lib/socials.ts, ported
// here so the server judges what it is sent and does not trust the form; test/socials.test.ts runs both on the same inputs and they must agree.
//
// Lookalikes are refused by matching the WHOLE host: x.com.evil.example, notx.com, x.com@evil.example and a host written with look-alike letters
// (punycode, xn--) never pass for X, Telegram or an honest website. Only https is kept, and every address is at most 100 characters.

/** The links of one coin. Each is an https address or absent. `x` is X (Twitter); in the metadata JSON it is written under `twitter`. */
export interface Socials {
  website?: string;
  x?: string;
  telegram?: string;
}
export type SocialKey = keyof Socials;
export interface SocialCheck {
  url: string | null;
  error: string | null;
}

export const SOCIAL_KEYS: readonly SocialKey[] = ["website", "x", "telegram"];
export const SOCIAL_MAX_CHARS = 100;

const none: SocialCheck = { url: null, error: null };
const tooLong: SocialCheck = { url: null, error: `At most ${SOCIAL_MAX_CHARS} characters.` };

/** A host made of plain letters, digits, hyphens and dots, no empty label and no punycode label (a way to dress one site as another). */
function plainHost(host: string): boolean {
  return /^[a-z0-9.-]+$/.test(host) && !host.split(".").some((label) => label === "" || label.startsWith("xn--"));
}

function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" || !/\.[a-z]{2,}$/i.test(u.hostname) || !plainHost(u.hostname) || u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

export function checkWebsite(raw: string): SocialCheck {
  const s = raw.trim();
  if (!s) return none;
  if (s.length > SOCIAL_MAX_CHARS) return tooLong;
  const u = httpsUrl(s);
  if (!u || /^(x|twitter|t)\.(com|me)$/i.test(u.hostname.replace(/^www\./, ""))) return { url: null, error: "A website link that starts with https://" };
  if (u.href.length > SOCIAL_MAX_CHARS) return tooLong;
  return { url: u.href, error: null };
}

export function checkX(raw: string): SocialCheck {
  const s = raw.trim();
  if (!s) return none;
  if (s.length > SOCIAL_MAX_CHARS) return tooLong;
  const bad = { url: null, error: "An X handle like @snarkspad, or a link to x.com/snarkspad" };
  let handle = s.replace(/^@/, "");
  if (/[/.]/.test(handle)) {
    const u = httpsUrl(s);
    if (!u || !/^(www\.)?(x|twitter)\.com$/i.test(u.hostname)) return bad;
    handle = u.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return bad;
  return { url: `https://x.com/${handle}`, error: null };
}

export function checkTelegram(raw: string): SocialCheck {
  const s = raw.trim();
  if (!s) return none;
  if (s.length > SOCIAL_MAX_CHARS) return tooLong;
  const bad = { url: null, error: "A Telegram name like @snarkspad, or a link to t.me/snarkspad" };
  let name = s.replace(/^@/, "");
  if (/[/.]/.test(name)) {
    const u = httpsUrl(s);
    if (!u || !/^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname)) return bad;
    name = u.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  if (!/^[A-Za-z0-9_]{5,32}$/.test(name)) return bad;
  return { url: `https://t.me/${name}`, error: null };
}

const CHECKS: Record<SocialKey, (raw: string) => SocialCheck> = { website: checkWebsite, x: checkX, telegram: checkTelegram };

export type SocialsResult = { ok: true; socials: Socials } | { ok: false; field: string };

/**
 * The `socials` of a launch request: absent or null is none; an object with only the keys website, x and telegram, each a string that passes its
 * check (an empty string is "not given"). `field` of a refusal names the offender (`socials`, or `socials.x`); the value is never echoed.
 */
export function parseSocials(input: unknown): SocialsResult {
  if (input === undefined || input === null) return { ok: true, socials: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, field: "socials" };
  const given = input as Record<string, unknown>;
  if (Object.keys(given).some((k) => !(SOCIAL_KEYS as readonly string[]).includes(k))) return { ok: false, field: "socials" };
  const socials: Socials = {};
  for (const key of SOCIAL_KEYS) {
    const value = given[key];
    if (value === undefined || value === null || value === "") continue;
    const checked = typeof value === "string" ? CHECKS[key](value) : none;
    if (!checked.url) return { ok: false, field: `socials.${key}` };
    socials[key] = checked.url;
  }
  return { ok: true, socials };
}

/** The links of a stored coin: what the row's JSON holds, keeping only known keys with an https address. A damaged cell is no links, never an error. */
export function readStoredSocials(stored: string | null | undefined): Socials {
  if (!stored) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Socials = {};
  for (const key of SOCIAL_KEYS) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === "string" && v.startsWith("https://") && v.length <= SOCIAL_MAX_CHARS) out[key] = v;
  }
  return out;
}
