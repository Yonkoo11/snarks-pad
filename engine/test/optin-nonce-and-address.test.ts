// Audit S6 opt-in fixes (needs the devtool binary, like test/optin-registry.test.ts):
//   lens 1-01  an address with leading or trailing whitespace passed the check (made on the trimmed string) and was stored as
//              sent; the payment URI built from it failed, and with it the whole shielded batch, every epoch.
//   lenses 1-03, 5-5  a signed opt-in whose address failed the devtool check kept its nonce, so the same body could be
//              replayed without limit, each replay a synchronous devtool spawn on the API's event loop.
import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { existsSync } from "node:fs";
import { config } from "../src/config";
import * as db from "../src/db";
import { optinMessage } from "../src/optin/message";
import { issueNonce, registerOptin } from "../src/optin/registry";

const HAS_DEVTOOL = existsSync(config.paths.zcashDevtoolBin);
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function derive(network: "regtest" | "test"): string {
  const proc = Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "derive-address", "--mnemonic", TEST_MNEMONIC, "--network", network]);
  const ua = /Unified Address:\s*(\S+)/.exec(new TextDecoder().decode(proc.stdout))?.[1];
  if (!ua) throw new Error("derive-address failed");
  return ua;
}
const signAs = (kp: Keypair, message: string): string => bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));

describe.if(HAS_DEVTOOL)("audit S6: opt-in address storage and nonce spending", () => {
  test("lens 1-01: an address sent with whitespace around it is accepted and stored trimmed", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = derive("regtest");
    const padded = `  ${ua}\n`;
    const { nonce } = issueNonce(wallet);
    const result = registerOptin(wallet, padded, nonce, signAs(kp, optinMessage(wallet, padded, nonce))); // the wallet signed the text with the padded address
    expect(result.ok).toBe(true);
    expect(db.getOptin(wallet)?.zcashAddress).toBe(ua);
  });

  test("lenses 1-03, 5-5: a signed body whose address fails the full check spends its nonce; the replay is stale_nonce", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const wrongNetwork = derive("test"); // a unified address, but not on this pad's network: passes the cheap prechecks, fails the devtool check
    const { nonce } = issueNonce(wallet);
    const sig = signAs(kp, optinMessage(wallet, wrongNetwork, nonce));
    expect(registerOptin(wallet, wrongNetwork, nonce, sig)).toEqual({ ok: false, error: "bad_address" });
    expect(registerOptin(wallet, wrongNetwork, nonce, sig)).toEqual({ ok: false, error: "stale_nonce" });
    expect(db.getOptin(wallet)).toBeNull();
  });

  test("a junk signature still does not spend the nonce (the order S2 fixed is kept)", () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const ua = derive("regtest");
    const { nonce } = issueNonce(wallet);
    expect(registerOptin(wallet, ua, nonce, signAs(Keypair.generate(), optinMessage(wallet, ua, nonce)))).toEqual({ ok: false, error: "invalid_signature" });
    expect(registerOptin(wallet, ua, nonce, signAs(kp, optinMessage(wallet, ua, nonce))).ok).toBe(true);
  });
});
