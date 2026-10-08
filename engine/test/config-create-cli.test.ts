// The creation tools run as the owner will run them: as commands, against the local validator (mainnet DBC
// and Squads binaries, real ZEC mint). Each test gets a fresh keeper key and a fresh database so nothing
// is shared with other test files.
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { feeNumeratorToBps } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { feeAfterWindow, verifyConfigState } from "../src/dbc/config";
import { KEEPER_PERMISSIONS, vaultOf } from "../src/dbc/squads";
import { getConnection, getDbcClient } from "../src/solana";
import { validatorUp } from "./helpers/validator-up";

const live = await validatorUp();

const CONFIG_FLAG = "--i-understand-this-creates-a-permanent-config";
const MULTISIG_FLAG = "--i-understand-this-creates-a-permanent-multisig";
const conn = () => getConnection();

interface Sandbox {
  keeper: Keypair;
  dbFile: string;
  run: (script: string, args: string[], extraEnv?: Record<string, string>) => { code: number; out: string };
}

async function sandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), "cfgcreate-"));
  const keeper = Keypair.generate();
  const keyFile = join(dir, "keeper.json");
  writeFileSync(keyFile, JSON.stringify(Array.from(keeper.secretKey)), { mode: 0o600 });
  await conn().confirmTransaction(await conn().requestAirdrop(keeper.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  const dbFile = join(dir, "pad.sqlite");
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, PAD_DB_FILE: dbFile, KEEPER_KEYPAIR_PATH: keyFile };
  const run = (script: string, args: string[], extraEnv: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bun", `scripts/${script}.ts`, ...args], { cwd: config.paths.engineRoot, env: { ...env, ...extraEnv } });
    return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { keeper, dbFile, run };
}

const lamports = async (k: PublicKey) => BigInt(await conn().getBalance(k, "confirmed"));
const metaOf = (dbFile: string, key: string): string | null => {
  const d = new Database(dbFile, { readonly: true });
  try {
    return (d.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  } finally {
    d.close();
  }
};
const configRows = (dbFile: string): number => {
  const d = new Database(dbFile, { readonly: true });
  try {
    return (d.query("SELECT COUNT(*) AS n FROM dbc_configs").get() as { n: number }).n;
  } finally {
    d.close();
  }
};

/** A multisig of an arbitrary (possibly wrong) shape, made directly with the Squads SDK. */
async function oddMultisig(keeper: PublicKey, over: { threshold?: number; configAuthority?: PublicKey | null; rentCollector?: PublicKey | null; timeLock?: number }): Promise<PublicKey> {
  const owner = Keypair.generate();
  const createKey = Keypair.generate();
  await conn().confirmTransaction(await conn().requestAirdrop(owner.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  const [multisigPda] = sqds.getMultisigPda({ createKey: createKey.publicKey });
  const { treasury } = await sqds.accounts.ProgramConfig.fromAccountAddress(conn(), sqds.getProgramConfigPda({})[0]);
  const ix = sqds.instructions.multisigCreateV2({
    treasury, creator: owner.publicKey, multisigPda, configAuthority: over.configAuthority ?? null, threshold: over.threshold ?? 2, timeLock: over.timeLock ?? 0,
    createKey: createKey.publicKey, rentCollector: over.rentCollector === undefined ? keeper : over.rentCollector,
    members: [
      { key: owner.publicKey, permissions: sqds.types.Permissions.all() },
      { key: Keypair.generate().publicKey, permissions: sqds.types.Permissions.all() },
      { key: keeper, permissions: KEEPER_PERMISSIONS },
    ],
  });
  await sendAndConfirmTransaction(conn(), new Transaction().add(ix), [owner, createKey], { commitment: "confirmed" });
  return multisigPda;
}

/** The command's output, if it did not succeed (so a failing test shows why). */
const ok = (r: { code: number; out: string }): void => {
  if (r.code !== 0) throw new Error(`exit ${r.code}:\n${r.out.slice(-1500)}`);
};

const addr = () => Keypair.generate().publicKey.toBase58();

describe.if(live)("squads:create", () => {
  let sb: Sandbox;
  const owner = addr();
  const backup = addr();
  beforeAll(async () => {
    sb = await sandbox();
  });

  test("dry run is the default: prints the reviewed members and settings, sends nothing", async () => {
    const before = await lamports(sb.keeper.publicKey);
    const r = sb.run("squads-create", ["--owner", owner, "--backup", backup]);
    expect(r.code).toBe(0);
    for (const needle of [owner, backup, sb.keeper.publicKey.toBase58(), "threshold 2", "time lock 0", "config authority none", "DRY RUN"]) expect(r.out).toContain(needle);
    expect(await lamports(sb.keeper.publicKey)).toBe(before);
    expect(metaOf(sb.dbFile, "squads_multisig_created")).toBeNull();
  });

  test.each([
    ["the same address for owner and backup", () => [owner, owner], /same address/],
    ["the keeper as owner", () => [sb.keeper.publicKey.toBase58(), backup], /same address/],
    ["an off-curve (PDA) owner", () => [sqds.getProgramConfigPda({})[0].toBase58(), backup], /off the ed25519 curve/],
  ])("refuses %s, even with the real-send flag", async (_label, who, pattern) => {
    const [o, b] = who();
    const before = await lamports(sb.keeper.publicKey);
    const r = sb.run("squads-create", ["--owner", o!, "--backup", b!, MULTISIG_FLAG]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(pattern);
    expect(await lamports(sb.keeper.publicKey)).toBe(before);
  });

  test("a keeper without SOL is refused before anything is sent", async () => {
    const poor = await sandbox();
    await sendAndConfirmTransaction(conn(), new Transaction().add(
      (await import("@solana/web3.js")).SystemProgram.transfer({ fromPubkey: poor.keeper.publicKey, toPubkey: Keypair.generate().publicKey, lamports: Number(await lamports(poor.keeper.publicKey)) - 5_000 }),
    ), [poor.keeper], { commitment: "confirmed" });
    const r = poor.run("squads-create", ["--owner", owner, "--backup", backup, MULTISIG_FLAG]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/needs at least/);
  });

  test("real send with the flag: the chain holds exactly the reviewed multisig; a second creation is refused", async () => {
    const r = sb.run("squads-create", ["--owner", owner, "--backup", backup, MULTISIG_FLAG]);
    ok(r);
    const multisig = new PublicKey(/multisig: (\w+)/.exec(r.out)![1]!);
    const vault = new PublicKey(/vault: (\w+)/.exec(r.out)![1]!);
    const ms = await sqds.accounts.Multisig.fromAccountAddress(conn(), multisig, "confirmed");
    expect(vaultOf(multisig).toBase58()).toBe(vault.toBase58());
    expect([ms.threshold, ms.timeLock, ms.members.length]).toEqual([2, 0, 3]);
    expect(ms.configAuthority.toBase58()).toBe(PublicKey.default.toBase58());
    expect(ms.rentCollector?.toBase58()).toBe(sb.keeper.publicKey.toBase58());
    const masks = new Map(ms.members.map((m) => [m.key.toBase58(), m.permissions.mask]));
    expect([...masks.keys()].sort()).toEqual([owner, backup, sb.keeper.publicKey.toBase58()].sort());
    expect([...masks.values()]).toEqual([7, 7, 7]);
    expect(JSON.parse(metaOf(sb.dbFile, "squads_multisig_created")!).multisig).toBe(multisig.toBase58());
    expect(metaOf(sb.dbFile, "squads_multisig_pending")).toBeNull();

    const again = sb.run("squads-create", ["--owner", owner, "--backup", backup, MULTISIG_FLAG]);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/already created/);
  });
});

describe.if(live)("config:create", () => {
  let sb: Sandbox;
  let multisig: PublicKey;
  let vault: PublicKey;
  beforeAll(async () => {
    sb = await sandbox();
    const r = sb.run("squads-create", ["--owner", addr(), "--backup", addr(), MULTISIG_FLAG]);
    expect(r.code).toBe(0);
    multisig = new PublicKey(/multisig: (\w+)/.exec(r.out)![1]!);
    vault = vaultOf(multisig);
  });

  const configsOf = async (v: PublicKey) => (await getDbcClient().state.getPoolConfigsByOwner(v)).filter((c) => c.account.feeClaimer.equals(v));

  test("dry run is the default: every field and the vault are printed, nothing is signed or sent", async () => {
    const before = await lamports(sb.keeper.publicKey);
    const r = sb.run("config-create", ["--multisig", multisig.toBase58()]);
    expect(r.code).toBe(0);
    for (const needle of [vault.toBase58(), "DRY RUN", "migrationQuoteThreshold", "666666666", "feeClaimer", "leftoverReceiver", "curve[1].liquidity"]) expect(r.out).toContain(needle);
    // the launch window (CONFIG-REVIEW-TIERS section 5): a 99% cliff, 5 steps of 1 s, 196,000,000 off each step (down to the 1% = 10,000,000 the tier keeps)
    expect(r.out).toMatch(/poolFees\.baseFee\.cliffFeeNumerator\s+990000000\n/);
    expect(r.out).toMatch(/poolFees\.baseFee\.thirdFactor\s+196000000\n/);
    expect(r.out).toContain("Launch window (fee scheduler, linear): 99% in the first second");
    expect(await lamports(sb.keeper.publicKey)).toBe(before);
    expect((await configsOf(vault)).length).toBe(0);
    expect(configRows(sb.dbFile)).toBe(0);
  });

  test.each([
    ["a threshold of 1", { threshold: 1 }, /threshold is 1/],
    ["a config authority", { configAuthority: Keypair.generate().publicKey }, /config authority/],
    ["a rent collector that is not the keeper", { rentCollector: Keypair.generate().publicKey }, /rent collector/],
    ["no rent collector", { rentCollector: null }, /rent collector is none/],
    ["a time lock", { timeLock: 3600 }, /time lock/],
  ])("refuses a multisig with %s, with or without the flag, and creates nothing", async (_label, over, pattern) => {
    const odd = await oddMultisig(sb.keeper.publicKey, over);
    const oddVault = vaultOf(odd);
    for (const flags of [[], [CONFIG_FLAG]]) {
      const r = sb.run("config-create", ["--multisig", odd.toBase58(), ...flags]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(pattern);
    }
    expect((await configsOf(oddVault)).length).toBe(0);
  });

  test("refuses an address that is not a Squads multisig, and one that does not exist", () => {
    expect(sb.run("config-create", ["--multisig", Keypair.generate().publicKey.toBase58(), CONFIG_FLAG]).out).toMatch(/no account at/);
    expect(sb.run("config-create", ["--multisig", sqds.getProgramConfigPda({})[0].toBase58(), CONFIG_FLAG]).out).toMatch(/not a multisig/);
  });

  test("an earlier attempt that may still land blocks a new one; a dead one is forgotten", async () => {
    const d = new Database(sb.dbFile);
    const pending = (lastValidBlockHeight: number) => JSON.stringify({ subject: addr(), sig: "1".repeat(64), rawTx: Buffer.from("junk").toString("base64"), lastValidBlockHeight, at: new Date().toISOString() });
    d.query("INSERT INTO meta (key,value) VALUES ('dbc_config_pending', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(pending(2 ** 31));
    d.close();
    const blocked = sb.run("config-create", ["--multisig", multisig.toBase58(), CONFIG_FLAG]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(/may still land/);
    expect((await configsOf(vault)).length).toBe(0);

    const e = new Database(sb.dbFile);
    e.query("UPDATE meta SET value = ? WHERE key = 'dbc_config_pending'").run(pending(0));
    e.close();
    const dry = sb.run("config-create", ["--multisig", multisig.toBase58()]);
    expect(dry.code).toBe(0);
    expect(metaOf(sb.dbFile, "dbc_config_pending")).toBeNull();
  });

  test("real send with the flag: the config on chain passes the full-field check; a second creation is refused, here and from a fresh database", async () => {
    const r = sb.run("config-create", ["--multisig", multisig.toBase58(), CONFIG_FLAG]);
    ok(r);
    expect(r.out).toContain("0 mismatches");
    const configId = new PublicKey(/config: (\w+)/.exec(r.out)![1]!);
    const state = await getDbcClient().state.getPoolConfig(configId);
    expect(state).not.toBeNull();
    expect(verifyConfigState(state!, vault)).toEqual([]);
    expect(state!.feeClaimer.toBase58()).toBe(vault.toBase58());
    expect(state!.leftoverReceiver.toBase58()).toBe(vault.toBase58());
    expect(configRows(sb.dbFile)).toBe(1);
    expect(metaOf(sb.dbFile, "dbc_config_pending")).toBeNull();

    const again = sb.run("config-create", ["--multisig", multisig.toBase58(), CONFIG_FLAG]);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/already recorded/);

    const fresh = await sandbox(); // another keeper, an empty database, the same vault: only the chain can say it exists
    await conn().confirmTransaction(await conn().requestAirdrop(fresh.keeper.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const other = fresh.run("config-create", ["--multisig", multisig.toBase58(), CONFIG_FLAG]);
    expect(other.code).toBe(1);
    // the fresh keeper is not a member of that multisig, so the shape check refuses too; the chain check must also name the config
    expect(other.out).toContain(configId.toBase58());
    expect((await configsOf(vault)).length).toBe(1);
  });
});

describe.if(live)("config:create --tier (creator-fee tiers, audit/CONFIG-REVIEW-TIERS.md)", () => {
  let sb: Sandbox;
  let multisig: PublicKey;
  let vault: PublicKey;
  let padEnv: Record<string, string>;
  beforeAll(async () => {
    sb = await sandbox();
    const r = sb.run("squads-create", ["--owner", addr(), "--backup", addr(), MULTISIG_FLAG]);
    expect(r.code).toBe(0);
    multisig = new PublicKey(/multisig: (\w+)/.exec(r.out)![1]!);
    vault = vaultOf(multisig);
    padEnv = { SQUADS_MULTISIG: multisig.toBase58() }; // what the keeper has set once the pad's multisig exists: the one claim path
  });

  const configsOf = async (v: PublicKey) => (await getDbcClient().state.getPoolConfigsByOwner(v)).filter((c) => c.account.feeClaimer.equals(v));
  // a config's tier is the fee AFTER its launch window (the scheduler's minimum), never the 99% cliff every tier shares
  const tierCfg = async (v: PublicKey, bps: number) => (await configsOf(v)).filter((c) => feeNumeratorToBps(feeAfterWindow(c.account.poolFees.baseFee as unknown as Record<string, unknown>) as never) === bps);

  test.each([["150"], ["0"], ["abc"], ["100.5"], ["-200"], [""], ["1e3"]])("--tier %p is refused (exit 2) before anything is read or sent", (bad) => {
    const r = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", bad, CONFIG_FLAG], padEnv);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--tier must be one of 100, 200, 400, 600, 1000/);
  });

  test("dry run is the default for a tier too: who gets what per 100 ZEC and the five differing fields are printed, nothing is signed", async () => {
    const before = await lamports(sb.keeper.publicKey);
    const r = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "200"], padEnv);
    expect(r.code).toBe(0);
    for (const needle of [vault.toBase58(), "DRY RUN", "Fee tier 200 bps", "creator_trading_fee_percentage 50", "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq", "partner locked LP 50%", "creator locked LP 50%", "Per 100 ZEC traded: Meteora 0.400, creator 0.800, holders 0.600, team 0.200", "creatorTradingFeePercentage"]) {
      expect(r.out).toContain(needle);
    }
    expect(r.out).toMatch(/poolFees\.baseFee\.cliffFeeNumerator\s+990000000\n/);
    expect(r.out).toMatch(/poolFees\.baseFee\.thirdFactor\s+194000000\n/);
    expect(await lamports(sb.keeper.publicKey)).toBe(before);
    expect((await configsOf(vault)).length).toBe(0);
    expect(configRows(sb.dbFile)).toBe(0);
  });

  test("a tier is refused when this vault is not the pad's own fee claimer, even with the real-send flag", async () => {
    const r = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "200", CONFIG_FLAG]); // no SQUADS_MULTISIG / FEE_CLAIMER_PUBKEY
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/is not the pad's fee claimer/);
    expect((await configsOf(vault)).length).toBe(0);
    const other = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "200", CONFIG_FLAG], { FEE_CLAIMER_PUBKEY: addr() });
    expect(other.code).toBe(1);
    expect(other.out).toMatch(/is not the pad's fee claimer/);
  });

  test("real send of tier 200 and then 400: each reads back with 0 mismatches as ITS tier; a second 200 is refused; the 1% config and the other tiers are not blocked", async () => {
    const r2 = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "200", CONFIG_FLAG], padEnv);
    ok(r2);
    expect(r2.out).toContain("0 mismatches");
    expect(r2.out).toContain("Recorded as the 200 bps tier config");
    const id2 = new PublicKey(/config: (\w+)/.exec(r2.out)![1]!);
    const state2 = (await getDbcClient().state.getPoolConfig(id2))!;
    expect(verifyConfigState(state2, vault, 200)).toEqual([]);
    expect(verifyConfigState(state2, vault).length).toBeGreaterThan(0); // not the 1% config
    expect([state2.creatorTradingFeePercentage, state2.migrationFeeOption, state2.partnerPermanentLockedLiquidityPercentage, state2.creatorPermanentLockedLiquidityPercentage]).toEqual([50, 3, 50, 50]);
    expect(configRows(sb.dbFile)).toBe(1);
    expect(metaOf(sb.dbFile, "dbc_config_pending_200")).toBeNull();

    const again = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "200", CONFIG_FLAG], padEnv);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/already recorded/);
    expect((await tierCfg(vault, 200)).length).toBe(1);

    const r4 = sb.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "400", CONFIG_FLAG], padEnv);
    ok(r4);
    expect((await tierCfg(vault, 400)).length).toBe(1);
    const r1 = sb.run("config-create", ["--multisig", multisig.toBase58(), CONFIG_FLAG], padEnv); // the default 1% config: no tier row blocks it
    ok(r1);
    expect((await tierCfg(vault, 100)).length).toBe(1);
    expect(configRows(sb.dbFile)).toBe(3);

    // from a fresh database the chain alone says the 200 config exists (the same keeper, a database that never saw it)
    const fresh = await sandbox();
    const other = fresh.run("config-create", ["--multisig", multisig.toBase58(), "--tier", "200", CONFIG_FLAG], padEnv);
    expect(other.code).toBe(1);
    expect(other.out).toContain(id2.toBase58());
  }, 120_000);
});
