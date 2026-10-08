// Audit S2-13: POST /optin ran the address check, which spawns zcash-devtool
// synchronously (blocking the whole API process), BEFORE checking the
// signature or the nonce. Anyone could make the server spawn a process per
// request with a junk signature. The spawn must come only after both pass.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../src/config";
import { handleRequest } from "../src/api";

const work = mkdtempSync(join(tmpdir(), "audit-optin-"));
const log = join(work, "spawns.log");
const stub = join(work, "zcash-devtool");
writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\n`);
chmodSync(stub, 0o755);
const paths = config.paths as unknown as Record<string, string>;
const savedBin = paths.zcashDevtoolBin!;
afterEach(() => {
  paths.zcashDevtoolBin = savedBin;
});

test("S2-13: a junk signature is refused without spawning zcash-devtool", async () => {
  paths.zcashDevtoolBin = stub;
  writeFileSync(log, "");
  const wallet = Keypair.generate().publicKey.toBase58();
  const { nonce } = (await (await handleRequest(new Request(`http://pad.test/api/optin/nonce?wallet=${wallet}`))).json()) as { nonce: string };
  const zcashAddress = "uregtest1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(4);
  const signature = bs58.encode(new Uint8Array(64).fill(7));
  const res = await handleRequest(new Request("http://pad.test/api/optin", { method: "POST", body: JSON.stringify({ wallet, zcashAddress, nonce, signature }) }));
  expect(((await res.json()) as { error: string }).error).toBe("invalid_signature");
  expect(readFileSync(log, "utf8")).toBe("");
});
