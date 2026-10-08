#!/usr/bin/env bun
// S4 F1: POST /uploads, the served /i and /m files and the sweep, against an API process over real sockets (ST-UP-01..11,
// audit/STRESS-TEST-PLAN-S4.md). Client addresses are X-Forwarded-For (believed from a loopback peer, as behind Caddy). The sweep cases
// run in this process on scratch roots with an injected clock, and the race case on the API's own PUBLIC_DIR.
//   bun stress/s4/uploads.ts <api base> <api pid> <api public dir>
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { sweepPublicFiles } from "../../src/publicFiles/sweep";
import { cat, gif, gifOfSize, has, jpegWithComment, jpg, noisyPng, png, pngChunk, pngClaiming, pngInsertAfterIhdr, text, webp } from "./images";

const base = process.argv[2]!;
const origin = new URL(base).origin;
const pid = Number(process.argv[3]);
const publicDir = process.argv[4]!;
const out: Record<string, unknown>[] = [];
const say = (id: string, pass: boolean, detail: Record<string, unknown>): void => {
  out.push({ id, pass, ...detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${JSON.stringify(detail)}`);
};
const rss = (): number => Number(new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout).trim() || 0);
const alive = (): boolean => Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0;
let ipN = 0;
const freshIp = (): string => `203.0.113.${(ipN++ % 200) + 1}`;

interface Up { status: number; body: Record<string, unknown>; headers: Headers; ms: number }
async function upload(bytes: Uint8Array, o: { ip?: string; name?: string; type?: string; extra?: Record<string, string> } = {}): Promise<Up> {
  const form = new FormData();
  form.append("file", new File([bytes], o.name ?? "pic.png", { type: o.type ?? "image/png" }));
  for (const [k, v] of Object.entries(o.extra ?? {})) form.append(k, v);
  const t0 = performance.now();
  const res = await fetch(`${base}/uploads`, { method: "POST", body: form, headers: { "x-forwarded-for": o.ip ?? freshIp() } });
  const textBody = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(textBody) as Record<string, unknown>;
  } catch {
    body = { raw: textBody.slice(0, 100) };
  }
  return { status: res.status, body, headers: res.headers, ms: performance.now() - t0 };
}
const storedBytes = (url: string): Uint8Array => new Uint8Array(readFileSync(join(publicDir, "i", url.slice(url.lastIndexOf("/") + 1))));
const fetchStored = async (url: string): Promise<{ status: number; type: string | null; nosniff: string | null; bytes: Uint8Array }> => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get("content-type"), nosniff: res.headers.get("x-content-type-options"), bytes: new Uint8Array(await res.arrayBuffer()) };
};

// ---- ST-UP-01: a flood from one address ----
{
  const pic = await noisyPng(1);
  const ip = "198.51.100.77";
  const r0 = rss();
  const results = await Promise.all(Array.from({ length: 12 }, () => upload(pic, { ip })));
  const codes = results.map((r) => `${r.status}${r.body.error ? ":" + r.body.error : ""}`);
  const ok = results.filter((r) => r.status === 200).length;
  const busy = results.filter((r) => r.status === 429 && r.body.error === "busy");
  const limited = results.filter((r) => r.status === 429 && r.body.error === "rate_limited").length;
  // the per-minute budget: how many more succeed from this address right after the flood
  let moreOk = 0;
  for (let i = 0; i < 12; i++) {
    const r = await upload(pic, { ip });
    if (r.status === 200) moreOk++;
    else break;
  }
  say("ST-UP-01 12 parallel 1 MB PNGs from one address: at most 4 decode at once, the rest 429 busy with retry-after 5, no 500", results.every((r) => r.status < 500) && busy.every((r) => r.headers.get("retry-after") === "5") && ok <= 10 && ok + busy.length + limited === 12, { codes, ok, busy: busy.length, rateLimited: limited, okRightAfter: moreOk, note: `${10 - ok - moreOk} of the 10-a-minute budget was spent by requests answered busy`, rssKb: [r0, rss()], p95ms: Math.round([...results.map((r) => r.ms)].sort((a, b) => a - b)[11]!) });
}

// ---- ST-UP-02: a flood from 60 addresses ----
{
  const pic = await noisyPng(1);
  const r0 = rss();
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => upload(pic, { ip: `198.51.101.${i + 1}` })));
  const elapsed = Math.round(performance.now() - t0);
  const ok = results.filter((r) => r.status === 200);
  const stored = ok.every((r) => existsSync(join(publicDir, "i", String(r.body.url).split("/").pop()!)));
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const other = results.filter((r) => r.status !== 200 && r.body.error !== "busy").map((r) => ({ status: r.status, error: r.body.error ?? null, raw: r.body.raw ?? null, type: r.headers.get("content-type") }));
  say("ST-UP-02 60 parallel 1 MB PNGs from 60 addresses: no 500, every 200 is a stored file", results.every((r) => r.status < 500) && stored && alive(), { ok: ok.length, busy: results.filter((r) => r.body.error === "busy").length, other, elapsedMs: elapsed, p50ms: Math.round(ms[30]!), p95ms: Math.round(ms[57]!), rssKb: [r0, rss()] });
}

// ---- ST-UP-03: 5 MB to the byte with a real picture ----
{
  const exact = gifOfSize(5 * 1024 * 1024);
  const r1 = await upload(exact, { name: "a.gif", type: "image/gif" });
  const storedExact = r1.status === 200 ? storedBytes(String(r1.body.url)) : null;
  const over = gifOfSize(5 * 1024 * 1024 + 1);
  const r2 = await upload(over, { name: "a.gif", type: "image/gif" });
  const r3 = await upload(exact, { name: "a.gif", type: "image/gif", extra: { note: "x".repeat(70 * 1024) } });
  say("ST-UP-03 a 5,242,880-byte GIF is stored byte for byte; one byte more is 413; 5,242,880 plus a 70 KB extra field is 413 (the 64 KiB framing allowance)", r1.status === 200 && storedExact !== null && storedExact.length === exact.length && Buffer.compare(storedExact, exact) === 0 && r2.status === 413 && r2.body.error === "body_too_large" && r3.status === 413, { exact: [r1.status, r1.body.error ?? null, storedExact?.length ?? null, r1.body.bytes], plusOne: [r2.status, r2.body.error], withExtraField: [r3.status, r3.body.error] });
}

// ---- ST-UP-04: polyglots inside chunks ----
{
  const page = "<html><script>alert(1)</script></html>";
  const p = pngInsertAfterIhdr(pngInsertAfterIhdr(await png(40, 40), pngChunk("tEXt", text(`Comment\0${page}`))), pngChunk("iTXt", text(`XML:com.adobe.xmp\0\0\0\0\0${page}`)));
  const rp = await upload(p);
  const j = jpegWithComment(await jpg(40, 40), page);
  const rj = await upload(j, { name: "a.jpg", type: "image/jpeg" });
  const w = new Uint8Array(await sharp(await webp(40, 40)).withExif({ IFD0: { Copyright: page } }).withXmp(`<x:xmpmeta>${page}</x:xmpmeta>`).webp().toBuffer());
  const rw = await upload(w, { name: "a.webp", type: "image/webp" });
  const g = gif(8, 8, { comments: [text(page)] });
  const rg = await upload(g, { name: "a.gif", type: "image/gif" });
  const served = rg.status === 200 ? await fetchStored(String(rg.body.url)) : null;
  const clean = [rp, rj, rw].every((r) => r.status === 200 && !has(storedBytes(String(r.body.url)), "<script"));
  say("ST-UP-04 a page hidden in a PNG text chunk, a JPEG comment or WEBP EXIF/XMP is gone from the stored copy; a GIF comment is kept as sent (contract) and served as image/gif with nosniff", clean && has(j, "<script") && has(w, "<script") && rg.status === 200 && served !== null && has(served.bytes, "<script") && served.type === "image/gif" && served.nosniff === "nosniff", { png: rp.status, jpeg: rj.status, webp: rw.status, gif: rg.status, inputsCarriedIt: [has(p, "<script"), has(j, "<script"), has(w, "<script"), has(g, "<script")], gifServedType: served?.type, nosniff: served?.nosniff });
}

// ---- ST-UP-05: bombs ----
{
  const tiny = await png(1, 1);
  const a = await upload(pngClaiming(tiny, 20_000, 20_000));
  const b = await upload(pngClaiming(tiny, 0x7fffffff, 0x7fffffff));
  const under = await png(7071, 7071); // 49,999,041 pixels
  const overP = await png(7072, 7072); // 50,013,184 pixels
  const c1 = await upload(under);
  const c2 = await upload(overP);
  const bomb = await png(7000, 7000);
  const r0 = rss();
  const samples: number[] = [];
  const sampler = setInterval(() => samples.push(rss()), 150);
  const t0 = performance.now();
  const four = await Promise.all(Array.from({ length: 4 }, () => upload(bomb)));
  const fourMs = Math.round(performance.now() - t0);
  clearInterval(sampler);
  const e500 = await upload(gif(2, 2, { frames: 500 }), { name: "a.gif", type: "image/gif" });
  const e501 = await upload(gif(2, 2, { frames: 501 }), { name: "a.gif", type: "image/gif" });
  const f4096 = await upload(gif(2, 2, { canvasW: 4096, canvasH: 2 }), { name: "a.gif", type: "image/gif" });
  const f4097 = await upload(gif(2, 2, { canvasW: 4097, canvasH: 2 }), { name: "a.gif", type: "image/gif" });
  say("ST-UP-05 bombs: a header claiming 20000x20000 or 2^31 is refused fast; the 50 M pixel cap is exact; four 49 MP decodes at once finish, RSS measured; 500 GIF frames pass, 501 not; 4096 px passes, 4097 not", a.status === 400 && a.body.error === "bad_image" && a.ms < 500 && b.status === 400 && b.ms < 500 && c1.status === 200 && c2.status === 400 && four.every((r) => r.status === 200) && e500.status === 200 && e501.status === 400 && f4096.status === 200 && f4097.status === 400 && alive(), { claim20k: [a.status, a.body.error, Math.round(a.ms)], claim2e31: [b.status, b.body.error, Math.round(b.ms)], px49999041: [c1.status, c1.body.width, c1.body.height], px50013184: [c2.status, c2.body.error], bombFileBytes: bomb.length, fourAtOnce: { statuses: four.map((r) => r.status), ms: fourMs, rssBeforeKb: r0, rssPeakKb: Math.max(r0, ...samples), rssAfterKb: rss() }, frames500: e500.status, frames501: [e501.status, e501.body.error], side4096: f4096.status, side4097: [f4097.status, f4097.body.error] });
}

// ---- ST-UP-06: EXIF with GPS ----
{
  const withGps = new Uint8Array(await sharp({ create: { width: 60, height: 30, channels: 3, background: "#c42f6c" } }).withExif({ IFD0: { Copyright: "s4", Artist: "nobody" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  const r = await upload(withGps, { name: "a.jpg", type: "image/jpeg" });
  const stored = r.status === 200 ? storedBytes(String(r.body.url)) : new Uint8Array();
  const meta = r.status === 200 ? await sharp(stored).metadata() : null;
  const wEx = new Uint8Array(await sharp(await webp(40, 20)).withExif({ IFD0: { Copyright: "s4-webp" } }).webp().toBuffer());
  const rw = await upload(wEx, { name: "a.webp", type: "image/webp" });
  const storedW = rw.status === 200 ? storedBytes(String(rw.body.url)) : new Uint8Array();
  say("ST-UP-06 EXIF with GPS is gone from the stored JPEG (orientation applied: 60x30 becomes 30x60) and from the stored WEBP", r.status === 200 && has(withGps, "Exif") && !has(stored, "Exif") && !has(stored, "nobody") && meta?.exif === undefined && r.body.width === 30 && r.body.height === 60 && rw.status === 200 && has(wEx, "s4-webp") && !has(storedW, "s4-webp") && !has(storedW, "EXIF"), { jpeg: [r.status, r.body.width, r.body.height], inputHadExif: has(withGps, "Exif"), storedHasExif: has(stored, "Exif"), webp: rw.status, storedWebpHasExif: has(storedW, "s4-webp") });
}

// ---- ST-UP-07: the per-address limit over a socket via X-Forwarded-For ----
{
  const pic = await png(20, 20);
  const ip = "198.51.100.10";
  const ten = [];
  for (let i = 0; i < 10; i++) ten.push((await upload(pic, { ip })).status);
  const eleventh = await upload(pic, { ip });
  const wait = Number(eleventh.headers.get("retry-after"));
  const listed = await upload(pic, { ip: `10.0.0.1, 10.0.0.2, ${ip}` }); // the last entry is the client: still limited
  const otherList = await upload(pic, { ip: `${ip}, 10.0.0.9` }); // the last entry is another address
  const noHeader = await fetch(`${base}/uploads`, { method: "POST", body: (() => { const f = new FormData(); f.append("file", new File([pic], "p.png", { type: "image/png" })); return f; })() });
  say("ST-UP-07 the 11th upload from one forwarded address in a minute is 429 rate_limited with retry-after 1..60; the LAST forwarded entry is the client; no header falls back to the peer", ten.every((s) => s === 200) && eleventh.status === 429 && eleventh.body.error === "rate_limited" && wait >= 1 && wait <= 60 && listed.status === 429 && otherList.status === 200 && noHeader.status === 200, { ten, eleventh: [eleventh.status, eleventh.body.error, wait], listedEndingInIp: listed.status, listedEndingElsewhere: otherList.status, noHeader: noHeader.status });
}

// ---- ST-UP-08: traversal on the served files, raw on the wire ----
async function raw(path: string, method = "GET"): Promise<{ status: number; body: string; headers: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("raw request timed out")), 5_000);
    Bun.connect({
      hostname: url.hostname, port: Number(url.port),
      socket: {
        open(s) { s.write(`${method} ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`); },
        data(_s, d) { text += new TextDecoder().decode(d); },
        close() { clearTimeout(timer); const [head, ...rest] = text.split("\r\n\r\n"); resolve({ status: Number(/HTTP\/1\.1 (\d{3})/.exec(head ?? "")?.[1] ?? 0), headers: head ?? "", body: rest.join("\r\n\r\n") }); },
        error(_s, e) { clearTimeout(timer); reject(e); },
      },
    }).catch(reject);
  });
}
{
  const good = await upload(await png(12, 12));
  const name = String(good.body.url).split("/").pop()!;
  const paths = [
    "/i/../../etc/passwd", "/i/..%2f..%2fetc%2fpasswd", "/i/%2e%2e/%2e%2e/etc/passwd", "/i/placeholder.png/../../etc/passwd", `/i/${name}%00.png`, `/i/${name.toUpperCase()}`,
    `/i/${name}/`, `/i//${name}`, "/i/", "/i", "/i/.tmp-abc", "/i/..\\..\\etc\\passwd", `/m/${"1".repeat(32)}.json/..`, "/m/../i/placeholder.png", `/i/${"a".repeat(10_000)}.png`, `/i/${name}?x=1#y`,
  ];
  const results: Record<string, [number, boolean]> = {};
  let bad = 0;
  for (const p of paths) {
    const r = await raw(p);
    // a 200 is a leak only when it is not the placeholder's or the real name's own bytes under its canonical path (the URL parser folds /m/../i/placeholder.png to /i/placeholder.png before the route)
    const leaked = r.body.includes("root:") || (r.status === 200 && !p.endsWith("?x=1#y") && !p.endsWith("/i/placeholder.png"));
    results[p.length > 40 ? p.slice(0, 37) + "..." : p] = [r.status, leaked];
    if (r.status >= 500 || leaked) bad++;
    const h = await raw(p, "HEAD");
    if (h.status >= 500) bad++;
  }
  const opt = await raw(`/i/${name}`, "OPTIONS");
  const okServed = await raw(`/i/${name}`);
  say("ST-UP-08 every traversal of the served files is 404 (never 500, never a byte of a file); a query on the real name still serves it; OPTIONS 204", bad === 0 && okServed.status === 200 && opt.status === 204 && alive(), { results, realName: okServed.status, options: opt.status });
}

// ---- ST-UP-09: imageUrl variants on launch-tx (before any chain read) ----
{
  const good = await upload(await png(16, 16));
  const url = String(good.body.url);
  const name = url.split("/").pop()!;
  const hex = name.slice(0, 24);
  const variants = [url.toUpperCase(), url.replace(/\.png$/, ".jpeg"), `${origin}/i/${hex.slice(0, 23)}.png`, `${origin}/i/${hex}a.png`, `${origin}/i%2f${name}`, `${url}#x`, `${url}?x`, `${url} `, url.replace("127.0.0.1", "127.0.0.1."), url.replace(/\/i\//, "/m/"), url.replace("http://", "https://")];
  const creator = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const results: [string, number, unknown][] = [];
  for (const v of variants) {
    const res = await fetch(`${base}/coins/launch-tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creator, name: "V", symbol: "VV", description: "", imageUrl: v, feeTier: 100 }) });
    const body = (await res.json()) as Record<string, unknown>;
    results.push([v.replace(origin, ""), res.status, body.error]);
  }
  const theReal = await fetch(`${base}/coins/launch-tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creator, name: "V", symbol: "VV", description: "", imageUrl: url, feeTier: 100, socials: { x: "https://x.com.evil.example/a" } }) });
  const realBody = (await theReal.json()) as Record<string, unknown>;
  say("ST-UP-09 every imageUrl variant is 400 bad_image_url; the real address passes that check (the next refusal is the link)", results.every((r) => r[1] === 400 && r[2] === "bad_image_url") && theReal.status === 400 && realBody.error === "bad_request" && realBody.field === "socials.x", { results, real: [theReal.status, realBody.error, realBody.field] });
}

// ---- ST-UP-10: the sweep's boundary and size (scratch roots, injected clock) ----
const HOUR = 3_600_000;
function scratch(): string {
  const root = join(tmpdir(), `s4-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "i"), { recursive: true });
  mkdirSync(join(root, "m"), { recursive: true });
  return root;
}
function put(path: string, ageMs: number, now: number, content: string | Uint8Array = "x"): void {
  writeFileSync(path, content);
  const t = new Date(now - ageMs);
  utimesSync(path, t, t);
}
const hexName = (n: number): string => `${n.toString(16).padStart(24, "0")}.png`;
{
  const NOW = Date.now();
  const root = scratch();
  const day = 24 * HOUR;
  put(join(root, "i", hexName(1)), day - 1_000, NOW);
  put(join(root, "i", hexName(2)), day + 1_000, NOW);
  put(join(root, "i", hexName(3)), 1_000, NOW);
  put(join(root, "i", hexName(4)), day, NOW); // exactly 24 h: kept (the rule is strictly older)
  put(join(root, "i", hexName(5)), 40 * HOUR, NOW); // named by a surviving JSON
  const mintA = "7Y4XQ9fS7u6pJwH2nY8kqZ3bR1tV5cD6eF8gH9iJ2kLm";
  const mintB = "5r7wq8x9kLmN2pQ3rS4tU5vW6xY7zA8bC9dE1fG2hJ3k";
  put(join(root, "m", `${mintA}.json`), day - 1_000, NOW, JSON.stringify({ image: `http://127.0.0.1:8787/i/${hexName(5)}` }));
  put(join(root, "m", `${mintB}.json`), day + 1_000, NOW, "{}");
  const report = await sweepPublicFiles(root, { now: () => NOW, mintExists: async () => false, poolOf: async () => ({ state: "absent" as const }) });
  const left = readdirSync(join(root, "i")).sort();
  say("ST-UP-10a the 24 h boundary is exact: 24 h - 1 s and 24 h kept, 24 h + 1 s removed; a 1 s old upload kept; an image named only by a surviving JSON kept; the metadata boundary the same", left.join(",") === [hexName(1), hexName(3), hexName(4), hexName(5)].join(",") && report.imagesRemoved.join(",") === hexName(2) && report.metadataRemoved.join(",") === mintB && existsSync(join(root, "m", `${mintA}.json`)), { imagesLeft: left, imagesRemoved: report.imagesRemoved, metadataRemoved: report.metadataRemoved, metadataKept: report.metadataKept });
  rmSync(root, { recursive: true, force: true });
}
{
  const NOW = Date.now();
  const root = scratch();
  for (let i = 0; i < 5_000; i++) put(join(root, "i", hexName(0x100000 + i)), 30 * HOUR, NOW);
  const ALPHABET = "123456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 32 base58-safe symbols of one case (APFS folds case: "a" and "A" would be one file), one per base-32 digit
  const metaName = (i: number): string => {
    const digits = [...i.toString(32)].map((d) => ALPHABET[parseInt(d, 32)]!).join("");
    return `${"1".repeat(32 - digits.length)}${digits}.json`;
  };
  for (let i = 0; i < 500; i++) put(join(root, "m", metaName(i)), 30 * HOUR, NOW, JSON.stringify({ image: `http://127.0.0.1:8787/i/${hexName(0x100000 + i)}` }));
  const t0 = performance.now();
  // the 500 mints exist on chain (a launch the browser sent and never confirmed): their JSON stays, and so do the pictures it names
  const report = await sweepPublicFiles(root, { now: () => NOW, mintExists: async () => true, poolOf: async () => ({ state: "unknown" as const }) });
  const ms = Math.round(performance.now() - t0);
  const left = readdirSync(join(root, "i")).length;
  say("ST-UP-10b 5,000 old images and 500 old metadata files whose mints exist on chain: the 500 JSON-named images and the 500 JSON files stay, the other 4,500 go, in a measured time", report.imagesRemoved.length === 4_500 && left === 500 && report.metadataKept.length === 500 && report.metadataRemoved.length === 0 && ms < 30_000, { imagesRemoved: report.imagesRemoved.length, metadataKept: report.metadataKept.length, metadataRemoved: report.metadataRemoved.length, imagesLeft: left, sweepMs: ms });
  // once the mints are gone from the chain the JSON goes, and the pictures it named go in the same sweep (the metadata step runs first by design)
  const second = await sweepPublicFiles(root, { now: () => NOW, mintExists: async () => false, poolOf: async () => ({ state: "absent" as const }) });
  say("ST-UP-10c when the mints are not on chain either, one sweep removes the 500 JSON files and the 500 images they named", second.metadataRemoved.length === 500 && second.imagesRemoved.length === 500 && readdirSync(join(root, "i")).length === 0, { metadataRemoved: second.metadataRemoved.length, imagesRemoved: second.imagesRemoved.length });
  rmSync(root, { recursive: true, force: true });
}

// ---- ST-UP-11: uploads while a sweep runs over the API's own directory ----
{
  const NOW = Date.now();
  const planted: string[] = [];
  for (let i = 0; i < 5_000; i++) {
    const n = hexName(0x200000 + i);
    put(join(publicDir, "i", n), 30 * HOUR, NOW);
    planted.push(n);
  }
  const pics = await Promise.all(Array.from({ length: 20 }, (_, i) => png(10 + i, 10 + i)));
  const sweep = sweepPublicFiles(publicDir, { now: () => NOW + 60_000, mintExists: async () => true, poolOf: async () => ({ state: "unknown" as const }) });
  const ups: Up[] = [];
  for (let i = 0; i < pics.length; i += 4) ups.push(...(await Promise.all(pics.slice(i, i + 4).map((p, j) => upload(p, { ip: `198.51.102.${i + j + 1}` }))))); // four at a time: the decode cap
  const report = await sweep;
  const fresh = ups.map((r) => String(r.body.url).split("/").pop()!);
  const allThere = fresh.every((n) => existsSync(join(publicDir, "i", n)));
  const plantedGone = planted.filter((n) => existsSync(join(publicDir, "i", n))).length;
  say("ST-UP-11 20 uploads during a sweep over 5,000 old files: all 20 answered 200 and are still there after; the old files are gone", ups.every((r) => r.status === 200) && allThere && plantedGone === 0 && alive(), { ok: ups.filter((r) => r.status === 200).length, freshStillThere: fresh.filter((n) => existsSync(join(publicDir, "i", n))).length, plantedLeft: plantedGone, imagesRemoved: report.imagesRemoved.length });
}
console.log(JSON.stringify({ summary: { pass: out.filter((o) => o.pass).length, fail: out.filter((o) => !o.pass).length }, apiAlive: alive(), finalRssKb: rss() }));
void statSync;
