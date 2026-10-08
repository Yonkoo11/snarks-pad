// The values the permanent config is built from are ONE module (dbc/reviewed.ts) that audit/CONFIG-REVIEW.md
// cites. These tests assert it equals the numbers written in that review, so neither can drift alone.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../src/config";
import { buildConfigParams } from "../src/dbc/config";
import { configFieldTable, flattenFields } from "../src/dbc/createConfig";
import { PERMANENT_VALUE_ENV_VARS, REVIEWED_CONFIG, REVIEWED_MULTISIG, REVIEWED_SERIALIZED, REVIEWED_WINDOW } from "../src/dbc/reviewed";

const REVIEW = readFileSync(join(config.paths.repoRoot, "audit", "CONFIG-REVIEW.md"), "utf8");
const first = (re: RegExp): string => {
  const m = re.exec(REVIEW);
  if (!m) throw new Error(`CONFIG-REVIEW.md no longer contains ${re}`);
  return m[1]!;
};

describe("dbc/reviewed.ts equals audit/CONFIG-REVIEW.md", () => {
  test("the review cites the module that holds the values", () => {
    expect(REVIEW).toContain("engine/src/dbc/reviewed.ts");
  });

  test("section 3: the serialized numbers of the builder (the base fee as the 2026-10-05 update states it: the launch window)", () => {
    const p = buildConfigParams();
    const window = REVIEW.match(/poolFees\.baseFee \{cliffFeeNumerator (\d+), firstFactor (\d+), secondFactor (\d+), thirdFactor (\d+), baseFeeMode 0\}/);
    expect(window).not.toBeNull();
    expect([new BN(p.poolFees.baseFee.cliffFeeNumerator).toString(), String(p.poolFees.baseFee.firstFactor), new BN(p.poolFees.baseFee.secondFactor).toString(), new BN(p.poolFees.baseFee.thirdFactor).toString()]).toEqual(window!.slice(1, 5));
    expect(REVIEW).toContain("enableFirstSwapWithMinFee true");
    expect(new BN(p.poolFees.baseFee.cliffFeeNumerator).toString()).toBe(first(/cliffFeeNumerator (\d+)/));
    expect(new BN(p.migrationQuoteThreshold).toString()).toBe(first(/migrationQuoteThreshold (\d+)/));
    expect(new BN(p.sqrtStartPrice).toString()).toBe(first(/sqrtStartPrice (\d+)/));
    expect(new BN(p.tokenSupply!.preMigrationTokenSupply).toString()).toBe(first(/tokenSupply \{pre (\d+), post \d+\}/));
    expect(new BN(p.tokenSupply!.postMigrationTokenSupply).toString()).toBe(first(/tokenSupply \{pre \d+, post (\d+)\}/));
    const reviewedCurve = [...REVIEW.matchAll(/\{sqrtPrice (\d+), liquidity (\d+)\}/g)].map((m) => ({ sqrtPrice: m[1]!, liquidity: m[2]! }));
    expect(reviewedCurve.length).toBe(2);
    expect(p.curve.map((c) => ({ sqrtPrice: new BN(c.sqrtPrice).toString(), liquidity: new BN(c.liquidity).toString() }))).toEqual(reviewedCurve);
  });

  test("the constants equal the review's numbers, and what the builder serializes equals the constants", () => {
    const p = buildConfigParams();
    expect(REVIEWED_SERIALIZED.cliffFeeNumerator).toBe(first(/cliffFeeNumerator (\d+)/));
    expect(String(REVIEWED_SERIALIZED.firstFactor)).toBe(first(/firstFactor (\d+)/));
    expect(REVIEWED_SERIALIZED.secondFactor).toBe(first(/secondFactor (\d+)/));
    expect(REVIEWED_SERIALIZED.thirdFactor).toBe(first(/thirdFactor (\d+)/));
    expect([REVIEWED_WINDOW.startBps, REVIEWED_WINDOW.periods, REVIEWED_WINDOW.periodSeconds]).toEqual([9900, 5, 1]);
    expect(REVIEWED_SERIALIZED.migrationQuoteThreshold).toBe(first(/migrationQuoteThreshold (\d+)/));
    expect(REVIEWED_SERIALIZED.sqrtStartPrice).toBe(first(/sqrtStartPrice (\d+)/));
    expect(REVIEWED_SERIALIZED.tokenSupplyRaw).toBe(first(/tokenSupply \{pre (\d+)/));
    expect(new BN(p.poolFees.baseFee.cliffFeeNumerator).toString()).toBe(REVIEWED_SERIALIZED.cliffFeeNumerator);
    expect([p.poolFees.baseFee.firstFactor, new BN(p.poolFees.baseFee.secondFactor).toString(), new BN(p.poolFees.baseFee.thirdFactor).toString()]).toEqual([REVIEWED_SERIALIZED.firstFactor, REVIEWED_SERIALIZED.secondFactor, REVIEWED_SERIALIZED.thirdFactor]);
    expect(new BN(p.migrationQuoteThreshold).toString()).toBe(REVIEWED_SERIALIZED.migrationQuoteThreshold);
    expect(new BN(p.sqrtStartPrice).toString()).toBe(REVIEWED_SERIALIZED.sqrtStartPrice);
    expect(p.curve.map((c) => ({ sqrtPrice: new BN(c.sqrtPrice).toString(), liquidity: new BN(c.liquidity).toString() }))).toEqual([...REVIEWED_SERIALIZED.curve]);
  });

  test("section 3/4: market caps, fee, supply, decimals, quote mint, DAMM fee config", () => {
    expect(REVIEW).toContain(`start market cap ${REVIEWED_CONFIG.initialMarketCapZec} ZEC`);
    expect(REVIEW).toContain(`graduation market cap ${REVIEWED_CONFIG.migrationMarketCapZec} ZEC`);
    expect(REVIEW).toContain(`the fee (${REVIEWED_CONFIG.feeBps} bps)`);
    expect(REVIEW).toContain(`tokenDecimal ${REVIEWED_CONFIG.baseDecimals}`);
    expect(REVIEW).toContain(`migrationFeeOption ${REVIEWED_CONFIG.migrationFeeOption}`);
    expect(REVIEW).toContain(REVIEWED_CONFIG.quoteMintMainnet);
    expect(REVIEW).toContain(REVIEWED_CONFIG.dammMigrationConfig);
    expect(REVIEW).toContain(`1,000,000,000 tokens x 1e6`);
    expect(REVIEWED_CONFIG.totalSupply).toBe(1_000_000_000);
    expect(config.solana.dbc.dammConfig.toBase58()).toBe(REVIEWED_CONFIG.dammMigrationConfig);
  });

  test("the engine's runtime config takes exactly the reviewed values by default", () => {
    const d = config.solana.dbc;
    expect([d.feeBps, d.holderShareBps, d.initialMarketCapZec, d.migrationMarketCapZec, d.totalSupply, d.baseDecimals, d.quoteDecimals, d.migrationFeeOption]).toEqual([
      REVIEWED_CONFIG.feeBps, REVIEWED_CONFIG.holderShareBps, REVIEWED_CONFIG.initialMarketCapZec, REVIEWED_CONFIG.migrationMarketCapZec, REVIEWED_CONFIG.totalSupply,
      REVIEWED_CONFIG.baseDecimals, REVIEWED_CONFIG.quoteDecimals, REVIEWED_CONFIG.migrationFeeOption,
    ]);
  });

  test("section 5: the multisig numbers", () => {
    expect(REVIEW).toContain("Threshold **2**");
    expect(REVIEW).toContain("Time lock **0**");
    expect([REVIEWED_MULTISIG.threshold, REVIEWED_MULTISIG.timeLock, REVIEWED_MULTISIG.memberCount]).toEqual([2, 0, 3]);
  });
});

describe("the dry-run table", () => {
  const vault = new PublicKey("FjoS22r9JRGec8ocURMzpwvJo6eKATzR1CKxkyRFxktZ");
  const payer = new PublicKey("ANcxBq4HpuCXhZxJE2MC6QXG1gkV9NFEYMrvcttnXAcL");

  test("lists the vault as fee claimer and leftover receiver, and every parameter the builder makes", () => {
    const table = new Map(configFieldTable(vault, payer));
    const get = (prefix: string) => [...table.entries()].find(([k]) => k.startsWith(prefix))?.[1];
    expect(get("feeClaimer")).toBe(vault.toBase58());
    expect(get("leftoverReceiver")).toBe(vault.toBase58());
    expect(get("quoteMint")).toBe(config.solana.dbc.quoteMint.toBase58());
    for (const [path, value] of flattenFields(buildConfigParams())) expect(table.get(path)).toBe(value);
    expect(table.get("poolFees.baseFee.cliffFeeNumerator")).toBe("990000000");
    expect([table.get("poolFees.baseFee.firstFactor"), table.get("poolFees.baseFee.secondFactor"), table.get("poolFees.baseFee.thirdFactor")]).toEqual(["5", "1", "196000000"]);
    expect(table.get("enableFirstSwapWithMinFee")).toBe("true");
    expect(table.get("curve[1].liquidity")).toBe("2863359401554164099987362");
  });
});

describe("a stray permanent-value env var is refused on mainnet (CONFIG-REVIEW S1-L2)", () => {
  const importConfig = (env: Record<string, string>) =>
    Bun.spawnSync(["bun", "-e", 'import "./src/config"; console.log("loaded")'], {
      cwd: config.paths.engineRoot,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, PAD_MODE: "mainnet", PAD_DB_FILE: "/dev/null", ...env },
    });

  test.each([...PERMANENT_VALUE_ENV_VARS])("%s set on mainnet: config load throws and names it", (name) => {
    const r = importConfig({ [name]: "7" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(name);
  });

  test("the same vars on devnet are still allowed (experiments), and unset on mainnet loads", () => {
    expect(importConfig({ PAD_MODE: "devnet", DBC_FEE_BPS: "150" }).stdout.toString()).toContain("loaded");
    expect(importConfig({}).stdout.toString()).toContain("loaded");
  });
});
