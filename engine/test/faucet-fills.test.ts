// The devnet faucet, sized for a judge session and watched (2026-10-04). The live faucet key held 0.059 SOL while a fill paid 0.1
// and the key had to keep 0.05 more, so every judge click answered 503 faucet_unavailable.
//   - PAD_FAUCET_SOL (0.02) is what one fill pays, PAD_FAUCET_MIN_RESERVE_SOL (0.01) what the key keeps; a bad value stops startup (S3-03).
//   - fillsLeftFor() is the one count behind both the gate in fundTestWallet and the status GET /treasury publishes.
//   - GET /treasury carries faucet: { available, fillsLeft } on devnet, cached so a busy page cannot drain the RPC quota.
// Devnet-mode cases run in this process (local mode) with config.mode switched for the test, the key directory pointed at a
// temporary one and the RPC methods stubbed: nothing here touches a real faucet key or a network.
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemInstruction, SystemProgram, type Transaction } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { handleRequest } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { FILL_OVERHEAD_LAMPORTS, faucetFund, faucetStatusForView, fillsLeftFor, fundTestWallet, loadFaucetKeypair, readFaucet } from "../src/faucet";
import { getConnection } from "../src/solana";
import { devtoolPresent } from "./helpers/validator-up";

const cfg = config as unknown as { mode: string; paths: { keysDir: string } };
const realMode = cfg.mode;
const realKeysDir = cfg.paths.keysDir;
const conn = getConnection();
const real = { getBalance: conn.getBalance.bind(conn), getAccountInfo: conn.getAccountInfo.bind(conn), sendTransaction: conn.sendTransaction.bind(conn) };
const lamports = (sol: number): number => Math.round(sol * 1e9);

// Moves only forward: the status cache remembers when it was read, so a test that rewinds the clock would see a fresh cache.
let clock = Date.now();
const advance = (ms: number): void => {
  clock += ms;
  setSystemTime(new Date(clock));
};

afterEach(() => {
  cfg.mode = realMode;
  cfg.paths.keysDir = realKeysDir;
  conn.getBalance = real.getBalance;
  conn.getAccountInfo = real.getAccountInfo;
  conn.sendTransaction = real.sendTransaction;
});
afterAll(() => setSystemTime());

/** Switches to devnet with an empty temporary key directory and returns the faucet key made in it. */
function devnet(): Keypair {
  cfg.mode = "devnet";
  cfg.paths.keysDir = mkdtempSync(join(tmpdir(), "faucet-keys-"));
  return loadFaucetKeypair();
}

function mintAccount(authority: PublicKey) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply: 0n, decimals: config.solana.dbc.quoteDecimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data };
}

/** A chain where the faucet key is the quote mint's authority and holds `balance` lamports. Every send is recorded and then stops the fill. */
function stubChain(faucet: Keypair, balance: number): { sent: Transaction[]; balanceReads: () => number } {
  const sent: Transaction[] = [];
  let reads = 0;
  const { quoteMint } = config.solana.dbc;
  conn.getAccountInfo = (async (key: PublicKey) => (key.equals(quoteMint) ? mintAccount(faucet.publicKey) : null)) as unknown as typeof conn.getAccountInfo;
  conn.getBalance = (async () => { reads++; return balance; }) as unknown as typeof conn.getBalance;
  conn.sendTransaction = (async (tx: Transaction) => { sent.push(tx); throw new Error("stop after the first send"); }) as unknown as typeof conn.sendTransaction;
  return { sent, balanceReads: () => reads };
}

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { code?: string }) => e.code ?? e.message);
const claims = (w: string) => (db.getDb().query("SELECT COUNT(*) AS n FROM faucet_claims WHERE wallet = $w").get({ $w: w }) as { n: number }).n;

describe("fillsLeftFor: how many fills the faucet key can still pay", () => {
  const FILL = 20_000_000; // 0.02 SOL
  const GATE = FILL + 10_000_000; // a fill goes ahead only while the key holds the fill plus the 0.01 SOL reserve
  const COST = FILL + FILL_OVERHEAD_LAMPORTS; // what one fill takes from the key: the SOL, the recipient's token account, three fees
  const count = (balance: number) => fillsLeftFor(balance, 0.02, 0.01);

  test("below the gate there is none", () => {
    expect(count(0)).toBe(0);
    expect(count(GATE - 1)).toBe(0);
  });

  test("at the gate there is one; each further fill needs its whole cost on top", () => {
    expect(count(GATE)).toBe(1);
    expect(count(GATE + COST - 1)).toBe(1);
    expect(count(GATE + COST)).toBe(2);
    expect(count(GATE + 9 * COST)).toBe(10);
  });

  test("the live faucet of 2026-10-04 (0.059 SOL) could pay two fills where it paid none before", () => {
    expect(count(59_000_000)).toBe(2);
    expect(fillsLeftFor(59_000_000, 0.1, 0.05)).toBe(0); // the old sizing: a 0.1 fill plus the 0.05 floor
  });

  test("the count equals what happens when fills are paid one at a time until the gate stops them, at every balance", () => {
    for (let balance = 0; balance <= 600_000_000; balance += 3_700_001) {
      let left = balance;
      let paid = 0;
      while (left >= GATE) {
        left -= COST;
        paid++;
      }
      expect(count(balance)).toBe(paid);
    }
  });
});

function loadFaucetConfig(env: Record<string, string>): { exitCode: number; faucet: { devnetSol: number; minReserveSol: number } | null } {
  const p = Bun.spawnSync(["bun", "-e", "const { config } = await import('./src/config.ts'); console.log(JSON.stringify(config.faucet))"], {
    cwd: `${import.meta.dir}/..`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PAD_MODE: "mainnet", PAD_DB_FILE: "/dev/null", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const last = p.stdout.toString().trim().split("\n").pop() ?? "";
  return { exitCode: p.exitCode, faucet: p.exitCode === 0 ? JSON.parse(last) : null };
}

describe("PAD_FAUCET_SOL and PAD_FAUCET_MIN_RESERVE_SOL are validated like the other safety knobs (S3-03)", () => {
  test("unset, or set to nothing, gives 0.02 SOL a fill and a 0.01 SOL reserve", () => {
    expect(loadFaucetConfig({}).faucet).toEqual({ devnetSol: 0.02, minReserveSol: 0.01 });
    expect(loadFaucetConfig({ PAD_FAUCET_SOL: "", PAD_FAUCET_MIN_RESERVE_SOL: "  " }).faucet).toEqual({ devnetSol: 0.02, minReserveSol: 0.01 });
  });

  test("plain decimals inside 0.003..1 are taken as written", () => {
    expect(loadFaucetConfig({ PAD_FAUCET_SOL: "0.05", PAD_FAUCET_MIN_RESERVE_SOL: " 0.02 " }).faucet).toEqual({ devnetSol: 0.05, minReserveSol: 0.02 });
    expect(loadFaucetConfig({ PAD_FAUCET_SOL: "0.003", PAD_FAUCET_MIN_RESERVE_SOL: "1" }).faucet).toEqual({ devnetSol: 0.003, minReserveSol: 1 });
    expect(loadFaucetConfig({ PAD_FAUCET_SOL: "0.123456789" }).faucet?.devnetSol).toBe(0.123456789);
  });

  for (const bad of ["abc", "-1", "0.002", "2", "1e-2", "0x10", "Infinity", "0.0200000001", "0,02"]) {
    test(`PAD_FAUCET_SOL=${bad} stops startup`, () => {
      expect(loadFaucetConfig({ PAD_FAUCET_SOL: bad }).exitCode).not.toBe(0);
    });
  }
  for (const bad of ["abc", "0", "0.002", "2"]) {
    test(`PAD_FAUCET_MIN_RESERVE_SOL=${bad} stops startup`, () => {
      expect(loadFaucetConfig({ PAD_FAUCET_MIN_RESERVE_SOL: bad }).exitCode).not.toBe(0);
    });
  }
});

describe("the gate and the amount of a devnet fill", () => {
  const owner = () => Keypair.generate().publicKey;

  test("a faucet key under one fill plus the reserve refuses with faucet_unavailable and sends nothing", async () => {
    const faucet = devnet();
    const { sent, balanceReads } = stubChain(faucet, lamports(config.faucet.devnetSol + config.faucet.minReserveSol) - 1);
    expect(await codeOf(fundTestWallet(owner(), 5, faucet))).toBe("faucet_unavailable");
    expect(balanceReads()).toBe(1);
    expect(sent).toEqual([]);
  });

  test("at the gate the first thing sent is PAD_FAUCET_SOL from the faucet key, whatever amount the caller asked for", async () => {
    const faucet = devnet();
    const to = owner();
    const { sent } = stubChain(faucet, lamports(config.faucet.devnetSol + config.faucet.minReserveSol));
    expect(await codeOf(fundTestWallet(to, 5, faucet))).toBe("stop after the first send");
    expect(sent.length).toBe(1);
    const transfer = SystemInstruction.decodeTransfer(sent[0]!.instructions[0]!);
    expect(transfer.fromPubkey.toBase58()).toBe(faucet.publicKey.toBase58());
    expect(transfer.toPubkey.toBase58()).toBe(to.toBase58());
    expect(Number(transfer.lamports)).toBe(lamports(config.faucet.devnetSol));
  });

  test("POST /faucet on a dry key answers 503 faucet_unavailable, sends nothing and leaves no cooldown behind", async () => {
    const faucet = devnet();
    const { sent } = stubChain(faucet, 1_000_000);
    const wallet = owner().toBase58();
    const res = await handleRequest(new Request("http://pad.test/api/faucet", { method: "POST", body: JSON.stringify({ wallet }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "faucet_unavailable" });
    expect(sent).toEqual([]);
    expect(claims(wallet)).toBe(0); // a failed fill must not burn the wallet's 10 minutes
  });

  test("the HTTP faucet still refuses a wallet that cannot receive before it looks at the balance", async () => {
    const faucet = devnet();
    const { balanceReads } = stubChain(faucet, 5e9);
    const pda = PublicKey.findProgramAddressSync([Buffer.from("not-a-wallet")], SystemProgram.programId)[0].toBase58();
    expect(await codeOf(faucetFund(pda))).toBe("bad_wallet");
    expect(balanceReads()).toBe(0);
  });
});

describe("readFaucet and the public status", () => {
  test("outside devnet there is no faucet: no reading, no status, no balance read", async () => {
    const reads = { n: 0 };
    conn.getBalance = (async () => { reads.n++; return 0; }) as unknown as typeof conn.getBalance;
    expect(await readFaucet()).toBeNull();
    expect(await faucetStatusForView()).toBeNull();
    expect(reads.n).toBe(0);
  });

  test("a reading names the key, its balance and the fills that balance buys", async () => {
    const faucet = devnet();
    stubChain(faucet, 59_000_000);
    const r = await readFaucet();
    expect(r).toEqual({ address: faucet.publicKey.toBase58(), lamports: 59_000_000, fillsLeft: fillsLeftFor(59_000_000), available: fillsLeftFor(59_000_000) >= 1 });
    stubChain(faucet, 1_000_000);
    expect(await readFaucet()).toMatchObject({ lamports: 1_000_000, fillsLeft: 0, available: false });
  });

  test("a missing key file is an error, and reading it never makes a key", async () => {
    devnet();
    cfg.paths.keysDir = mkdtempSync(join(tmpdir(), "faucet-nokey-"));
    await expect(readFaucet()).rejects.toThrow("faucet key file does not exist");
    expect(existsSync(join(cfg.paths.keysDir, "faucet-devnet.json"))).toBe(false);
  });

  test("the public status is read once per 30 s however many ask, and again after that", async () => {
    const faucet = devnet();
    const { balanceReads } = stubChain(faucet, 5e9);
    advance(60_000); // older than whatever an earlier test left in the cache
    const wave = await Promise.all(Array.from({ length: 25 }, () => faucetStatusForView()));
    expect(balanceReads()).toBe(1);
    expect(new Set(wave.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(wave[0]).toEqual({ available: true, fillsLeft: fillsLeftFor(5e9) });
    advance(29_000);
    await faucetStatusForView();
    expect(balanceReads()).toBe(1);
    advance(2_000);
    await faucetStatusForView();
    expect(balanceReads()).toBe(2);
  });

  test("a balance that cannot be read is reported as unavailable, not as an error, and is not retried for 30 s", async () => {
    const faucet = devnet();
    stubChain(faucet, 5e9);
    let attempts = 0;
    conn.getBalance = (async () => { attempts++; throw new Error("rpc down"); }) as unknown as typeof conn.getBalance;
    advance(60_000);
    expect(await faucetStatusForView()).toEqual({ available: false, fillsLeft: 0 });
    expect(await faucetStatusForView()).toEqual({ available: false, fillsLeft: 0 });
    expect(attempts).toBe(1);
  });

  test("a missing key file also reads as unavailable", async () => {
    devnet();
    cfg.paths.keysDir = mkdtempSync(join(tmpdir(), "faucet-nokey-"));
    advance(60_000);
    expect(await faucetStatusForView()).toEqual({ available: false, fillsLeft: 0 });
  });
});

describe("GET /treasury carries the faucet status", () => {
  // Real time here: the treasury balance behind this route has its own cache and must not be stamped with a made-up clock.
  beforeEach(() => setSystemTime());
  const treasury = async () => (await (await handleRequest(new Request("http://pad.test/api/treasury"))).json()) as { faucet: unknown; paused: boolean };

  test.if(devtoolPresent())("local mode (no faucet route): faucet is null (reads the treasury wallet)", async () => {
    expect((await treasury()).faucet).toBeNull();
  });

  test.if(devtoolPresent())("devnet: faucet is { available, fillsLeft } from the faucet key's balance, and nothing else about the key (reads the treasury wallet)", async () => {
    const faucet = devnet();
    stubChain(faucet, 59_000_000);
    const body = await treasury();
    expect(body.faucet).toEqual({ available: true, fillsLeft: fillsLeftFor(59_000_000) });
    expect(JSON.stringify(body)).not.toContain(faucet.publicKey.toBase58());
  });
});

describe("what the pages and the contract say about the amount", () => {
  const repo = (...p: string[]) => readFileSync(join(config.paths.repoRoot, ...p), "utf8");
  const hasContract = existsSync(join(config.paths.repoRoot, "ai", "api-contract.md"));

  test("the banner reads both amounts from the faucet's answer and has plain words for a dry faucet", () => {
    const src = repo("web", "src", "components", "ModeBanner.svelte");
    expect(src).toContain("funds.sol");
    expect(src).toContain("funds.zecZats");
    expect(src).not.toMatch(/\b0\.1\b|5 test ZEC/); // the old hard-coded amounts
    expect(src).toContain("Test money temporarily unavailable");
  });

  test.if(hasContract)("the contract's faucet line names the two knobs, the amount the answer carries and the treasury field", () => {
    const contract = repo("ai", "api-contract.md");
    const line = contract.split("\n").find((l) => l.startsWith("POST /faucet"))!;
    expect(line).toContain("PAD_FAUCET_SOL");
    expect(line).toContain("PAD_FAUCET_MIN_RESERVE_SOL");
    expect(line).not.toMatch(/0\.1 devnet SOL/);
    expect(contract).toContain("faucet: { available: boolean, fillsLeft: number } | null");
  });
});
