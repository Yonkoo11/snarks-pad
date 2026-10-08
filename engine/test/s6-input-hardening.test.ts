// Audit S6 small fixes, each with the row of the lens report that found it:
//   lens 5-8  invisible characters (bidi marks and overrides, zero-width space, BOM, soft hyphen) passed into a coin's name and
//             defeated the lookalike check; emoji joiners stay allowed.
//   lens 5-4  every per-address cap keyed on the full address, so one IPv6 host (a whole /64) had an unlimited supply of keys.
//   lens 4-5  a bulk account read that answered fewer accounts than keys was paired with the wrong keys.
import { describe, expect, test } from "bun:test";
import { Keypair, type AccountInfo, type PublicKey } from "@solana/web3.js";
import { clientIp, limiterAddress } from "../src/api/common";
import { ApiFail, stringField } from "../src/api/validate";
import { forgetLearnedLimit, readAccountsInfo } from "../src/multiAccounts";

describe("lens 5-8: invisible characters are refused in text fields", () => {
  const bad = ["Snark​s", "‮skrans", "Snarks‏", "⁦Snarks⁩", "﻿Snarks", "Sn­arks", "⁠Snarks"];
  for (const name of bad) {
    test(`${JSON.stringify(name)} is bad_request`, () => {
      expect(() => stringField({ name }, "name", { max: 32 })).toThrow(ApiFail);
      expect(() => stringField({ description: name }, "description", { max: 500 })).toThrow(ApiFail);
    });
  }
  test("plain names and emoji sequences (zero-width joiner) still pass", () => {
    expect(stringField({ name: "SNARKS pad" }, "name", { max: 32 })).toBe("SNARKS pad");
    expect(stringField({ name: "fam \u{1F468}‍\u{1F469}‍\u{1F467}" }, "name", { max: 32 })).toContain("‍");
    expect(stringField({ name: "Ünïcödé 🐸" }, "name", { max: 32 })).toBe("Ünïcödé 🐸");
  });
});

describe("lens 5-4: a client is counted by the address block it controls", () => {
  test("IPv4 and IPv4 mapped into IPv6 are the single address", () => {
    expect(limiterAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(limiterAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });
  test("IPv6 collapses to its /64, however it is written", () => {
    expect(limiterAddress("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3:0::/64");
    expect(limiterAddress("2001:0db8:85a3::8a2e:0370:7334")).toBe("2001:db8:85a3:0::/64");
    expect(limiterAddress("2001:db8:85a3:0:ffff:ffff:ffff:ffff")).toBe("2001:db8:85a3:0::/64");
    expect(limiterAddress("2001:db8:85a3:1::1")).toBe("2001:db8:85a3:1::/64"); // a different /64 is a different client
    expect(limiterAddress("::1")).toBe("0:0:0:0::/64");
  });
  test("the forwarded header behind the loopback proxy is keyed the same way; a direct peer too", () => {
    expect(clientIp("2001:db8:85a3::1, 2001:db8:85a3::2", "127.0.0.1")).toBe("2001:db8:85a3:0::/64");
    expect(clientIp("198.51.100.7", "127.0.0.1")).toBe("198.51.100.7");
    expect(clientIp("2001:db8:85a3::1", "198.51.100.7")).toBe("198.51.100.7"); // a header from a non-loopback peer is not believed
    expect(clientIp(null, "2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientIp(null, null)).toBeNull();
  });
});

describe("lens 1-02: a stranger's requests in a wallet's name neither evict nor lock out that wallet's own nonce", () => {
  test("forty nonces asked for one wallet: the first is still usable and the forty-first request is still answered", async () => {
    const { issueNonce } = await import("../src/optin/registry");
    const db = await import("../src/db");
    const wallet = Keypair.generate().publicKey.toBase58();
    const mine = issueNonce(wallet).nonce;
    for (let i = 0; i < 40; i++) issueNonce(wallet); // the stranger
    expect(db.nonceUsable(wallet, mine, 10 * 60_000)).toBe(true);
    expect(issueNonce(wallet).nonce.length).toBeGreaterThan(10);
  });
});

describe("lens 1-02: nonce issuance is limited per client address, never for the machine's own calls", () => {
  test("the eleventh nonce request in a minute from one address is 429 with retry-after; a loopback caller is not counted", async () => {
    const { handleRequest } = await import("../src/api");
    const wallet = Keypair.generate().publicKey.toBase58();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await handleRequest(new Request(`http://api.test/api/optin/nonce?wallet=${wallet}`), { ip: "203.0.113.77" })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    const refused = await handleRequest(new Request(`http://api.test/api/optin/nonce?wallet=${wallet}`), { ip: "203.0.113.77" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await handleRequest(new Request(`http://api.test/api/optin/nonce?wallet=${wallet}`), { ip: "198.51.100.1" })).status).toBe(200); // another client
    for (let i = 0; i < 12; i++) expect((await handleRequest(new Request(`http://api.test/api/optin/nonce?wallet=${wallet}`), { ip: "127.0.0.1" })).status).toBe(200);
  });
});

describe("lenses 4-1, 5-3: chain-building routes are limited per client address", () => {
  test("the thirty-first trade-tx, creator-claim-tx or creator-fees call in a minute from one address is 429; loopback is not counted", async () => {
    const { handleRequest, CHAIN_READS_PER_MINUTE } = await import("../src/api");
    const mint = Keypair.generate().publicKey.toBase58(); // unknown coin: every admitted call answers 404 before any chain read
    const paths = [`/api/coins/${mint}/trade-tx`, `/api/coins/${mint}/creator-claim-tx`, `/api/coins/${mint}/creator-fees`];
    const call = (ip: string, i: number) => {
      const path = paths[i % paths.length]!;
      const method = path.endsWith("creator-fees") ? "GET" : "POST";
      return handleRequest(new Request(`http://api.test${path}`, { method, body: method === "POST" ? "{}" : undefined }), { ip });
    };
    const statuses: number[] = [];
    for (let i = 0; i < CHAIN_READS_PER_MINUTE + 1; i++) statuses.push((await call("203.0.113.90", i)).status);
    expect(statuses.slice(0, CHAIN_READS_PER_MINUTE).every((s) => s === 404)).toBe(true);
    expect(statuses[CHAIN_READS_PER_MINUTE]).toBe(429);
    expect((await call("198.51.100.2", 0)).status).toBe(404); // another client is not affected
    for (let i = 0; i < CHAIN_READS_PER_MINUTE + 2; i++) expect((await call("127.0.0.1", i)).status).toBe(404);
  });
});

describe("lens 4-5: a short bulk-read answer is an error, never a misaligned list", () => {
  const keys = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
  const info = (k: PublicKey): AccountInfo<Buffer> => ({ executable: false, owner: k, lamports: 1, data: Buffer.from(k.toBytes()), rentEpoch: 0 });
  test("one account per key, in order, passes", async () => {
    forgetLearnedLimit();
    expect(await readAccountsInfo(keys, async (ks) => ks.map(info), 100)).toEqual(keys.map(info));
  });
  test("an answer missing an account throws instead of shifting the rest", async () => {
    forgetLearnedLimit();
    await expect(readAccountsInfo(keys, async (ks) => ks.slice(1).map(info), 100)).rejects.toThrow("answered 6 accounts for 7 keys");
  });
});
