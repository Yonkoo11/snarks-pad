// Contract v2.9, "Signed reads": whether a wallet opted in to shielded delivery, the masked address, what is pending and the shielded rounds it was paid in are
// shown only to a request that carries the wallet's fresh signature over a text made for that purpose (POST /api/optin/status). Everything else that used to
// say who opted in (the unsigned status route, the holders list, GET /rewards/:wallet) says nothing now. The product promise is that shielded delivery is private.
// No chain and no zcash-devtool needed: a wallet's opt-in row is written straight to the test database, and an opt-in that is attempted is refused on its
// signature before any address check runs.
import { afterAll, describe, expect, test } from "bun:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api";
import * as db from "../src/db";
import { epochReceiptMessage, optinMessage, optoutMessage, shieldedViewMessage } from "../src/optin/message";
import { maskZcashAddress } from "../src/zcash/address";

const B = "http://pad.test/api";
// A string that passes the cheap address shape check (so an attempted opt-in reaches its signature check) and is recognisable in any answer.
const ZADDR = "uregtest1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4);
const pub = (k: Keypair) => k.publicKey.toBase58();
const sign = (signer: Keypair, message: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey));

const wallets: string[] = [];
const coinMints: string[] = [];
/** A wallet with shielded delivery switched on (its row written directly), or a stranger to the pad. */
function person(optedIn: boolean): Keypair {
  const k = Keypair.generate();
  wallets.push(pub(k));
  if (optedIn) db.upsertOptin(pub(k), ZADDR);
  return k;
}
afterAll(() => {
  const d = db.getDb();
  for (const w of wallets) for (const t of ["optins", "nonces", "carry"]) d.query(`DELETE FROM ${t} WHERE wallet = $w`).run({ $w: w });
  for (const m of coinMints) for (const t of ["coins", "holder_samples"]) d.query(`DELETE FROM ${t} WHERE mint = $m`).run({ $m: m });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await handleRequest(new Request(B + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const text = await res.text();
  expect(res.status).not.toBe(500);
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as any };
}
const nonceOf = async (k: Keypair): Promise<string> => (await call("GET", `/optin/nonce?wallet=${pub(k)}`)).body.nonce;
/** The status read, signed by `signer` over `textOf(nonce)` (the wallet's own status text unless a test says otherwise). */
async function read(k: Keypair, o: { signer?: Keypair; textOf?: (nonce: string) => string; nonce?: string } = {}) {
  const nonce = o.nonce ?? (await nonceOf(k));
  const text = (o.textOf ?? ((n) => shieldedViewMessage(pub(k), n)))(nonce);
  return call("POST", "/optin/status", { wallet: pub(k), nonce, signature: sign(o.signer ?? k, text) });
}

describe("an unsigned read reveals nothing about opt-in", () => {
  test("there is no unsigned status route: the same 404 for a wallet that opted in and for one that never did, with or without the old query proof", async () => {
    const on = person(true);
    const off = person(false);
    const a = await call("GET", `/optin/${pub(on)}`);
    const b = await call("GET", `/optin/${pub(off)}`);
    expect(a.status).toBe(404);
    expect(a.body).toEqual({ error: "not_found" });
    expect([b.status, b.text]).toEqual([a.status, a.text]);
    const nonce = await nonceOf(on);
    const oldStyle = await call("GET", `/optin/${pub(on)}?nonce=${nonce}&signature=${sign(on, shieldedViewMessage(pub(on), nonce))}`);
    expect(oldStyle.status).toBe(404);
    expect(oldStyle.text).not.toMatch(/optedIn|pendingZats|zcashAddressMasked/);
  });

  test("a read with no signature, a junk one or one by another key is refused the same way for an opted-in wallet and for a stranger to the pad", async () => {
    const on = person(true);
    const off = person(false);
    const stranger = Keypair.generate();
    const attempts: [string, (k: Keypair) => Promise<{ status: number; body: any }>][] = [
      ["no signature at all", async (k) => call("POST", "/optin/status", { wallet: pub(k), nonce: await nonceOf(k) })],
      ["a junk signature", async (k) => call("POST", "/optin/status", { wallet: pub(k), nonce: await nonceOf(k), signature: bs58.encode(new Uint8Array(64).fill(7)) })],
      ["another key's signature", (k) => read(k, { signer: stranger })],
    ];
    for (const [what, attempt] of attempts) {
      const a = await attempt(on);
      const b = await attempt(off);
      expect([what, a.status, a.body]).toEqual([what, 400, { error: "invalid_signature", ...(what === "no signature at all" ? { field: "signature" } : {}) }]);
      expect([what, b.status, b.body]).toEqual([what, a.status, a.body]);
    }
  });

  test("one wallet's signature does not open another wallet's status", async () => {
    const mine = person(true);
    const theirs = person(true);
    const nonce = await nonceOf(theirs);
    const r = await call("POST", "/optin/status", { wallet: pub(theirs), nonce, signature: sign(mine, shieldedViewMessage(pub(theirs), nonce)) });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_signature" });
    // and mine, signed for my own wallet, cannot be pointed at theirs by changing the wallet field
    const myNonce = await nonceOf(mine);
    const swapped = await call("POST", "/optin/status", { wallet: pub(theirs), nonce: myNonce, signature: sign(mine, shieldedViewMessage(pub(mine), myNonce)) });
    expect(swapped.status).toBe(400);
    expect(swapped.text).not.toContain("optedIn");
  });
});

describe("the signed read", () => {
  test("shows a wallet its own settings: on, the masked address (never the whole one), what is pending and the shielded rounds", async () => {
    const k = person(true);
    db.setCarry(pub(k), "shielded", 42_000n);
    const r = await read(k);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ optedIn: true, zcashAddressMasked: maskZcashAddress(ZADDR), pendingZats: "42000", shielded: { rounds: 0, commitments: [], fallback: { count: 0, totalZats: "0", payouts: [] } } });
    expect(r.text).not.toContain(ZADDR);
    expect(r.text).not.toContain(ZADDR.slice(8, -8));
  });

  test("a wallet that never opted in, or that opted out, reads off: no address, nothing pending", async () => {
    const stranger = await read(person(false));
    expect(stranger.status).toBe(200);
    expect(stranger.body).toEqual({ optedIn: false, zcashAddressMasked: null, pendingZats: "0", shielded: { rounds: 0, commitments: [], fallback: { count: 0, totalZats: "0", payouts: [] } } });
    const k = person(true);
    db.deactivateOptin(pub(k));
    expect((await read(k)).body).toMatchObject({ optedIn: false, zcashAddressMasked: null });
  });

  test("the answer is never cached by anything between the engine and the wallet", async () => {
    expect((await read(person(true))).headers.get("cache-control")).toBe("no-store");
  });

  test("a nonce works once: reusing it, even with the same good signature, is refused", async () => {
    const k = person(true);
    const nonce = await nonceOf(k);
    const body = { wallet: pub(k), nonce, signature: sign(k, shieldedViewMessage(pub(k), nonce)) };
    expect((await call("POST", "/optin/status", body)).status).toBe(200);
    const again = await call("POST", "/optin/status", body);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: "stale_nonce" });
    expect(again.text).not.toContain("optedIn");
  });

  test("a nonce issued to another wallet, an unknown one and an expired one are all refused", async () => {
    const k = person(true);
    const other = person(true);
    const foreign = await nonceOf(other);
    expect((await read(k, { nonce: foreign })).body).toEqual({ error: "stale_nonce" });
    expect((await read(k, { nonce: "never-issued" })).body).toEqual({ error: "stale_nonce" });
    const old = await nonceOf(k);
    db.getDb().query("UPDATE nonces SET issuedAt = $t WHERE wallet = $w AND nonce = $n").run({ $t: new Date(Date.now() - 11 * 60_000).toISOString(), $w: pub(k), $n: old });
    expect((await read(k, { nonce: old })).body).toEqual({ error: "stale_nonce" });
  });
});

describe("a signature made for one purpose is useless for another", () => {
  test("the four texts a wallet signs differ in their first line, so none can be checked as another", () => {
    const w = pub(Keypair.generate());
    const texts = [optinMessage(w, ZADDR, "n1"), optoutMessage(w, "n1"), shieldedViewMessage(w, "n1"), epochReceiptMessage(w, "epoch-1", "n1")];
    expect(new Set(texts.map((t) => t.split("\n")[0])).size).toBe(4);
  });

  test("a signature made to READ the status cannot opt in or out, and the failed attempts change nothing and spend nothing", async () => {
    const k = person(true);
    const nonce = await nonceOf(k);
    const readSignature = sign(k, shieldedViewMessage(pub(k), nonce));
    const optIn = await call("POST", "/optin", { wallet: pub(k), zcashAddress: ZADDR, nonce, signature: readSignature });
    expect([optIn.status, optIn.body]).toEqual([400, { error: "invalid_signature" }]);
    const optOut = await call("DELETE", "/optin", { wallet: pub(k), nonce, signature: readSignature });
    expect([optOut.status, optOut.body]).toEqual([400, { error: "invalid_signature" }]);
    expect(db.getOptin(pub(k))?.active).toBe(1); // still on: the read signature did not stop delivery
    const stranger = person(false);
    const strangerNonce = await nonceOf(stranger);
    const strangerIn = await call("POST", "/optin", { wallet: pub(stranger), zcashAddress: ZADDR, nonce: strangerNonce, signature: sign(stranger, shieldedViewMessage(pub(stranger), strangerNonce)) });
    expect(strangerIn.body).toEqual({ error: "invalid_signature" });
    expect(db.getOptin(pub(stranger))).toBeNull(); // no row was made
    // the nonce was not burned by those attempts: the read it was signed for still works, once
    expect((await call("POST", "/optin/status", { wallet: pub(k), nonce, signature: readSignature })).status).toBe(200);
    expect((await call("POST", "/optin/status", { wallet: pub(k), nonce, signature: readSignature })).body).toEqual({ error: "stale_nonce" });
  });

  test("a signature made to opt in, opt out or open a receipt cannot read the status, and spends no nonce", async () => {
    const k = person(true);
    const nonce = await nonceOf(k);
    for (const text of [optinMessage(pub(k), ZADDR, nonce), optoutMessage(pub(k), nonce), epochReceiptMessage(pub(k), "epoch-1", nonce)]) {
      const r = await read(k, { nonce, textOf: () => text });
      expect([r.status, r.body]).toEqual([400, { error: "invalid_signature" }]);
      expect(r.text).not.toContain("optedIn");
    }
    expect((await read(k, { nonce })).status).toBe(200); // the nonce was still there for the read it was meant for
  });
});

describe("nothing else says who opted in", () => {
  test("the holders list has no tag and no count for shielded delivery, whoever opted in", async () => {
    const dev = person(true);
    const holderOn = person(true);
    const holderOff = person(false);
    const mint = Keypair.generate().publicKey.toBase58();
    coinMints.push(mint);
    db.upsertCoin({ mint, name: "Private", symbol: "PRIV", imageUrl: "", description: "", creator: pub(dev), createdAt: new Date().toISOString(), feeBps: 100, poolId: pub(Keypair.generate()), mintDecimals: 6, status: "launched" });
    db.insertHolderSample(mint, new Date().toISOString(), [{ wallet: pub(dev), balance: 5_000_000n }, { wallet: pub(holderOn), balance: 3_000_000n }, { wallet: pub(holderOff), balance: 1_000_000n }]);
    const r = await call("GET", `/coins/${mint}/holders`);
    expect(r.status).toBe(200);
    expect(r.body.holders.map((h: { wallet: string }) => h.wallet)).toEqual([pub(dev), pub(holderOn), pub(holderOff)]);
    expect(r.body.holders.flatMap((h: { tags: string[] }) => h.tags)).toEqual(["dev"]);
    expect(Object.keys(r.body).filter((key) => /opt|shield/i.test(key))).toEqual([]);
    expect(r.text).not.toMatch(/optedIn|shielded|uregtest1/i);
  });

  test("GET /rewards/:wallet and GET /wallets/:wallet answer with the same shape and no shielded field for a wallet that opted in and for one that did not", async () => {
    const on = person(true);
    const off = person(false);
    const shapeOf = (b: object) => Object.keys(b).sort();
    for (const route of ["rewards", "wallets"]) {
      const a = await call("GET", `/${route}/${pub(on)}`);
      const b = await call("GET", `/${route}/${pub(off)}`);
      expect(a.status).toBe(200);
      expect(shapeOf(a.body)).toEqual(shapeOf(b.body));
      expect(a.text).not.toMatch(/optedIn|shielded|zcashAddress|uregtest1/i);
    }
  });

  test("the pad-wide numbers stay counts: GET /stats says how many wallets opted in, never which", async () => {
    const r = await call("GET", "/stats");
    expect(typeof r.body.optIns).toBe("number");
    for (const w of wallets) expect(r.text).not.toContain(w);
  });
});
