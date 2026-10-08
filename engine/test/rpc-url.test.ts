// The devnet RPC is a full URL from any provider (SOLANA_DEVNET_RPC) that wins over the Helius key; the websocket address web3.js uses for confirmations
// is that URL over wss; startup says only the URL's host; and the provider's key, which QuickNode and Alchemy keep in the URL's PATH, is masked wherever
// it would be printed. The tokens below are made up and shaped like the real ones; no real endpoint is used or contacted.
import { afterAll, describe, expect, test } from "bun:test";
import { Connection } from "@solana/web3.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devnetRpc, rpcHost } from "../src/config";
import { redactSecrets } from "../src/util/redact";

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const QUICKNODE = `https://example-name.solana-devnet.quiknode.pro/${TOKEN}/`;
const HELIUS_KEY = "k3y-0123456789abcdef-NOT-A-REAL-KEY";
const HELIUS = `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const PUBLIC = "https://api.devnet.solana.com";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

describe("which devnet RPC the engine uses", () => {
  test("a full URL wins over the Helius key, and is used exactly as written", () => {
    expect(devnetRpc({ SOLANA_DEVNET_RPC: QUICKNODE, HELIUS_API_KEY: HELIUS_KEY })).toBe(QUICKNODE);
    expect(devnetRpc({ SOLANA_DEVNET_RPC: QUICKNODE })).toBe(QUICKNODE);
  });

  test("the Helius key alone gives the Helius devnet endpoint; neither gives the public one", () => {
    expect(devnetRpc({ HELIUS_API_KEY: HELIUS_KEY })).toBe(HELIUS);
    expect(devnetRpc({})).toBe(PUBLIC);
  });

  test("an empty or blank full URL is not set: the line a systemd env file leaves after `SOLANA_DEVNET_RPC=`", () => {
    expect(devnetRpc({ SOLANA_DEVNET_RPC: "", HELIUS_API_KEY: HELIUS_KEY })).toBe(HELIUS);
    expect(devnetRpc({ SOLANA_DEVNET_RPC: "   ", HELIUS_API_KEY: HELIUS_KEY })).toBe(HELIUS);
    expect(devnetRpc({ SOLANA_DEVNET_RPC: "" })).toBe(PUBLIC);
  });

  test("blanks around a full URL are dropped (web3.js refuses an address that does not start with http)", () => {
    expect(devnetRpc({ SOLANA_DEVNET_RPC: ` ${QUICKNODE}\n` })).toBe(QUICKNODE);
  });

  test.each([
    ["words", `not a url ${TOKEN}`],
    ["a websocket address", `wss://example-name.solana-devnet.quiknode.pro/${TOKEN}/`],
    ["another scheme", `ftp://example-name.solana-devnet.quiknode.pro/${TOKEN}/`],
    ["a host with a space in it", `https://bad host.example/${TOKEN}`],
    ["a scheme and nothing else", "https://"],
  ])("%s stops startup, and the error does not carry the value", (_label, value) => {
    const message = messageOf(() => devnetRpc({ SOLANA_DEVNET_RPC: value, HELIUS_API_KEY: HELIUS_KEY }));
    expect(message).toContain("SOLANA_DEVNET_RPC must be an http(s) URL");
    expect(message).not.toContain(TOKEN);
  });
});

describe("the websocket address", () => {
  const wsOf = (url: string): string => (new Connection(url) as unknown as { _rpcWsEndpoint: string })._rpcWsEndpoint;

  test("web3.js derives it from the full URL: the same host, path and query over wss", () => {
    expect(wsOf(QUICKNODE)).toBe(`wss://example-name.solana-devnet.quiknode.pro/${TOKEN}/`);
    expect(wsOf(HELIUS)).toBe(`wss://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
    expect(wsOf(PUBLIC)).toBe("wss://api.devnet.solana.com");
  });
});

describe("what a log line may say of the RPC", () => {
  test("rpcHost is the host and port, never the path, the query or a login", () => {
    expect(rpcHost(QUICKNODE)).toBe("example-name.solana-devnet.quiknode.pro");
    expect(rpcHost(HELIUS)).toBe("devnet.helius-rpc.com");
    expect(rpcHost("http://user:secret-pw@127.0.0.1:8899/x?y=1")).toBe("127.0.0.1:8899");
    expect(rpcHost(`garbage ${TOKEN}`)).toBe("(not a URL)");
  });
});

describe("a full RPC URL is masked in everything printed", () => {
  function withEnv<T>(name: string, value: string, body: () => T): T {
    process.env[name] = value;
    try {
      return body();
    } finally {
      delete process.env[name];
    }
  }

  test("a QuickNode URL's token is masked whole, as a path and bare; the host stays readable", () => {
    withEnv("SOLANA_DEVNET_RPC", QUICKNODE, () => {
      const out = redactSecrets(`rpc ${QUICKNODE} failed; path /${TOKEN}/ ; bare ${TOKEN}; host ${rpcHost(QUICKNODE)}`);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("example-name.solana-devnet.quiknode.pro");
    });
  });

  test("an Alchemy-style mainnet URL keeps its host and its `v2` and loses its key; a provider's query key and a login are masked too", () => {
    const alchemy = `https://solana-mainnet.g.alchemy.com/v2/${TOKEN}`;
    withEnv("SOLANA_MAINNET_RPC", alchemy, () => {
      const out = redactSecrets(`calling ${alchemy}`);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("solana-mainnet.g.alchemy.com/v2/");
    });
    withEnv("SOLANA_DEVNET_RPC", `https://lb.example.test/rpc?network=solana-devnet&dkey=${TOKEN}`, () => {
      expect(redactSecrets(`dkey seen as ${TOKEN}`)).not.toContain(TOKEN);
    });
    withEnv("SOLANA_DEVNET_RPC", "https://someone:pw-0123456789@rpc.example.test/", () => {
      expect(redactSecrets("login pw-0123456789 someone")).not.toContain("pw-0123456789");
    });
  });

  test("a URL with nothing secret in it leaves the log readable, and an unparseable value is masked whole", () => {
    withEnv("SOLANA_DEVNET_RPC", PUBLIC, () => expect(redactSecrets(`using ${PUBLIC}`)).toBe(`using ${PUBLIC}`));
    withEnv("SOLANA_DEVNET_RPC", `not a url ${TOKEN}`, () => expect(redactSecrets(`oops not a url ${TOKEN}`)).not.toContain(TOKEN));
  });
});

describe("a whole API process on a full URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "rpc-url-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("starts on the full URL, not the Helius key, and its startup line names the host only", async () => {
    const proc = Bun.spawn(["bun", "scripts/api.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH!, HOME: process.env.HOME!, PAD_MODE: "devnet", PAD_ENV_FILE: "/nonexistent",
        SOLANA_DEVNET_RPC: `http://127.0.0.1:1/${TOKEN}/`, HELIUS_API_KEY: HELIUS_KEY,
        PAD_DB_FILE: join(dir, "x.sqlite"), PUBLIC_DIR: join(dir, "public"), PAD_API_PORT: "0", PAD_API_HOST: "127.0.0.1",
      },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let text = "";
      const deadline = Date.now() + 20_000;
      while (!text.includes("snarks-engine API on") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toMatch(/snarks-engine API on :\d+ \(PAD_MODE=devnet, RPC host 127\.0\.0\.1:1\)/);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(HELIUS_KEY);
      expect(text).not.toContain("helius");
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
