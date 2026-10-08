import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { issueNonce, registerOptin, deregisterOptin, readOptinStatus } from "../src/optin/registry";
import { optinMessage, optoutMessage, shieldedViewMessage } from "../src/optin/message";
import { existsSync } from "node:fs";
import { config } from "../src/config";

const HAS_DEVTOOL = existsSync(config.paths.zcashDevtoolBin);
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function deriveRegtestUA(): string {
  const proc = Bun.spawnSync([
    config.paths.zcashDevtoolBin,
    "wallet",
    "derive-address",
    "--mnemonic",
    TEST_MNEMONIC,
    "--network",
    "regtest",
  ]);
  const ua = /Unified Address:\s*(\S+)/.exec(new TextDecoder().decode(proc.stdout))?.[1];
  if (!ua) throw new Error("derive-address failed");
  return ua;
}

function signAs(kp: Keypair, message: string): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
}

/** The wallet's own status, read the only way there is: with a fresh nonce and its signature over the status text (v2.9). */
function statusOf(kp: Keypair) {
  const wallet = kp.publicKey.toBase58();
  const { nonce } = issueNonce(wallet);
  const read = readOptinStatus(wallet, nonce, signAs(kp, shieldedViewMessage(wallet, nonce)));
  if (!read.ok) throw new Error(read.error);
  return read.status;
}

describe.if(HAS_DEVTOOL)("optin registry", () => {
  test("register then status shows opted-in with a masked address, never the full one", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = deriveRegtestUA();
    const { nonce } = issueNonce(wallet);
    const sig = signAs(kp, optinMessage(wallet, ua, nonce));

    const result = registerOptin(wallet, ua, nonce, sig);
    expect(result.ok).toBe(true);

    const status = statusOf(kp);
    expect(status.optedIn).toBe(true);
    expect(status.zcashAddressMasked).not.toBe(ua);
    expect(status.zcashAddressMasked).not.toContain(ua.slice(10, -10)); // no long substring of the real address
  });

  test("a nonce can only be consumed once (replay is rejected)", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = deriveRegtestUA();
    const { nonce } = issueNonce(wallet);
    const sig = signAs(kp, optinMessage(wallet, ua, nonce));

    expect(registerOptin(wallet, ua, nonce, sig).ok).toBe(true);
    const replay = registerOptin(wallet, ua, nonce, sig);
    expect(replay).toEqual({ ok: false, error: "stale_nonce" });
  });

  test("rejects a transparent address with no_orchard_receiver", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const proc = Bun.spawnSync([
      config.paths.zcashDevtoolBin,
      "wallet",
      "derive-address",
      "--mnemonic",
      TEST_MNEMONIC,
      "--network",
      "regtest",
    ]);
    const taddr = /Transparent Address:\s*(\S+)/.exec(new TextDecoder().decode(proc.stdout))?.[1]!;
    const { nonce } = issueNonce(wallet);
    const sig = signAs(kp, optinMessage(wallet, taddr, nonce));
    expect(registerOptin(wallet, taddr, nonce, sig)).toEqual({ ok: false, error: "no_orchard_receiver" });
  });

  test("rejects an invalid signature", () => {
    const kp = Keypair.generate();
    const impostor = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = deriveRegtestUA();
    const { nonce } = issueNonce(wallet);
    const sig = signAs(impostor, optinMessage(wallet, ua, nonce));
    expect(registerOptin(wallet, ua, nonce, sig)).toEqual({ ok: false, error: "invalid_signature" });
  });

  test("opt-out deactivates and status flips back to Solana ZEC delivery", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = deriveRegtestUA();
    const inNonce = issueNonce(wallet).nonce;
    registerOptin(wallet, ua, inNonce, signAs(kp, optinMessage(wallet, ua, inNonce)));
    expect(statusOf(kp).optedIn).toBe(true);

    const outNonce = issueNonce(wallet).nonce;
    const outResult = deregisterOptin(wallet, outNonce, signAs(kp, optoutMessage(wallet, outNonce)));
    expect(outResult).toEqual({ ok: true });
    expect(statusOf(kp).optedIn).toBe(false);
    expect(statusOf(kp).zcashAddressMasked).toBeNull();
  });
});
