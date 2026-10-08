// Hostile-input pass on the HTTP API docs/API.md "Errors"). Every case
// must answer a clean 4xx with the contract's error code: never a 500, never a
// stack trace, never a full Zcash address in any response body. Runs against
// the real fetch handler (no port) and the test sqlite file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import sharp from "sharp";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { handleRequest } from "../src/api";
import { uploadLimiter } from "../src/api/uploadRoutes";
import { isPubkey } from "../src/api/validate";
import { config } from "../src/config";
import * as db from "../src/db";
import { optinMessage, optoutMessage, shieldedViewMessage } from "../src/optin/message";
import { KEEPER_PUBKEY_META, SQUADS_MEMBERS_META } from "../src/holders";

const HAS_DEVTOOL = existsSync(config.paths.zcashDevtoolBin);
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const B = "http://pad.test/api";

function derive(network: "regtest" | "main"): { ua: string; taddr: string } {
  const proc = Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "derive-address", "--mnemonic", MNEMONIC, "--network", network]);
  const out = new TextDecoder().decode(proc.stdout);
  return { ua: /Unified Address:\s*(\S+)/.exec(out)![1]!, taddr: /Transparent Address:\s*(\S+)/.exec(out)![1]! };
}

const REG = HAS_DEVTOOL ? derive("regtest") : { ua: "", taddr: "" };
const MAIN = HAS_DEVTOOL ? derive("main") : { ua: "", taddr: "" };
// ZIP-32 test-vector style Sapling-only mainnet address (no Orchard receiver).
const SAPLING_ONLY = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly";

const FAKE_MINT = Keypair.generate().publicKey.toBase58();
const FULL_ADDRESSES = () => [REG.ua, MAIN.ua].filter(Boolean);

// POST /coins/launch-tx is limited to 10 calls a minute per client address (S4-05, src/api/launchLimits.ts): a table of hostile bodies is not one client, so each launch-tx call
// comes from its own address (as the upload cases below do), and nothing in this file hits that limit by accident.
let launchIp = 0;
const nextLaunchIp = () => `198.51.100.${(launchIp++ % 250) + 1}`;

async function call(method: string, path: string, body?: string | Uint8Array | ReadableStream, headers: Record<string, string> = {}) {
  const res = await handleRequest(
    new Request(B + path, { method, body, headers: { "content-type": "application/json", ...headers }, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit),
    path === "/coins/launch-tx" ? { ip: nextLaunchIp() } : undefined,
  );
  const text = await res.text();
  // The invariants every hostile response must hold.
  expect(res.status).toBeLessThan(500);
  expect(text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:/);
  for (const a of FULL_ADDRESSES()) expect(text).not.toContain(a);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}
const post = (path: string, obj: unknown) => call("POST", path, JSON.stringify(obj));

function sign(kp: Keypair, message: string): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
}
async function nonceFor(wallet: string): Promise<string> {
  const r = await call("GET", `/optin/nonce?wallet=${wallet}`);
  expect(r.status).toBe(200);
  return r.body.nonce as string;
}

beforeAll(() => {
  db.upsertCoin({
    mint: FAKE_MINT, name: "Fake", symbol: "FAKE", imageUrl: "", description: "", creator: FAKE_MINT,
    createdAt: new Date().toISOString(), feeBps: 300, poolId: Keypair.generate().publicKey.toBase58(), mintDecimals: 6, status: "launched",
  });
});
afterAll(() => {
  db.getDb().query("DELETE FROM coins WHERE mint = $m").run({ $m: FAKE_MINT });
});

describe("malformed bodies", () => {
  const routes: [string, string][] = [
    ["POST", "/optin"], ["DELETE", "/optin"], ["POST", "/optin/status"], ["POST", "/coins/launch-tx"], ["POST", "/coins/confirm"],
    ["POST", `/coins/${FAKE_MINT}/trade-tx`], ["POST", `/coins/${FAKE_MINT}/trade-confirm`],
  ];
  for (const [m, p] of routes) {
    test(`${m} ${p}: broken JSON, non-object JSON, invalid utf-8 -> 400 bad_json`, async () => {
      for (const b of ["{bad", "", "[1,2]", "null", '"str"', "42", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]) {
        const r = await call(m, p, b);
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("bad_json");
      }
    });
  }

  test("huge body with content-length -> 413 body_too_large", async () => {
    const big = "a".repeat(2_000_000);
    const r = await call("POST", "/optin", big);
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("body_too_large");
  });

  test("huge streamed body without content-length -> 413 body_too_large", async () => {
    const chunk = new TextEncoder().encode("a".repeat(8192));
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 400) c.enqueue(chunk); else c.close(); } });
    const r = await call("POST", "/coins/launch-tx", stream);
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("body_too_large");
  });
});

describe("wrong types and bad wallets", () => {
  const kp = Keypair.generate();
  const w = kp.publicKey.toBase58();

  test("opt-in field types", async () => {
    expect((await post("/optin", { wallet: 123, zcashAddress: REG.ua, nonce: "x", signature: "y" })).body.error).toBe("bad_wallet");
    expect((await post("/optin", { wallet: w, zcashAddress: { a: 1 }, nonce: "x", signature: "y" })).body.error).toBe("bad_address");
    expect((await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce: 7, signature: "y" })).body.error).toBe("bad_request");
    expect((await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce: "x", signature: ["y"] })).body.error).toBe("invalid_signature");
    expect((await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce: "x", signature: "0OIl" })).body.error).toBe("invalid_signature");
    expect((await post("/optin", {})).body.error).toBe("bad_wallet");
    expect((await call("DELETE", "/optin", JSON.stringify({ wallet: w, nonce: "x", signature: 5 }))).body.error).toBe("invalid_signature");
  });

  test("signed-read field types (v2.9)", async () => {
    expect((await post("/optin/status", { wallet: 123, nonce: "x", signature: "y" })).body.error).toBe("bad_wallet");
    expect((await post("/optin/status", { nonce: "x", signature: "y" })).body.error).toBe("bad_wallet");
    expect((await post("/optin/status", { wallet: w, nonce: 7, signature: "y" })).body.error).toBe("bad_request");
    expect((await post("/optin/status", { wallet: w, nonce: "", signature: "y" })).body.error).toBe("bad_request");
    expect((await post("/optin/status", { wallet: w, nonce: "x".repeat(65), signature: "y" })).body.error).toBe("bad_request");
    expect((await post("/optin/status", { wallet: w, nonce: "x", signature: ["y"] })).body.error).toBe("invalid_signature");
    expect((await post("/optin/status", { wallet: w, nonce: "x", signature: "0OIl" })).body.error).toBe("invalid_signature");
    expect((await post("/optin/status", { wallet: w, nonce: "x" })).body.error).toBe("invalid_signature");
    expect((await post("/optin/status", {})).body.error).toBe("bad_wallet");
  });

  // A valid key with one character appended, from fixed keys (never a random one): a 43-character key plus a
  // character can decode to a DIFFERENT valid 32-byte key (1.4% of random keys), which the API rightly accepts.
  const key43 = new PublicKey(new Uint8Array(32).fill(9)).toBase58(); // + "x" decodes to 33 bytes
  const key44 = new PublicKey(new Uint8Array(32).fill(255)).toBase58(); // + "x" is 45 characters

  test("a 43-character key plus a character can be another valid key, so the junk-suffix cases use fixed keys", () => {
    const small = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
    expect([small.length, key43.length, key44.length]).toEqual([43, 43, 44]);
    expect(isPubkey(small + "x")).toBe(true); // why a random w + "x" failed the test below once in ~70 runs
  });

  test("wallet strings that are not a canonical pubkey -> 400 bad_wallet", async () => {
    for (const bad of ["", "abc", "0".repeat(44), "--help", "$(id)", "../../etc/passwd", "1".repeat(45), key43 + "x", key44 + "x"]) {
      expect((await post("/optin", { wallet: bad, zcashAddress: REG.ua, nonce: "x", signature: "y" })).body.error).toBe("bad_wallet");
      const g = await call("GET", `/optin/nonce?wallet=${encodeURIComponent(bad)}`);
      expect(g.status).toBe(400);
      expect(g.body.error).toBe("bad_wallet");
      const s = await post("/optin/status", { wallet: bad, nonce: "x", signature: "y" });
      expect(s.status).toBe(400);
      expect(s.body.error).toBe("bad_wallet");
      if (bad) expect((await call("GET", `/optin/${encodeURIComponent(bad)}`)).status).toBe(404); // there is no unsigned status route any more (v2.9)
    }
  });

  test("launch-tx field validation (all refused before touching the chain)", async () => {
    const ok = { creator: w, name: "Test", symbol: "TEST", description: "", imageUrl: "", feeBps: 200 };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ok, creator: "nope" }, "bad_wallet"],
      [{ ...ok, name: 5 }, "bad_request"],
      [{ ...ok, name: "x".repeat(33) }, "bad_request"],
      [{ ...ok, name: "a\u0000b" }, "bad_request"],
      [{ ...ok, name: "a\ud800b" }, "bad_request"], // a lone surrogate half: JSON spells it, the chain would write U+FFFD and the metadata file keep the escape (S4 ST-MD-03)
      [{ ...ok, description: "a\udc00b" }, "bad_request"],
      [{ ...ok, symbol: "B@D" }, "bad_request"],
      [{ ...ok, feeBps: "200" }, "bad_request"],
      [{ ...ok, feeBps: 1e9 }, "bad_request"],
      [{ ...ok, feeBps: 150.5 }, "bad_request"],
      [{ ...ok, description: "d".repeat(281) }, "bad_request"],
      [{ ...ok, imageUrl: "data:image/png;base64,AAAA" }, "bad_image_url"],
      [{ ...ok, imageUrl: "javascript:alert(1)" }, "bad_image_url"],
      [{ ...ok, imageUrl: "https://x.test/" + "a".repeat(200) }, "bad_request"],
      [{ ...ok, initialBuyZec: "-1" }, "bad_amount"],
      [{ ...ok, initialBuyZec: 100 }, "bad_amount"],
      [{ ...ok, initialBuyZec: "18446744073709551616" }, "bad_amount"],
    ];
    for (const [body, code] of cases) {
      const r = await post("/coins/launch-tx", body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(code);
    }
  });

  test("launch confirm: bad sig -> bad_request, unknown mint -> 404 unknown_mint", async () => {
    expect((await post("/coins/confirm", { sig: "zz", mint: FAKE_MINT })).body.error).toBe("bad_request");
    const sig = bs58.encode(new Uint8Array(64).fill(7));
    const r = await post("/coins/confirm", { sig, mint: Keypair.generate().publicKey.toBase58() });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("unknown_mint");
    expect((await post("/coins/confirm", { sig, mint: "not-a-mint" })).body.error).toBe("unknown_mint");
  });
});

describe("trade-tx amounts and mints", () => {
  const w = Keypair.generate().publicKey.toBase58();
  const tradePath = `/coins/${FAKE_MINT}/trade-tx`;

  test("negative, zero, fractional, exponent, hex, overflow and non-string amounts -> 400 bad_amount", async () => {
    const bad: unknown[] = ["-5", "0", "00", "1.5", "1e9", "0x10", " 5", "5 ", "18446744073709551616", "99999999999999999999999", "", 5, -5, 1e30, null, true, {}, []];
    for (const amount of bad) {
      const r = await post(tradePath, { wallet: w, side: "buy", amount, slippageBps: 100 });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_amount");
    }
  });

  test("bad side, slippage, wallet", async () => {
    expect((await post(tradePath, { wallet: w, side: "hodl", amount: "5" })).body.error).toBe("bad_request");
    expect((await post(tradePath, { wallet: w, side: "buy", amount: "5", slippageBps: -1 })).body.error).toBe("bad_request");
    expect((await post(tradePath, { wallet: w, side: "buy", amount: "5", slippageBps: 10001 })).body.error).toBe("bad_request");
    expect((await post(tradePath, { wallet: w, side: "buy", amount: "5", slippageBps: 1.5 })).body.error).toBe("bad_request");
    expect((await post(tradePath, { wallet: "x", side: "buy", amount: "5" })).body.error).toBe("bad_wallet");
  });

  test("unknown mint on every mint route -> 404 unknown_mint", async () => {
    const unknown = Keypair.generate().publicKey.toBase58();
    for (const m of [unknown, "garbage", "..%2F..%2Fetc", "%E0%A4%A", encodeURIComponent("$(id)")]) {
      for (const [method, path, body] of [
        ["GET", `/coins/${m}`, undefined],
        ["POST", `/coins/${m}/trade-tx`, JSON.stringify({ wallet: w, side: "buy", amount: "5" })],
        ["POST", `/coins/${m}/trade-confirm`, JSON.stringify({ sig: "x" })],
      ] as const) {
        const r = await call(method, path, body);
        expect(r.status).toBe(404);
        expect(r.body.error).toBe("unknown_mint");
      }
    }
  });

  test("unknown route -> 404 not_found", async () => {
    const r = await call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });
});

describe.skipIf(!HAS_DEVTOOL)("opt-in addresses, replay, wrong signer", () => {
  test("option-like and shell-character addresses -> 400 bad_address", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const bad = ["--help", "-h", "--version", "u1abc;rm -rf ~", "$(touch /tmp/pwned)", "`id`", "u1abc|cat", `${REG.ua}\n--help`, `${REG.ua} x`, "u1" + "q".repeat(2100), ""];
    for (const addr of bad) {
      const nonce = await nonceFor(w);
      const r = await post("/optin", { wallet: w, zcashAddress: addr, nonce, signature: sign(kp, optinMessage(w, addr, nonce)) });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_address");
    }
    expect(existsSync("/tmp/pwned")).toBe(false);
  });

  test("t-addr and Sapling-only -> 400 no_orchard_receiver", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    for (const addr of [REG.taddr, MAIN.taddr, SAPLING_ONLY]) {
      const nonce = await nonceFor(w);
      const r = await post("/optin", { wallet: w, zcashAddress: addr, nonce, signature: sign(kp, optinMessage(w, addr, nonce)) });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("no_orchard_receiver");
    }
  });

  test("wrong-network unified address (mainnet u1 on a regtest pad) -> 400 bad_address, address not echoed", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const nonce = await nonceFor(w);
    const r = await post("/optin", { wallet: w, zcashAddress: MAIN.ua, nonce, signature: sign(kp, optinMessage(w, MAIN.ua, nonce)) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_address");
  });

  test("signature from a different wallet -> 400 invalid_signature, and the nonce survives", async () => {
    const owner = Keypair.generate();
    const attacker = Keypair.generate();
    const w = owner.publicKey.toBase58();
    const nonce = await nonceFor(w);
    const forged = await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce, signature: sign(attacker, optinMessage(w, REG.ua, nonce)) });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toBe("invalid_signature");
    // The junk attempt did not burn the owner's nonce.
    const real = await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce, signature: sign(owner, optinMessage(w, REG.ua, nonce)) });
    expect(real.status).toBe(200);
    expect(real.body.ok).toBe(true);

    // Opt-out signed by someone else is refused too.
    const n2 = await nonceFor(w);
    const out = await call("DELETE", "/optin", JSON.stringify({ wallet: w, nonce: n2, signature: sign(attacker, optoutMessage(w, n2)) }));
    expect(out.status).toBe(400);
    expect(out.body.error).toBe("invalid_signature");
  });

  test("replayed nonce -> 400 stale_nonce (opt-in and opt-out)", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const nonce = await nonceFor(w);
    const body = { wallet: w, zcashAddress: REG.ua, nonce, signature: sign(kp, optinMessage(w, REG.ua, nonce)) };
    expect((await post("/optin", body)).status).toBe(200);
    const replay = await post("/optin", body);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("stale_nonce");

    const n2 = await nonceFor(w);
    const outBody = JSON.stringify({ wallet: w, nonce: n2, signature: sign(kp, optoutMessage(w, n2)) });
    expect((await call("DELETE", "/optin", outBody)).status).toBe(200);
    const again = await call("DELETE", "/optin", outBody);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("stale_nonce");

    // A nonce issued to another wallet cannot be used for this one.
    const other = Keypair.generate().publicKey.toBase58();
    const foreign = await nonceFor(other);
    const r = await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce: foreign, signature: sign(kp, optinMessage(w, REG.ua, foreign)) });
    expect(r.body.error).toBe("stale_nonce");
  });

  test("the signed status read returns only the masked address; the unsigned route is gone (v2.9)", async () => {
    const kp = Keypair.generate();
    const w = kp.publicKey.toBase58();
    const nonce = await nonceFor(w);
    expect((await post("/optin", { wallet: w, zcashAddress: REG.ua, nonce, signature: sign(kp, optinMessage(w, REG.ua, nonce)) })).status).toBe(200);
    const unsigned = await call("GET", `/optin/${w}`);
    expect(unsigned.status).toBe(404);
    const readNonce = await nonceFor(w);
    const s = await post("/optin/status", { wallet: w, nonce: readNonce, signature: sign(kp, shieldedViewMessage(w, readNonce)) });
    expect(s.status).toBe(200);
    expect(s.body.optedIn).toBe(true);
    const masked = s.body.zcashAddressMasked as string;
    expect(masked).toContain("…");
    expect(masked.length).toBeLessThan(15);
    expect(REG.ua.startsWith(masked.split("…")[0]!)).toBe(true);
    expect(REG.ua.endsWith(masked.split("…")[1]!)).toBe(true);
  });
});

// ---- POST /uploads (contract v2.7): the coin image from a device. Everything is refused with the contract's code, nothing decodes before the
// first bytes are checked, and the route is paid for in work, so it has a rate limit. Each case uses its own client address (the limit is per address).
describe("uploads", () => {
  const MAX = 5 * 1024 * 1024;
  let ipCounter = 0;
  const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;
  const stored: string[] = [];

  async function upload(bytes: Uint8Array, opts: { name?: string; type?: string; ip?: string; field?: string; extra?: Record<string, string> } = {}) {
    const form = new FormData();
    form.append(opts.field ?? "file", new File([bytes], opts.name ?? "pic.png", { type: opts.type ?? "image/png" }));
    for (const [k, v] of Object.entries(opts.extra ?? {})) form.append(k, v);
    return respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: form }), { ip: opts.ip ?? freshIp() }));
  }

  async function respond(res: Response) {
    const text = await res.text();
    expect(res.status).toBeLessThan(500);
    expect(text).not.toMatch(/\bat .+:\d+:\d+|stack|Error:/);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
  }

  const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: "#c42f6c" } }).png().toBuffer();
  const asBytes = (b: Buffer) => new Uint8Array(b);

  afterAll(() => {
    for (const name of stored) rmSync(join(config.publicFiles.dir, "i", name), { force: true });
  });

  test("a PNG is accepted: { url, width, height, bytes }, the url is this pad's own address of the stored file", async () => {
    const r = await upload(asBytes(await png(2000, 1000)));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["bytes", "height", "url", "width"]);
    expect([r.body.width, r.body.height]).toEqual([1000, 500]);
    const url = r.body.url as string;
    expect(url.startsWith(`${config.publicFiles.baseUrl}/i/`)).toBe(true);
    const name = url.slice(url.lastIndexOf("/") + 1);
    stored.push(name);
    expect(name).toMatch(/^[0-9a-f]{24}\.png$/);
    expect(statSync(join(config.publicFiles.dir, "i", name)).size).toBe(r.body.bytes as number);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("x-pad-mode")).toBe(config.mode);
  });

  test("an SVG sent as pic.png with the type image/png is refused: the first bytes decide, not the name or the type", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const r = await upload(svg, { name: "innocent.png", type: "image/png" });
    expect([r.status, r.body.error, r.body.field]).toEqual([400, "bad_image", "file"]);
  });

  test("HTML, a PDF, plain text and an empty file are refused the same way, whatever they are called", async () => {
    const things: [string, string, Uint8Array][] = [
      ["page.jpg", "image/jpeg", new TextEncoder().encode("<!doctype html><script>alert(1)</script>")],
      ["doc.gif", "image/gif", new TextEncoder().encode("%PDF-1.7\n")],
      ["note.webp", "image/webp", new TextEncoder().encode("hello")],
      ["empty.png", "image/png", new Uint8Array()],
    ];
    for (const [name, type, bytes] of things) {
      const r = await upload(bytes, { name, type });
      expect([r.status, r.body.error]).toEqual([400, "bad_image"]);
    }
  });

  test("a polyglot that begins as a PNG and carries a page after it is stored as a clean picture, without the page", async () => {
    const page = "<html><script>alert(1)</script></html>";
    const r = await upload(new Uint8Array(Buffer.concat([await png(), Buffer.from(page)])));
    expect(r.status).toBe(200);
    const name = (r.body.url as string).split("/").pop()!;
    stored.push(name);
    expect(readFileSync(join(config.publicFiles.dir, "i", name)).includes("<script>")).toBe(false);
  });

  test("a GIF with something after its trailer is refused", async () => {
    const gif = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#fff" } }).gif().toBuffer();
    const r = await upload(new Uint8Array(Buffer.concat([gif, Buffer.from("<script>alert(1)</script>")])), { name: "a.gif", type: "image/gif" });
    expect([r.status, r.body.error]).toEqual([400, "bad_image"]);
  });

  test("the size cap is 5 MB to the byte: exactly 5 MB reaches the picture check, one byte more is 413 body_too_large", async () => {
    const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const exactly = new Uint8Array(MAX);
    exactly.set(head);
    const atCap = await upload(exactly);
    expect([atCap.status, atCap.body.error]).toEqual([400, "bad_image"]); // not a real PNG, but it was read and judged
    const over = new Uint8Array(MAX + 1);
    over.set(head);
    const tooBig = await upload(over);
    expect([tooBig.status, tooBig.body.error]).toEqual([413, "body_too_large"]);
  });

  test("a far larger body is refused before it is read: by its declared length, and when streamed without one", async () => {
    const declared = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(50 * MAX) }, body: "x" }), { ip: freshIp() }));
    expect([declared.status, declared.body.error]).toEqual([413, "body_too_large"]);
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 200) c.enqueue(chunk); else c.close(); } });
    const streamed = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: stream, duplex: "half" } as RequestInit), { ip: freshIp() }));
    expect([streamed.status, streamed.body.error]).toEqual([413, "body_too_large"]);
  });

  test("not multipart, no file field, the file under another name, or two files: 400 bad_request naming `file`", async () => {
    const asJson = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { ip: freshIp() }));
    expect([asJson.status, asJson.body.error, asJson.body.field]).toEqual([400, "bad_request", "file"]);
    const raw = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", headers: { "content-type": "image/png" }, body: await png() }), { ip: freshIp() }));
    expect([raw.status, raw.body.error]).toEqual([400, "bad_request"]);
    const other = await upload(asBytes(await png()), { field: "image" });
    expect([other.status, other.body.error, other.body.field]).toEqual([400, "bad_request", "file"]);
    const two = new FormData();
    two.append("file", new File([await png()], "a.png"));
    two.append("file", new File([await png()], "b.png"));
    const dup = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: two }), { ip: freshIp() }));
    expect([dup.status, dup.body.error]).toEqual([400, "bad_request"]);
    const text = new FormData();
    text.append("file", "just a string, not a file");
    const str = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: text }), { ip: freshIp() }));
    expect([str.status, str.body.error]).toEqual([400, "bad_request"]);
    const broken = await respond(await handleRequest(new Request(`${B}/uploads`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz" }, body: "--zzz\r\nnot a part" }), { ip: freshIp() }));
    expect(broken.status).toBe(400);
  });

  test("a file name with traversal in it is never used: the stored name is the hash", async () => {
    const r = await upload(asBytes(await png(32, 32)), { name: "../../../../etc/passwd.png" });
    expect(r.status).toBe(200);
    const name = (r.body.url as string).split("/").pop()!;
    stored.push(name);
    expect(name).toMatch(/^[0-9a-f]{24}\.png$/);
    expect(existsSync(join(config.publicFiles.dir, "i", name))).toBe(true);
  });

  test("other methods and paths under /uploads are not routes", async () => {
    for (const [method, path] of [["GET", "/uploads"], ["DELETE", "/uploads"], ["PUT", "/uploads"], ["POST", "/uploads/x"]] as const) {
      const r = await respond(await handleRequest(new Request(`${B}${path}`, { method }), { ip: freshIp() }));
      expect([r.status, r.body.error]).toEqual([404, "not_found"]);
    }
  });

  test("the 11th upload from one address inside a minute is 429 rate_limited with retry-after; another address is not affected", async () => {
    uploadLimiter.clear();
    const ip = "198.51.100.77";
    const bytes = asBytes(await png(24, 24));
    for (let i = 0; i < 10; i++) {
      const r = await upload(bytes, { ip });
      expect(r.status).toBe(200);
      if (i === 0) stored.push((r.body.url as string).split("/").pop()!);
    }
    const eleventh = await upload(bytes, { ip });
    expect([eleventh.status, eleventh.body.error]).toEqual([429, "rate_limited"]);
    const wait = Number(eleventh.headers.get("retry-after"));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);
    expect((await upload(bytes, { ip: "198.51.100.78" })).status).toBe(200);
    // garbage counts too: a client cannot burn the decoder with files that are not pictures
    uploadLimiter.clear();
    for (let i = 0; i < 10; i++) expect((await upload(new TextEncoder().encode("not a picture"), { ip })).status).toBe(400);
    expect((await upload(bytes, { ip })).status).toBe(429);
    uploadLimiter.clear();
  });
});

// ---- launch-tx: the image (contract v2.7) and the creator's links. All refused before the chain is touched.
describe("launch-tx: image address and links", () => {
  const w = Keypair.generate().publicKey.toBase58();
  const ok = { creator: w, name: "Test", symbol: "TEST", description: "", feeBps: 200 };
  const BASE = config.publicFiles.baseUrl;
  const NAME = "0123456789abcdef01234567";
  const refused = async (body: Record<string, unknown>) => {
    const r = await post("/coins/launch-tx", { ...ok, ...body });
    expect(r.status).toBe(400);
    return r.body;
  };

  test("an image that is not one of this pad's uploads is bad_image_url: another site, a data: URL, a site path, a metadata address", async () => {
    for (const imageUrl of [
      "https://example.com/pic.png", "http://example.com/pic.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "/mascot.jpg", "mascot.jpg", "ipfs://bafy/pic.png",
      `${BASE}/m/${w}.json`, `${BASE}/pic.png`, `${BASE}/i/pic.png`, `${BASE}/i/`, `${BASE}/i`, `https://evil.example/i/${NAME}.png`, `${BASE}.evil.example/i/${NAME}.png`,
      ` ${BASE}/i/${NAME}.png`, `${BASE}/i/${NAME}.png `, `${BASE}/i/${NAME}.svg`, `${BASE}/i/${NAME.toUpperCase()}.png`, `${BASE}/i/${NAME}.png?x=1`, `${BASE}/i/${NAME}.png#x`,
    ]) {
      expect([imageUrl, (await refused({ imageUrl })).error]).toEqual([imageUrl, "bad_image_url"]);
    }
  });

  test("an upload address for a file this server does not have is bad_image_url (one that was never made, or has been swept)", async () => {
    const body = await refused({ imageUrl: `${BASE}/i/${NAME}.png` });
    expect([body.error, body.field]).toEqual(["bad_image_url", "imageUrl"]);
  });

  test("traversal never reaches the disk: dots, encoded dots and slashes, doubled and backslash separators are all bad_image_url", async () => {
    for (const imageUrl of [
      `${BASE}/i/../${NAME}.png`, `${BASE}/i/%2e%2e/${NAME}.png`, `${BASE}/i/%2e%2e%2f${NAME}.png`, `${BASE}/i/..%2f..%2fetc%2fpasswd`, `${BASE}/i//${NAME}.png`,
      `${BASE}/i/${NAME}.png/../../x`, `${BASE}/i/..\\..\\${NAME}.png`, `${BASE}/i/${NAME}.png%00.png`, `${BASE}/i/./${NAME}.png`, `${BASE}/i/%2F${NAME}.png`,
    ]) {
      expect([imageUrl, (await refused({ imageUrl })).error]).toEqual([imageUrl, "bad_image_url"]);
    }
  });

  test("an upload address that exists passes the image check: the refusal that follows is the link, so the order of checks is proven", async () => {
    uploadLimiter.clear();
    const bytes = new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: "#c42f6c" } }).png().toBuffer());
    const form = new FormData();
    form.append("file", new File([bytes], "a.png", { type: "image/png" }));
    const up = (await (await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: form }), { ip: "192.0.2.201" })).json()) as { url: string };
    const body = await refused({ imageUrl: up.url, socials: { x: "https://x.com.evil.example/a" } });
    expect([body.error, body.field]).toEqual(["bad_request", "socials.x"]);
    rmSync(join(config.publicFiles.dir, "i", up.url.split("/").pop()!), { force: true });
    uploadLimiter.clear();
  });

  test("lookalike links are bad_request naming the one that failed; the value is never echoed", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ x: "https://x.com.evil.example/snarkspad" }, "socials.x"],
      [{ x: "https://notx.com/snarkspad" }, "socials.x"],
      [{ x: "https://x.com@evil.example/snarkspad" }, "socials.x"],
      [{ x: "https://xn--x-9ma.com/snarkspad" }, "socials.x"],
      [{ x: "@toolonghandle_16chars" }, "socials.x"],
      [{ telegram: "https://t.me.evil.example/snarkspad" }, "socials.telegram"],
      [{ telegram: "https://telegram.me@evil.example/snarkspad" }, "socials.telegram"],
      [{ telegram: "@abcd" }, "socials.telegram"],
      [{ website: "http://example.com" }, "socials.website"],
      [{ website: "https://xn--pple-43d.com" }, "socials.website"],
      [{ website: "https://x.com/abc" }, "socials.website"],
      [{ website: "javascript:alert(1)" }, "socials.website"],
      [{ website: `https://example.com/${"a".repeat(100)}` }, "socials.website"],
      [{ website: 5 }, "socials.website"],
      [{ twitter: "https://x.com/abc" }, "socials"],
      [{ website: "https://example.com", extra: 1 }, "socials"],
    ];
    for (const [socials, field] of cases) {
      const r = await post("/coins/launch-tx", { ...ok, socials });
      expect([JSON.stringify(socials), r.status, r.body.error, r.body.field]).toEqual([JSON.stringify(socials), 400, "bad_request", field]);
      expect(r.text).not.toContain("evil.example");
    }
    for (const socials of [[], "x", 5, true]) {
      const r = await post("/coins/launch-tx", { ...ok, socials });
      expect([r.status, r.body.error, r.body.field]).toEqual([400, "bad_request", "socials"]);
    }
  });
});

// ---- launch-tx: the Creator wallet (contract v2.8, F-039). It is checked right after the links and before any chain read; every refusal is bad_creator_wallet
// naming the field, and the value is never echoed. A wallet that cannot sign for itself (a PDA), one of the pad's own, or anything that is not a wallet would strand the
// creator's fee and locked LP for good once the pool is handed to it.
describe("launch-tx: creatorWallet", () => {
  const launcher = Keypair.generate().publicKey.toBase58();
  const ok = { creator: launcher, name: "Test", symbol: "TEST", description: "" };
  // the next check after this one in the route is the tier: a request that gets past creatorWallet is refused for its tier, which proves the order
  const PAST = { feeTier: 3 };
  const refused = async (creatorWallet: unknown) => {
    const r = await post("/coins/launch-tx", { ...ok, ...PAST, creatorWallet });
    return { status: r.status, error: r.body.error, field: r.body.field, text: r.text };
  };
  const BAD = ["bad_creator_wallet", "creatorWallet"];
  const pda = PublicKey.findProgramAddressSync([Buffer.from("snarks-test-pda")], SystemProgram.programId)[0].toBase58();

  test("malformed values are bad_creator_wallet: not base58, the wrong length, padded, not a string, not canonical", async () => {
    const good = Keypair.generate().publicKey.toBase58();
    // only strings and values that can never be a wallet: a shorter or lower-cased variant of an address CAN be another valid address (a 43-character base58 string often is one)
    const cases: unknown[] = [
      "abc", "0".repeat(44), "O".repeat(44), good + "1", ` ${good}`, `${good}\n`, `${good} `, `${good.slice(0, 20)}0${good.slice(21)}`,
      "u1" + "q".repeat(100), "0x" + "ab".repeat(20), "11111111111111111111111111111111111111111111", 5, true, false, {}, [], [good], { wallet: good },
    ];
    for (const v of cases) {
      const r = await refused(v);
      expect([JSON.stringify(v), r.status, r.error, r.field]).toEqual([JSON.stringify(v), 400, ...BAD]);
      if (typeof v === "string" && v.length > 6) expect(r.text).not.toContain(v.trim());
    }
  });

  test("a wallet off the ed25519 curve (a PDA, a pool authority, a token account) is refused: nobody can sign for it", async () => {
    const tokenAccount = getAssociatedTokenAddressSync(config.solana.dbc.quoteMint, new PublicKey(launcher), false).toBase58();
    for (const v of [pda, deriveDbcPoolAuthority().toBase58(), tokenAccount]) {
      expect([v, PublicKey.isOnCurve(new PublicKey(v).toBytes())]).toEqual([v, false]);
      const r = await refused(v);
      expect([v, r.status, r.error, r.field]).toEqual([v, 400, ...BAD]);
    }
  });

  test("the pad's own wallets are refused: the keeper, a Squads member, a config's fee claimer and the team wallet", async () => {
    const keeper = Keypair.generate().publicKey.toBase58();
    const member = Keypair.generate().publicKey.toBase58();
    const claimer = Keypair.generate().publicKey.toBase58();
    const keptKeeper = db.getMeta(KEEPER_PUBKEY_META);
    const keptMembers = db.getMeta(SQUADS_MEMBERS_META);
    db.setMeta(KEEPER_PUBKEY_META, keeper);
    db.setMeta(SQUADS_MEMBERS_META, JSON.stringify([member]));
    db.insertDbcConfig({ configId: Keypair.generate().publicKey.toBase58(), feeBps: 100, feeClaimer: claimer, migrationQuoteThreshold: "1", dammConfig: "x", poolCreationFeeLamports: "0", createdAt: new Date().toISOString() });
    try {
      for (const v of [keeper, member, claimer]) {
        const r = await refused(v);
        expect([v === keeper ? "keeper" : v === member ? "member" : "claimer", r.status, r.error, r.field]).toEqual([v === keeper ? "keeper" : v === member ? "member" : "claimer", 400, ...BAD]);
        expect(r.text).not.toContain(v);
      }
    } finally {
      if (keptKeeper) db.setMeta(KEEPER_PUBKEY_META, keptKeeper); else db.deleteMeta(KEEPER_PUBKEY_META);
      if (keptMembers) db.setMeta(SQUADS_MEMBERS_META, keptMembers); else db.deleteMeta(SQUADS_MEMBERS_META);
      db.getDb().query("DELETE FROM dbc_configs WHERE feeClaimer = $c").run({ $c: claimer });
    }
  });

  test("nothing, null, an empty string, and the launcher's own address all pass this check (no handover): the refusal that follows is the tier", async () => {
    for (const v of [undefined, null, "", launcher]) {
      const r = await post("/coins/launch-tx", { ...ok, ...PAST, ...(v === undefined ? {} : { creatorWallet: v }) });
      expect([JSON.stringify(v), r.status, r.body.error, r.body.field]).toEqual([JSON.stringify(v), 400, "bad_request", "feeTier"]);
    }
  });

  test("an ordinary other wallet passes this check too", async () => {
    const r = await post("/coins/launch-tx", { ...ok, ...PAST, creatorWallet: Keypair.generate().publicKey.toBase58() });
    expect([r.status, r.body.error, r.body.field]).toEqual([400, "bad_request", "feeTier"]);
  });

  test("the check runs before the chain: a bad wallet on a request that would otherwise reach a missing tier config is still bad_creator_wallet, not tier_unavailable", async () => {
    const r = await post("/coins/launch-tx", { ...ok, feeTier: 200, creatorWallet: "not a wallet" });
    expect([r.status, r.body.error, r.body.field]).toEqual([400, ...BAD]);
  });
});
