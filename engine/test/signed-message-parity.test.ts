// The text a wallet signs is built twice: by the engine (src/optin/message.ts, which checks it) and by the page (web/src/lib/api.ts, which shows it to the person and has the wallet
// sign it). One character of difference and every signature is refused, with nothing on either side to say why. This compares the two builders for every signed request.
// The page's module reads `location` when it loads (the mock's mode flags), so a stand-in is in place for that import only. The path is a variable on purpose: the engine's
// type check should not take the page's whole mock into its own program.
import { describe, expect, test } from "bun:test";
import { epochReceiptMessage, optinMessage, optoutMessage, shieldedViewMessage } from "../src/optin/message";

interface WebMessages {
  optinMessage(wallet: string, zcash: string, nonce: string): string;
  optoutMessage(wallet: string, nonce: string): string;
  shieldedViewMessage(wallet: string, nonce: string): string;
  receiptMessage(wallet: string, epochId: string, nonce: string): string;
}

const WEB_API = "../../web/src/lib/api";

async function loadWebMessages(): Promise<WebMessages> {
  const scope = globalThis as { location?: unknown };
  const before = scope.location;
  scope.location = { href: "http://localhost/", hash: "" };
  try {
    return await import(WEB_API);
  } finally {
    if (before === undefined) delete scope.location;
    else scope.location = before;
  }
}

const web = await loadWebMessages();
const WALLET = "8gzxA8Zb4Mx1vT7r3q2YhWk9PfDnLsCeUjRiBYoAu1";
const ADDRESS = "u1q3m5k7x9c2v4b6n8a0s2d4f6g8h0j2l4p6r8t0w2y4z6a8c0e2g4i6k8m0o2q4s6u8w0y2a4c6e8g0i2k4m6o8q0s2u4w6y8a0c2e4g6i8k0m2o4q6s8u0w2y4a6c8e0g2";
const NONCE = "5c0d1e8f-3a2b-4c6d-9e7f-0a1b2c3d4e5f";
const EPOCH = "epoch-1790000000000";

describe("the texts a wallet signs are the same on the page and in the engine", () => {
  test("opt in", () => {
    expect(web.optinMessage(WALLET, ADDRESS, NONCE)).toBe(optinMessage(WALLET, ADDRESS, NONCE));
  });

  test("opt out", () => {
    expect(web.optoutMessage(WALLET, NONCE)).toBe(optoutMessage(WALLET, NONCE));
  });

  test("show my shielded delivery settings and rewards (v2.9)", () => {
    expect(web.shieldedViewMessage(WALLET, NONCE)).toBe(shieldedViewMessage(WALLET, NONCE));
  });

  test("open my epoch receipt", () => {
    expect(web.receiptMessage(WALLET, EPOCH, NONCE)).toBe(epochReceiptMessage(WALLET, EPOCH, NONCE));
  });
});
