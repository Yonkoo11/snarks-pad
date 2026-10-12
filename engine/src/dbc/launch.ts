// Non-custodial coin launch on Meteora DBC: the server builds a transaction
// with the creator's wallet as fee payer. For the site (contract v2.9.1,
// `cosign`) nobody has signed it yet: the creator's wallet signs first, as
// Phantom asks, then POST /coins/launch-cosign checks it and adds the new
// coin's signature (dbc/cosign.ts; the coin's key never leaves the engine,
// audit S5-01), the page sends it and calls confirmLaunch with the sig. The
// seed scripts and tests get the old order: the coin's key signs here first. The pool and the optional
// first buy are ONE instruction set (createPoolWithFirstBuy, probe/meteora-dbc
// src/dbc-flow.ts), so a launch either happens completely or not at all.
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { deriveDammV1MigrationMetadataAddress, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { config } from "../config";
import { getConnection, getDbcClient, waitForSignature } from "../solana";
import { requireDbcConfig } from "./config";
import { requireCreatorWallet } from "./creatorWallet";
import { launchpadSigner, withLaunchpadSigner } from "./launchSigner";
import { DEFAULT_TIER_BPS } from "./reviewed";
import { configScheduleOf, scheduleToJson } from "./window";
import * as db from "../db";
import { removeMetadata, writeMetadata } from "../publicFiles/metadata";
import { metadataUrl } from "../publicFiles/paths";
import type { Socials } from "../socials";
import { activationPointOf, lookForPools } from "./reconcile";
import { forgetLaunchKey, holdLaunchKey } from "./cosign";

export interface LaunchParams {
  creator: string;
  name: string;
  symbol: string;
  description: string;
  /** One of this pad's own upload addresses (src/publicFiles), or "" for none. The API checks that; the seed scripts may also pass a site path such as "/mascot.jpg". */
  imageUrl: string;
  initialBuyZats?: string; // base units of the quote asset, decimal string
  /** The creator-fee tier, in bps (a reviewed config with a verified row; default: the SNARKS 1% config). Anything else throws TierNotAvailableError. */
  feeTier?: number;
  /** The creator's links, already checked (src/socials.ts). Written into the coin's metadata file and stored on its row. */
  socials?: Socials;
  /**
   * A wallet that receives the creator's share of the fee (contract v2.8): the launch transaction hands the pool to it. Checked again here (dbc/creatorWallet.ts), so a
   * caller that skipped the API's check still cannot hand a pool to an off-curve or pad-owned address; blank or the launcher's own address means no handover.
   */
  creatorWallet?: string;
}

/** Why a launch was refused before any wallet saw it: the simulation says the wallet is short of SOL or ZEC, or the launch would fail. */
export class LaunchTxError extends Error {
  constructor(public code: "needs_sol" | "needs_zec" | "launch_would_fail") {
    super(code);
  }
}

export interface LaunchTxResult {
  txBase64: string;
  mint: string;
}

/**
 * `transfer_pool_creator` for a pool this same transaction creates: the launcher signs as the pool's creator and names `receiver` the new one (the program only requires
 * that it differ from the old one, ix_transfer_pool_creator.rs; F-039 ran it in the launch transaction on devnet). The SDK helper reads the pool first, which does not
 * exist yet, so the instruction is built from the program with the pool address derived up front and the DAMM v1 metadata account as its one remaining account.
 */
async function handoverIx(cfg: db.DbcConfigRow, baseMint: PublicKey, launcher: PublicKey, receiver: PublicKey): Promise<TransactionInstruction> {
  const config_ = new PublicKey(cfg.configId);
  const pool = deriveDbcPoolAddress(config.solana.dbc.quoteMint, baseMint, config_);
  return getDbcClient().creator.program.methods.transferPoolCreator()
    .accountsPartial({ virtualPool: pool, newCreator: receiver, config: config_, creator: launcher })
    .remainingAccounts([{ pubkey: deriveDammV1MigrationMetadataAddress(pool), isSigner: false, isWritable: false }])
    .instruction();
}

/**
 * The create-pool transaction, with a first buy when there is one and the handover to `receiver` last. `uri` is the address of the coin's metadata file.
 * `signers` are keys made here (the old order); with a browser-made address there are none and every signature slot leaves empty.
 */
async function buildCreateTx(p: LaunchParams, cfg: db.DbcConfigRow, baseMint: PublicKey, signers: Keypair[], uri: string, receiver: string | null): Promise<VersionedTransaction> {
  const creator = new PublicKey(p.creator);
  const buyAmount = p.initialBuyZats ? new BN(p.initialBuyZats) : new BN(0);
  const createPoolParam = { name: p.name, symbol: p.symbol, uri, payer: creator, poolCreator: creator, config: new PublicKey(cfg.configId), baseMint };
  const client = getDbcClient();
  const tx = buyAmount.isZero()
    ? await client.creator.createPool(createPoolParam)
    : await client.creator.createPoolWithFirstBuy({
        createPoolParam,
        firstBuyParam: { buyer: creator, buyAmount, minimumAmountOut: new BN(0), referralTokenAccount: null },
      });
  // The pad's launch signer rides along as a read-only signer named by a memo instruction, last (dbc/launchSigner.ts): terminals attribute the launch by it,
  // and a wallet that rebuilds the transaction keeps it. The engine signs with it here when it signs at all (a script); on the site's order the co-sign
  // step adds it with the coin's signature.
  const instructions = withLaunchpadSigner(receiver ? [...tx.instructions, await handoverIx(cfg, baseMint, creator, new PublicKey(receiver))] : tx.instructions);
  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const vtx = new VersionedTransaction(message);
  const pad = launchpadSigner();
  if (signers.length) vtx.sign(pad ? [...signers, pad] : signers);
  return vtx;
}

/** The refusal a failed simulation stands for, from its error and logs (Solana's own wording: system program, token program, runtime). */
export function launchShortfall(err: unknown, logs: readonly string[]): LaunchTxError["code"] {
  const text = `${JSON.stringify(err)}\n${logs.join("\n")}`;
  if (/InsufficientFundsForRent|InsufficientFundsForFee|insufficient lamports|no record of a prior credit|AccountNotFound/i.test(text)) return "needs_sol";
  if (/insufficient funds/i.test(text)) return "needs_zec"; // the token program's words when the first buy is more ZEC than the wallet holds
  return "launch_would_fail";
}

/**
 * Runs the launch on the chain's current state before any wallet sees it (signatures not checked), so a wallet short of SOL or ZEC is told so by the pad
 * instead of a wallet warning. A simulation that cannot be read lets the launch through: the chain still decides.
 */
async function simulateLaunch(vtx: VersionedTransaction): Promise<void> {
  let value: Awaited<ReturnType<ReturnType<typeof getConnection>["simulateTransaction"]>>["value"];
  try {
    // replaceRecentBlockhash: the check needs balances, not this blockhash; a node a few slots behind would otherwise refuse a good launch (audit S5-08)
    ({ value } = await getConnection().simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }));
  } catch (err) {
    console.error(`[launch] simulation unavailable, the launch is built without it: ${(err as Error)?.message ?? err}`);
    return;
  }
  if (!value.err) return;
  const logs = value.logs ?? [];
  console.error(`[launch] simulation refused a launch: ${JSON.stringify(value.err)} ${logs.slice(-12).join(" | ")}`);
  throw new LaunchTxError(launchShortfall(value.err, logs));
}

/**
 * The creator's browser signs and sends what this returns. The coin's on-chain uri is the address of its metadata JSON (`<PUBLIC_BASE_URL>/m/<mint>.json`), never
 * the address of the picture: wallets and explorers read the JSON to find the name, the picture and the links. The address is worked out from the mint, so the
 * transaction is built first and the JSON written only once it exists (S4-05): a launch that cannot be built leaves nothing behind, and a launch nobody signs
 * leaves a coin row and a file that the sweep drops after an hour (src/publicFiles/sweep.ts). A row that cannot be recorded takes its metadata file down again.
 */
/** `cosign`: the site's order (the wallet signs first, then POST /coins/launch-cosign adds the coin's signature); without it the coin's key signs here. */
export async function buildLaunchTx(p: LaunchParams, opts: { cosign?: boolean } = {}): Promise<LaunchTxResult> {
  const receiver = requireCreatorWallet(p.creatorWallet, p.creator);
  const cfg = await requireDbcConfig(p.feeTier ?? DEFAULT_TIER_BPS);
  // The config's fee schedule goes on the coin's row (contract v2.8.1), so the coin's window is worked out later without the chain. Read once per config and kept.
  const feeSchedule = scheduleToJson(await configScheduleOf(new PublicKey(cfg.configId)));
  const key = Keypair.generate();
  const mint = key.publicKey.toBase58();
  const socials = p.socials ?? {};
  const vtx = await buildCreateTx(p, cfg, key.publicKey, opts.cosign ? [] : [key], metadataUrl(mint), receiver);
  await simulateLaunch(vtx);
  const txBase64 = Buffer.from(vtx.serialize()).toString("base64");
  if (opts.cosign) holdLaunchKey(key, vtx.message, new PublicKey(p.creator));
  writeMetadata(mint, { name: p.name, symbol: p.symbol, description: p.description, imageUrl: p.imageUrl, socials });
  try {
    db.upsertCoin({
      mint, name: p.name, symbol: p.symbol, imageUrl: p.imageUrl, description: p.description, creator: p.creator, createdAt: new Date().toISOString(),
      feeBps: cfg.feeBps, poolId: null, mintDecimals: config.solana.dbc.baseDecimals, status: "pending", configId: cfg.configId, socials: JSON.stringify(socials), creatorWallet: receiver,
      feeSchedule,
    });
  } catch (err) {
    removeMetadata(mint);
    forgetLaunchKey(mint);
    throw err;
  }
  return { txBase64, mint };
}

export class LaunchConfirmError extends Error {
  constructor(public code: "unknown_mint" | "tx_not_found" | "tx_failed" | "pool_not_found") {
    super(code);
  }
}

/**
 * Marks a pending coin launched, but only once the chain shows it: the
 * signature confirmed without error AND the DBC pool for this mint under this
 * pad's config exists. The client-supplied sig is never trusted on its own.
 */
/** `newlyLaunched`: this call is the one that recorded the launch (a repeated confirm answers false and reads nothing more). */
export async function confirmLaunch(sig: string, mint: string): Promise<{ poolId: string; newlyLaunched: boolean }> {
  const coin = db.getCoin(mint);
  if (!coin || !coin.configId) throw new LaunchConfirmError("unknown_mint");
  if (coin.status === "launched" && coin.poolId) return { poolId: coin.poolId, newlyLaunched: false };

  const status = await waitForSignature(sig);
  if (status?.err) throw new LaunchConfirmError("tx_failed");
  if (!status) {
    // The signature is not visible yet (or the browser sent another one): the pool is the stronger proof, and it is what the launch makes.
    const look = (await lookForPools([{ mint, configId: coin.configId }])).get(mint);
    if (look?.state !== "landed") throw new LaunchConfirmError("tx_not_found");
    db.markCoinLaunched(mint, look.poolId, look.activationPoint);
    return { poolId: look.poolId, newlyLaunched: true };
  }

  const poolPk = deriveDbcPoolAddress(config.solana.dbc.quoteMint, new PublicKey(mint), new PublicKey(coin.configId));
  const poolInfo = await getConnection().getAccountInfo(poolPk, "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(config.solana.dbc.programId)) throw new LaunchConfirmError("pool_not_found");
  const poolId = poolPk.toBase58();
  db.markCoinLaunched(mint, poolId, activationPointOf(poolId, poolInfo.data));
  return { poolId, newlyLaunched: true };
}
