#!/usr/bin/env bun
// S1 config review, devnet dry run (audit/CONFIG-REVIEW.md). Builds the pad's DBC config
// through the engine's own createDbcConfig (the same builder mainnet uses) with a Squads v4
// vault as fee claimer, set up exactly as the mainnet multisig must be, then reads the raw
// account back and compares every stored field with the reviewed spec. Devnet only; the
// quote mint is the 8-decimal stand-in (devnet has no ZEC). Run:
//   PAD_MODE=devnet KEEPER_KEYPAIR_PATH=<fresh devnet key> PAD_DB_FILE=<scratch db> \
//   S1_FUNDER_KEYPAIR=<devnet SOL source> S1_OUT=<json path> bun scripts/s1-devnet-dryrun.ts
// No key is printed. Writes the comparison to S1_OUT.
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../src/config";
import { getConnection, getDbcClient } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { createDbcConfig } from "../src/dbc/setup";
import { buildConfigParams } from "../src/dbc/config";
import { KEEPER_PERMISSIONS, multisigShapeProblems, vaultOf } from "../src/dbc/squads";

if (config.mode !== "devnet") throw new Error("devnet only");
const conn = getConnection();
const readKey = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const funder = readKey(process.env.S1_FUNDER_KEYPAIR!);
const keeper = loadKeeperKeypair();
const owner = Keypair.generate(); // stands in for the owner's phone wallet
const backup = Keypair.generate(); // stands in for the offline backup key
const send = (ixs: Transaction["instructions"], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
const ser = (v: unknown): unknown =>
  v instanceof PublicKey ? v.toBase58()
  : v && typeof v === "object" && (v as object).constructor?.name === "BN" ? String(v)
  : Array.isArray(v) ? v.map(ser)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]))
  : v;

async function createMultisig() {
  const createKey = Keypair.generate();
  const [multisigPda] = sqds.getMultisigPda({ createKey: createKey.publicKey });
  const { treasury } = await sqds.accounts.ProgramConfig.fromAccountAddress(conn, sqds.getProgramConfigPda({})[0]);
  const sig = await send([sqds.instructions.multisigCreateV2({
    treasury, creator: owner.publicKey, multisigPda, configAuthority: null, threshold: 2, timeLock: 0,
    createKey: createKey.publicKey, rentCollector: keeper.publicKey,
    members: [
      { key: owner.publicKey, permissions: sqds.types.Permissions.all() },
      { key: backup.publicKey, permissions: sqds.types.Permissions.all() },
      { key: keeper.publicKey, permissions: KEEPER_PERMISSIONS },
    ],
  })], [owner, createKey]);
  return { multisigPda, sig };
}

/** Field-by-field: what the chain stored vs what the reviewed builder asks for. */
function compare(state: Record<string, unknown>, vault: PublicKey) {
  const p = ser(buildConfigParams()) as Record<string, any>;
  const s = ser(state) as Record<string, any>;
  const rows: [string, unknown, unknown][] = [
    ["feeClaimer", s.feeClaimer, vault.toBase58()], ["leftoverReceiver", s.leftoverReceiver, vault.toBase58()],
    ["quoteMint (devnet stand-in)", s.quoteMint, config.solana.dbc.quoteMint.toBase58()],
    ...["cliffFeeNumerator", "firstFactor", "secondFactor", "thirdFactor", "baseFeeMode"].map((f): [string, unknown, unknown] => [`poolFees.baseFee.${f}`, s.poolFees.baseFee[f], p.poolFees.baseFee[f]]),
    ["poolFees.dynamicFee.initialized", s.poolFees.dynamicFee.initialized, p.poolFees.dynamicFee ? 1 : 0],
    ...["collectFeeMode", "migrationOption", "activationType", "tokenDecimal", "tokenType", "partnerPermanentLockedLiquidityPercentage", "partnerLiquidityPercentage",
      "creatorPermanentLockedLiquidityPercentage", "creatorLiquidityPercentage", "migrationFeeOption", "creatorTradingFeePercentage", "tokenUpdateAuthority",
      "migrationQuoteThreshold", "sqrtStartPrice", "poolCreationFee", "migratedPoolBaseFeeMode"].map((f): [string, unknown, unknown] => [f, s[f], p[f]]),
    ["quoteTokenFlag", s.quoteTokenFlag, 0],
    ["migrationFeePercentage", s.migrationFeePercentage, p.migrationFee.feePercentage], ["creatorMigrationFeePercentage", s.creatorMigrationFeePercentage, p.migrationFee.creatorFeePercentage],
    ["migratedCollectFeeMode", s.migratedCollectFeeMode, p.migratedPoolFee.collectFeeMode], ["migratedDynamicFee", s.migratedDynamicFee, p.migratedPoolFee.dynamicFee],
    ["migratedPoolFeeBps", s.migratedPoolFeeBps, p.migratedPoolFee.poolFeeBps], ["migratedCompoundingFeeBps", s.migratedCompoundingFeeBps, p.compoundingFeeBps],
    ["enableFirstSwapWithMinFee", s.enableFirstSwapWithMinFee, Number(p.enableFirstSwapWithMinFee)],
    ["fixedTokenSupplyFlag", s.fixedTokenSupplyFlag, 1], ["preMigrationTokenSupply", s.preMigrationTokenSupply, p.tokenSupply.preMigrationTokenSupply],
    ["postMigrationTokenSupply", s.postMigrationTokenSupply, p.tokenSupply.postMigrationTokenSupply],
    ...["amountPerPeriod", "cliffDurationFromMigrationTime", "frequency", "numberOfPeriod", "cliffUnlockAmount"].map((f): [string, unknown, unknown] => [`lockedVestingConfig.${f}`, s.lockedVestingConfig[f], p.lockedVesting[f]]),
    ["partnerLiquidityVestingInfo.isInitialized", s.partnerLiquidityVestingInfo.isInitialized, 0], ["creatorLiquidityVestingInfo.isInitialized", s.creatorLiquidityVestingInfo.isInitialized, 0],
    ["curve (non-zero points)", JSON.stringify(s.curve.filter((c: any) => c.sqrtPrice !== "0")), JSON.stringify(p.curve)],
  ];
  return rows.map(([field, onChain, spec]) => ({ field, onChain, spec, match: String(onChain) === String(spec) }));
}

for (const [who, sol] of [[keeper, 0.05], [owner, 0.01]] as const) {
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: who.publicKey, lamports: sol * LAMPORTS_PER_SOL })], [funder]);
}
const { multisigPda, sig: multisigSig } = await createMultisig();
const vault = vaultOf(multisigPda);
const msState = await sqds.accounts.Multisig.fromAccountAddress(conn, multisigPda);
const keeperBefore = await conn.getBalance(keeper.publicKey);
const row = await createDbcConfig(vault); // the engine's own builder + its full read-back check
const configCost = keeperBefore - (await conn.getBalance(keeper.publicKey));
const state = await getDbcClient().state.getPoolConfig(new PublicKey(row.configId));
const fields = compare(state as unknown as Record<string, unknown>, vault);
const out = {
  ranAt: new Date().toISOString(), cluster: "devnet",
  programs: { dbc: config.solana.dbc.programId.toBase58(), squads: sqds.PROGRAM_ID.toBase58() },
  multisig: {
    address: multisigPda.toBase58(), vault: vault.toBase58(), createSig: multisigSig,
    threshold: msState.threshold, timeLock: msState.timeLock, configAuthority: msState.configAuthority.toBase58(),
    rentCollector: msState.rentCollector?.toBase58() ?? null,
    members: msState.members.map((m) => ({ key: m.key.toBase58(), role: m.key.equals(keeper.publicKey) ? "keeper" : m.key.equals(owner.publicKey) ? "owner" : "backup", mask: m.permissions.mask })),
    shapeProblems: multisigShapeProblems(msState, keeper.publicKey),
  },
  config: { address: row.configId, createdByKeeperLamports: configCost, verifyConfigState: "passed (createDbcConfig throws otherwise)" },
  fields, mismatches: fields.filter((f) => !f.match).map((f) => f.field),
};
writeFileSync(process.env.S1_OUT!, JSON.stringify(out, null, 1));
console.log(`multisig ${out.multisig.address} vault ${out.multisig.vault} config ${out.config.address}: ${fields.length} fields compared, ${out.mismatches.length} mismatches, shape problems ${out.multisig.shapeProblems.length}`);
