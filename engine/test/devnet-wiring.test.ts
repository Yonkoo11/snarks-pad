// Devnet wiring: a private RPC key never reaches a log, the key file loader, and the Zcash testnet list-tx format
// (the unit is TAZ, not ZEC: the first real testnet run read 0 zats from a 0.02 TAZ note before this was fixed).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecretEnvFile, redactSecrets, redactedErrorText } from "../src/util/redact";
import { parseReceivedInTx } from "../src/zcash/devtool";

const KEY = "k3y-0123456789abcdef-NOT-A-REAL-KEY";

describe("redaction", () => {
  test("an api-key query parameter is masked wherever it appears", () => {
    const text = `failed: https://devnet.helius-rpc.com/?api-key=${KEY} and x-api-key: ${KEY}, apikey=${KEY}&b=1`;
    const out = redactSecrets(text);
    expect(out).not.toContain(KEY);
    expect(out).toContain("devnet.helius-rpc.com");
    expect(out).toContain("&b=1");
  });

  test("the literal value of a secret env var is masked even when bare", () => {
    process.env.HELIUS_API_KEY = KEY;
    try {
      expect(redactSecrets(`token ${KEY} leaked`)).not.toContain(KEY);
      expect(redactedErrorText(new Error(`boom ${KEY}`))).not.toContain(KEY);
    } finally {
      delete process.env.HELIUS_API_KEY;
    }
  });

  test("a whole engine process on a dead keyed RPC prints neither the key nor the url's query, caught or uncaught", () => {
    const rpc = `http://127.0.0.1:1/?api-key=${KEY}`;
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "helpers", "redaction-probe.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, PAD_MODE: "devnet", SOLANA_DEVNET_RPC: rpc, PAD_ENV_FILE: "/nonexistent", PAD_DB_FILE: join(mkdtempSync(join(tmpdir(), "redact-")), "x.sqlite") },
    });
    const all = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    expect(all).toContain("mode devnet"); // it really ran
    expect(all).toContain("caught:"); // and really failed on the RPC
    expect(all).toContain("uncaught"); // and the uncaught error was printed
    expect(all).not.toContain(KEY);
    expect(r.exitCode).not.toBe(0);
  });

  test("the key file is loaded into the environment without overriding what is already set, and a missing file is fine", () => {
    const dir = mkdtempSync(join(tmpdir(), "keyfile-"));
    const file = join(dir, "rpc-vars");
    writeFileSync(file, `# comment\nHELIUS_TEST_A=${KEY}\nexport HELIUS_TEST_B="quoted value 1234"\nHELIUS_TEST_C=from-file\n`);
    process.env.HELIUS_TEST_C = "already-set";
    try {
      expect(loadSecretEnvFile(file).sort()).toEqual(["HELIUS_TEST_A", "HELIUS_TEST_B"]);
      expect(process.env.HELIUS_TEST_A).toBe(KEY);
      expect(process.env.HELIUS_TEST_B).toBe("quoted value 1234");
      expect(process.env.HELIUS_TEST_C).toBe("already-set");
      expect(loadSecretEnvFile(join(dir, "missing"))).toEqual([]);
    } finally {
      for (const n of ["HELIUS_TEST_A", "HELIUS_TEST_B", "HELIUS_TEST_C"]) delete process.env[n];
    }
  });
});

describe("zcash testnet list-tx", () => {
  const TXID = "035b43bc8287eee17401d1b6aff02b3bce970186df6013b8f2f22c89c135a155";
  const LISTING = `Transactions:
${TXID}
     Mined: 4429568 (2026-10-01 18:55:32.0 +00:00:00)
    Amount:   0.02000000 TAZ
  Fee paid: Unknown
  Sent 0 notes, received 1 notes, 0 memos
  Output 1 (Ironwood)
    Value:   0.02000000 TAZ
    Received by account: 30905d88-4a7a-466f-ba1a-7be96a9f7e85 (pad-treasury)
    To: utest1xxxx
${"0123456789abcdef".repeat(4)}
     Mined: 4429000 (2026-10-01 18:00:00.0 +00:00:00)
  Output 0 (Ironwood)
    Value:   9.00000000 TAZ
    Received by account: 30905d88-4a7a-466f-ba1a-7be96a9f7e85 (pad-treasury)
`;

  test("a TAZ output is read exactly, and only this tx's outputs count", () => {
    expect(parseReceivedInTx(LISTING, TXID)).toEqual({ zats: 2_000_000n, minedHeight: 4_429_568 });
  });

  test("ZEC and REG units read the same, an unseen tx is null, and a send-only tx is 0", () => {
    expect(parseReceivedInTx(LISTING.replaceAll("TAZ", "ZEC"), TXID)?.zats).toBe(2_000_000n);
    expect(parseReceivedInTx(LISTING.replaceAll("TAZ", "REG"), TXID)?.zats).toBe(2_000_000n);
    expect(parseReceivedInTx(LISTING, "f".repeat(64))).toBeNull();
    const sendOnly = `${TXID}\n     Mined: 5 (x)\n  Output 0 (Ironwood)\n    Value:   1.00000000 TAZ\n    Sent to: utest1abc\n`;
    expect(parseReceivedInTx(sendOnly, TXID)).toEqual({ zats: 0n, minedHeight: 5 });
  });
});
