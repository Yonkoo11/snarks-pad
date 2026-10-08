// audit/S2-SUPPLY-CHAIN.md: exact version pins, lockfiles committed, the bigint-buffer advisory (GHSA-3gc7-fjrx-p6mg)
// removed from the tree, tweetnacl out of the production signature path.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, AccountState, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import nacl from "tweetnacl";
import { config } from "../src/config";
import { verifyEd25519 } from "../src/crypto/ed25519";
import { verifyWalletSignature } from "../src/optin/verify";
import bs58 from "bs58";

const ROOT = config.paths.engineRoot;
const REPO = config.paths.repoRoot;
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

describe("exact pins and committed lockfiles", () => {
  test.each([["engine", ROOT], ["web", join(REPO, "web")]])("%s: every dependency is an exact version", (_n, dir) => {
    const m = manifest(dir);
    for (const [name, spec] of Object.entries({ ...m.dependencies, ...m.devDependencies })) {
      expect(`${name}@${spec}`).toMatch(/@\d+\.\d+\.\d+$/); // no ^, ~, ranges, tags or URLs
    }
  });

  test("the lockfiles are committed", () => {
    for (const f of ["engine/bun.lock", "web/package-lock.json"]) {
      const r = Bun.spawnSync(["git", "ls-files", "--error-unmatch", f], { cwd: REPO });
      expect(r.exitCode).toBe(0);
    }
  });

  test("the package managers are told to keep pinning", () => {
    expect(readFileSync(join(ROOT, "bunfig.toml"), "utf8")).toMatch(/exact\s*=\s*true/);
    expect(readFileSync(join(REPO, "web", ".npmrc"), "utf8")).toMatch(/save-exact\s*=\s*true/);
  });
});

describe("bigint-buffer (GHSA-3gc7-fjrx-p6mg: buffer overflow in the NATIVE toBigIntLE, no patched release)", () => {
  const dir = join(ROOT, "node_modules", "bigint-buffer");

  test("the native addon cannot be built or loaded from the installed package", () => {
    expect(existsSync(join(dir, "binding.gyp"))).toBe(false);
    expect(existsSync(join(dir, "src", "bigint-buffer.c"))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.install).toBeUndefined();
    expect(readFileSync(join(dir, "dist", "node.js"), "utf8")).not.toMatch(/require\(['"]bindings['"]\)/);
  });

  test("the patch is recorded, so a frozen install reproduces it", () => {
    expect(readFileSync(join(ROOT, "package.json"), "utf8")).toContain('"bigint-buffer@1.1.5": "patches/bigint-buffer@1.1.5.patch"');
    expect(existsSync(join(ROOT, "patches", "bigint-buffer@1.1.5.patch"))).toBe(true);
    expect(readFileSync(join(ROOT, "bun.lock"), "utf8")).toContain("patches/bigint-buffer@1.1.5.patch");
  });

  // An independent reference: base-256 digit loops, nothing shared with the implementation.
  const refLE = (b: Uint8Array): bigint => [...b].reduceRight((acc, byte) => acc * 256n + BigInt(byte), 0n);
  const refBE = (b: Uint8Array): bigint => [...b].reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
  const bb = require("bigint-buffer") as typeof import("bigint-buffer");

  test("it converts exactly like the reference, for every length including empty and not a multiple of 8", () => {
    for (let len = 0; len <= 40; len++) {
      for (let i = 0; i < 20; i++) {
        const b = Buffer.from(crypto.getRandomValues(new Uint8Array(len)));
        expect(bb.toBigIntLE(b)).toBe(refLE(b));
        expect(bb.toBigIntBE(b)).toBe(refBE(b));
      }
    }
    expect(bb.toBigIntLE(Buffer.alloc(0))).toBe(0n);
    expect(bb.toBigIntBE(Buffer.alloc(8, 0xff))).toBe(2n ** 64n - 1n);
  });

  test("toBuffer round-trips values of every width up to 32 bytes", () => {
    for (let width = 1; width <= 32; width++) {
      for (let i = 0; i < 10; i++) {
        const n = refBE(crypto.getRandomValues(new Uint8Array(width)));
        expect(bb.toBigIntLE(bb.toBufferLE(n, width))).toBe(n);
        expect(bb.toBigIntBE(bb.toBufferBE(n, width))).toBe(n);
      }
    }
    expect([...bb.toBufferLE(258n, 4)]).toEqual([2, 1, 0, 0]);
    expect([...bb.toBufferBE(258n, 4)]).toEqual([0, 0, 1, 2]);
  });

  test("the real consumer still decodes SPL token accounts: an amount of u64::MAX and the one after the largest balance", () => {
    for (const amount of [0n, 1n, 123_456_789n, 2n ** 64n - 1n]) {
      const data = Buffer.alloc(ACCOUNT_SIZE);
      AccountLayout.encode(
        {
          mint: config.solana.dbc.quoteMint, owner: PublicKey.default, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized,
          isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
        },
        data,
      );
      const account = unpackAccount(PublicKey.default, { data, executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID }, TOKEN_PROGRAM_ID);
      expect(account.amount).toBe(amount);
    }
  });
});

describe("tweetnacl is not in the production tree", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

  test("it is a dev dependency only, and nothing under src/ imports it", () => {
    const m = manifest(ROOT);
    expect(m.dependencies?.tweetnacl).toBeUndefined();
    expect(m.devDependencies?.tweetnacl).toMatch(/^\d/);
    for (const f of walk(join(ROOT, "src"))) expect(readFileSync(f, "utf8")).not.toMatch(/from ["']tweetnacl["']|require\(["']tweetnacl["']\)/);
  });
});

describe("verifyEd25519 agrees with tweetnacl, and is stricter only where it should be", () => {
  const sign = (msg: Uint8Array) => {
    const kp = nacl.sign.keyPair();
    return { kp, sig: nacl.sign.detached(msg, kp.secretKey) };
  };

  test("RFC 8032 test vectors 1 and 2", () => {
    const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
    const vectors = [
      ["d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "", "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"],
      ["3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72", "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"],
    ] as const;
    for (const [pk, msg, sig] of vectors) {
      expect(verifyEd25519(hex(msg), hex(sig), hex(pk))).toBe(true);
      expect(nacl.sign.detached.verify(hex(msg), hex(sig), hex(pk))).toBe(true);
    }
  });

  test("300 random keys and messages: valid signatures verify; any single changed bit is refused, as tweetnacl refuses it", () => {
    for (let i = 0; i < 300; i++) {
      const msg = crypto.getRandomValues(new Uint8Array(i % 7 === 0 ? 0 : 1 + (i % 200)));
      const { kp, sig } = sign(msg);
      expect(verifyEd25519(msg, sig, kp.publicKey)).toBe(true);
      const badSig = Uint8Array.from(sig);
      badSig[i % 64] = badSig[i % 64]! ^ (1 << (i % 8));
      const badKey = Uint8Array.from(kp.publicKey);
      badKey[(i * 5) % 32] = badKey[(i * 5) % 32]! ^ (1 << (i % 8));
      const badMsg = Uint8Array.from([...msg, 0]);
      for (const [m, s, k] of [[msg, badSig, kp.publicKey], [msg, sig, badKey], [badMsg, sig, kp.publicKey]] as const) {
        expect(verifyEd25519(m, s, k)).toBe(false);
        expect(nacl.sign.detached.verify(m, s, k)).toBe(false);
      }
    }
  });

  test("garbage never throws and is never valid: wrong lengths, random keys that are not points, random signatures", () => {
    const msg = new TextEncoder().encode("hello");
    expect(verifyEd25519(msg, new Uint8Array(63), new Uint8Array(32))).toBe(false);
    expect(verifyEd25519(msg, new Uint8Array(65), new Uint8Array(32))).toBe(false);
    expect(verifyEd25519(msg, new Uint8Array(64), new Uint8Array(31))).toBe(false);
    expect(verifyEd25519(msg, new Uint8Array(64), new Uint8Array(0))).toBe(false);
    for (let i = 0; i < 200; i++) {
      const sig = crypto.getRandomValues(new Uint8Array(64));
      const key = crypto.getRandomValues(new Uint8Array(32));
      expect(verifyEd25519(msg, sig, key)).toBe(false);
      expect(nacl.sign.detached.verify(msg, sig, key)).toBe(false);
    }
  });

  test("a signature with a non-reduced S (the malleable twin) is refused by RFC 8032, which tweetnacl accepts: stricter, never looser", () => {
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const msg = new TextEncoder().encode("opt in");
    const { kp, sig } = sign(msg);
    const s = [...sig.slice(32)].reduceRight((acc, b) => acc * 256n + BigInt(b), 0n);
    const twin = Uint8Array.from(sig);
    let t = s + L;
    for (let i = 32; i < 64; i++) {
      twin[i] = Number(t & 0xffn);
      t >>= 8n;
    }
    expect(verifyEd25519(msg, sig, kp.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(msg, twin, kp.publicKey)).toBe(true); // tweetnacl does not check that S is reduced
    expect(verifyEd25519(msg, twin, kp.publicKey)).toBe(false);
  });

  test("the opt-in check built on it: the wallet's own signature passes, another wallet's and a tampered message do not", () => {
    const kp = nacl.sign.keyPair();
    const wallet = new PublicKey(kp.publicKey).toBase58();
    const message = "Opt in to shielded delivery\nwallet: " + wallet;
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
    expect(verifyWalletSignature(wallet, message, signature)).toBe(true);
    expect(verifyWalletSignature(wallet, message + " ", signature)).toBe(false);
    expect(verifyWalletSignature(new PublicKey(nacl.sign.keyPair().publicKey).toBase58(), message, signature)).toBe(false);
    expect(verifyWalletSignature(wallet, message, signature.slice(1))).toBe(false);
  });
});
