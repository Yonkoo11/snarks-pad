#!/usr/bin/env bun
// Scenario 1 independent check (audit/STRESS-REPORT.md).
//   bun stress/scale-check.ts pre  <wallets.json>   reads chain state right before the epoch (no trades after this)
//   bun stress/scale-check.ts post <wallets.json>   recomputes every holder's amount from that chain state with code
//                                                   written here (not src/epoch/*) and compares with what landed
// Reads the validator directly and the recipients' own Zcash accounts. The engine DB is read only to REPORT its
// ledger next to the independent numbers, never as an input to the expectation.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CpAmm, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { config } from "../src/config";
import * as db from "../src/db";
import { STRESS_DIR, ZEC, direct, independentSplit, tokenBalancesByOwner, zecAtaBalances } from "./lib";
import { accountTotalZats, syncRecipientWallet } from "./zrecipients";
import { TREASURY_DIR } from "../src/zcash/regtest";

async function zebrad(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(config.zcash.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as { result: unknown }).result;
}
const treasuryTotal = (): bigint => { syncRecipientWallet(TREASURY_DIR); return BigInt((JSON.parse(new TextDecoder().decode(Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "-w", TREASURY_DIR, "balance", "--json"], { env: { RUST_LOG: "warn", PATH: Bun.env.PATH ?? "" } }).stdout)) as { total: number }).total); };

/** Net treasury movement (received - sent - fee) of txs mined above `height` that are neither `ours` nor the swap delivery. */
function treasuryForeignSince(height: number, ours: Set<string>, swapRef: string | null): { net: bigint; list: string[] } {
  const out = new TextDecoder().decode(Bun.spawnSync([config.paths.zcashDevtoolBin, "wallet", "-w", TREASURY_DIR, "list-tx"], { env: { RUST_LOG: "warn", PATH: Bun.env.PATH ?? "" } }).stdout);
  const delivery = swapRef ? (db.getSwapProgress(swapRef)?.payTxid ?? (db.getDb().query("SELECT destinationTxids FROM near1click_swaps WHERE key = ?").get(swapRef) as { destinationTxids?: string } | null)?.destinationTxids ?? "") : "";
  const zats = (x: string) => BigInt(Math.round(Number(x) * 1e8));
  let net = 0n;
  const list: string[] = [];
  for (const b of out.split(/\n(?=[0-9a-f]{64}\n)/)) {
    const m = /^([0-9a-f]{64})\n\s*Mined: (\d+)/.exec(b);
    if (!m || Number(m[2]) <= height || ours.has(m[1]!) || delivery.includes(m[1]!)) continue;
    const recv = [...b.matchAll(/Value:\s*([0-9.]+) [A-Z]+\s*\n\s*Received by account/g)].reduce((a, x) => a + zats(x[1]!), 0n);
    const sent = [...b.matchAll(/Value:\s*([0-9.]+) [A-Z]+\s*\n\s*Sent from account/g)].reduce((a, x) => a + zats(x[1]!), 0n);
    const fee = zats(/Fee paid:\s*([0-9.]+)/.exec(b)?.[1] ?? "0");
    net += recv - sent - fee;
    list.push(`${m[1]!.slice(0, 12)} at ${m[2]}: received ${recv}, sent ${sent}, fee ${fee}`);
  }
  return { net, list };
}

const [mode, walletsFile] = process.argv.slice(2);
const W = JSON.parse(readFileSync(walletsFile!, "utf8")) as {
  mints: Record<string, string>; keeper: string; holders: string[];
  optins: { wallet: string; walletDir: string; account: string }[]; traders: string[];
};
const preFile = walletsFile!.replace(/\.json$/, "-pre.json");
const resultFile = join(STRESS_DIR, `${walletsFile!.split("/").pop()!.replace(/\.json$/, "")}-result.json`);
// PRIOR=<an earlier run's -result.json>: what MY code expected to be carried by that run (never the engine's carry table).
const prior = Bun.env.PRIOR ? (JSON.parse(readFileSync(Bun.env.PRIOR, "utf8")) as { carry: Record<string, string> }).carry : {};
const priorCarry = (w: string): bigint => BigInt(prior[w] ?? "0");
const big = (x: { toString(): string }) => BigInt(x.toString());

// Policy constants, written down from engine/README.md "Payout policy" and src/config.ts defaults, not imported.
const DUST = 5_000n, NEW_ACCOUNT_MIN = 30_000n, SHIELDED_MIN = 100_000n, SWAP_MIN = 1_000_000n;
const TEAM_BPS = 2_500n, RESERVE_BPS = 100n, WITHDRAW_FEE = 32_000n, SPREAD_BPS = 25n, SIM_WITHDRAW = 32_000n;
const PER_TX = Number(Bun.env.PAD_STRESS_SHIELDED_PER_TX ?? 350);
// FALLBACK=1: this epoch's swap failed before funds moved or was refunded: sendable opted-in shares are paid as Solana
// ZEC instead, the reserve is never spent and the team's whole share stays Solana ZEC (engine/README.md rule 4).
const FALLBACK = Bun.env.FALLBACK === "1";
const chunksOf = (n: bigint): bigint => (n === 0n ? 1n : (n + BigInt(PER_TX) - 1n) / BigInt(PER_TX));

async function claimable(mint: string): Promise<{ curve: bigint; position: bigint; surplus: bigint }> {
  const dbc = DynamicBondingCurveClient.create(direct, "confirmed");
  const pools = await dbc.state.getPoolByBaseMint(new PublicKey(mint));
  const poolId = pools!.publicKey;
  const curve = big((await dbc.state.getPoolFeeMetrics(poolId)).current.partnerQuoteFee);
  let position = 0n;
  let surplus = 0n;
  const st = await dbc.state.getPool(poolId);
  if (st!.poolState.isMigrated !== 0) {
    const cp = new CpAmm(direct);
    const pools2 = await cp.getAllPools();
    const mine = pools2.filter((p) => p.account.tokenAMint.toBase58() === mint || p.account.tokenBMint.toBase58() === mint);
    for (const p of mine) {
      const quoteIsA = p.account.tokenAMint.equals(ZEC);
      for (const pos of await cp.getUserPositionByPool(p.publicKey, new PublicKey(W.keeper))) {
        const f = getUnClaimLpFee(p.account, pos.positionState);
        position += big(quoteIsA ? f.feeTokenA : f.feeTokenB);
      }
    }
    if (st!.poolState.isPartnerWithdrawSurplus === 0) {
      const threshold = big(await dbc.state.getPoolMigrationQuoteThreshold(poolId));
      const reserve = big(st!.poolState.quoteReserve);
      if (reserve > threshold) surplus = ((reserve - threshold) * 80n) / 100n; // 1% coin: creator share 0
    }
  }
  return { curve, position, surplus };
}

function onCurve(owner: string): boolean {
  try { return PublicKey.isOnCurve(new PublicKey(owner).toBytes()); } catch { return false; }
}

async function pre(): Promise<void> {
  const t = Date.now();
  const weights: Record<string, Record<string, string>> = {};
  const claims: Record<string, Record<string, string>> = {};
  for (const [k, mint] of Object.entries(W.mints)) {
    const bal = await tokenBalancesByOwner(new PublicKey(mint), TOKEN_2022_PROGRAM_ID);
    weights[mint] = Object.fromEntries([...bal].map(([o, b]) => [o, b.toString()]));
    const c = await claimable(mint);
    claims[mint] = { curve: c.curve.toString(), position: c.position.toString(), surplus: c.surplus.toString() };
    console.log(k, mint.slice(0, 6), "owners", bal.size, "claimable", claims[mint]);
  }
  const owners = [...new Set(Object.values(weights).flatMap((w) => Object.keys(w)))];
  const zec = await zecAtaBalances(owners);
  const zcash: Record<string, string> = {};
  for (const dir of [...new Set(W.optins.map((o) => o.walletDir))]) syncRecipientWallet(dir);
  for (const o of W.optins) zcash[o.wallet] = accountTotalZats(o.walletDir, o.account).toString();
  const keeper = new PublicKey(W.keeper);
  const keeperAta = getAssociatedTokenAddressSync(ZEC, keeper, false, TOKEN_PROGRAM_ID);
  const out = {
    at: new Date().toISOString(), slot: await direct.getSlot("confirmed"),
    weights, claims, zec: Object.fromEntries([...zec].map(([o, b]) => [o, b === null ? null : b.toString()])), zcash,
    treasury: treasuryTotal().toString(), zcashHeight: Number(await zebrad("getblockcount", [])),
    keeperLamports: await direct.getBalance(keeper), keeperZec: (await direct.getTokenAccountBalance(keeperAta).catch(() => ({ value: { amount: "0" } }))).value.amount,
  };
  writeFileSync(preFile, JSON.stringify(out));
  console.log("pre written in", Date.now() - t, "ms; owners", owners.length, "zcash accounts", W.optins.length);
}

async function post(): Promise<void> {
  const P = JSON.parse(readFileSync(preFile, "utf8")) as {
    slot: number; weights: Record<string, Record<string, string>>; claims: Record<string, Record<string, string>>;
    zec: Record<string, string | null>; zcash: Record<string, string>; treasury: string; zcashHeight?: number; keeperLamports: number; keeperZec: string;
  };
  const problems: string[] = [];
  const opted = new Set(W.optins.map((o) => o.wallet));
  const excluded = new Set([W.keeper]);

  // 1. Per coin: expected claim from pool state, split team/holders, pro rata by weight (independent code).
  const owed = new Map<string, bigint>();
  let teamGross = 0n, claimedExpected = 0n;
  for (const mint of Object.values(W.mints)) {
    const c = P.claims[mint] as Record<"curve" | "position" | "surplus", string>;
    const claimed = BigInt(c.curve) + BigInt(c.position) + BigInt(c.surplus);
    claimedExpected += claimed;
    const team = (claimed * TEAM_BPS) / 10_000n;
    teamGross += team;
    const ws = Object.entries(P.weights[mint]!).filter(([o, b]) => BigInt(b) > 0n && onCurve(o) && !excluded.has(o)).map(([id, b]) => ({ id, w: BigInt(b) }));
    for (const [w, a] of independentSplit(claimed - team, ws)) owed.set(w, (owed.get(w) ?? 0n) + a);
  }
  let priorTotal = 0n;
  for (const [w, c] of Object.entries(prior)) {
    owed.set(w, (owed.get(w) ?? 0n) + BigInt(c));
    priorTotal += BigInt(c);
  }
  const carryOut: Record<string, string> = {};
  // The validator keeps a short ledger (the claim transactions are pruned within minutes at this volume), so the claim
  // is read as the drop in each pool's claimable fee, which is pool state, plus the keeper's ZEC conservation below.
  let chainTotal = 0n;
  for (const mint of Object.values(W.mints)) {
    const before = P.claims[mint] as Record<"curve" | "position" | "surplus", string>;
    const after = await claimable(mint);
    chainTotal += BigInt(before.curve) + BigInt(before.position) + BigInt(before.surplus) - (after.curve + after.position + after.surplus);
  }
  const chain = { total: chainTotal, txs: -1 };
  console.log("claimed: expected from pool state", claimedExpected, "landed on chain", chain.total, "in", chain.txs, "claim txs");
  if (chain.total !== claimedExpected) problems.push(`claimed ${chain.total} != pool-state expectation ${claimedExpected}`);

  // 2. Solana rail.
  const postZec = await zecAtaBalances([...owed.keys()]);
  let solPaid = 0n, solCarry = 0n, solPaidCount = 0, solCarryCount = 0, solChecked = 0;
  for (const [w, amt] of owed) {
    if (opted.has(w)) continue;
    const had = P.zec[w] ?? null;
    const pay = amt >= DUST && (had !== null || amt > NEW_ACCOUNT_MIN) ? amt : 0n;
    const got = (postZec.get(w) ?? 0n)! - BigInt(had ?? "0");
    solChecked++;
    if (got !== pay) problems.push(`solana ${w}: got ${got}, expected ${pay} (owed ${amt}, account ${had === null ? "none" : "yes"})`);
    if (pay > 0n) { solPaid += got; solPaidCount++; } else { solCarry += amt; solCarryCount++; carryOut[w] = amt.toString(); }
  }

  // 3. Shielded rail: per-holder minimum, swap floor, team reserve, simulated swap, repricing.
  const planned = W.optins.map((o) => ({ id: o.wallet, w: owed.get(o.wallet) ?? 0n }));
  const sendable = planned.filter((p) => p.w >= SHIELDED_MIN);
  const total = sendable.reduce((a, p) => a + p.w, 0n);
  const n = BigInt(sendable.length);
  let expectZ = new Map<string, bigint>();
  let reserve = 0n, settledOut = 0n, paidTotal = 0n;
  if (total >= SWAP_MIN) {
    const est = WITHDRAW_FEE + 5000n * (n + chunksOf(n)) + (total * RESERVE_BPS + 9_999n) / 10_000n;
    reserve = est < teamGross ? est : teamGross;
  }
  if (total >= SWAP_MIN && !FALLBACK) {
    const afterSpread = ((total + reserve) * (10_000n - SPREAD_BPS)) / 10_000n;
    settledOut = afterSpread - SIM_WITHDRAW;
    const available = settledOut - 5000n * (n + chunksOf(n));
    paidTotal = available < total ? available : total;
    expectZ = independentSplit(paidTotal, sendable);
  }
  let zPaid = 0n, zChecked = 0, zPaidCount = 0;
  for (const dir of [...new Set(W.optins.map((o) => o.walletDir))]) syncRecipientWallet(dir);
  for (const o of W.optins) {
    const got = accountTotalZats(o.walletDir, o.account) - BigInt(P.zcash[o.wallet] ?? "0");
    const exp = expectZ.get(o.wallet) ?? 0n;
    zChecked++;
    if (got !== exp) problems.push(`zcash ${o.wallet.slice(0, 8)} (${o.account.slice(0, 8)}): got ${got}, expected ${exp}`);
    zPaid += got;
    if (got > 0n) zPaidCount++;
  }
  let fallbackPaid = 0n;
  if (FALLBACK && total >= SWAP_MIN) {
    const z = await zecAtaBalances(sendable.map((p) => p.id));
    for (const p of sendable) {
      const got = (z.get(p.id) ?? 0n)! - BigInt(P.zec[p.id] ?? "0");
      if (got !== p.w) problems.push(`fallback solana ${p.id.slice(0, 8)}: got ${got}, expected ${p.w}`);
      fallbackPaid += got;
    }
  }
  const shieldedCarry = planned.reduce((a, p) => a + p.w, 0n) - total;
  for (const p of planned) if (p.w < SHIELDED_MIN && p.w > 0n) carryOut[p.id] = p.w.toString();
  if (total < SWAP_MIN) for (const p of sendable) carryOut[p.id] = p.w.toString();

  // 4. Conservation (I1) and the engine's own ledger next to it (I4).
  const holdersPot = claimedExpected - teamGross + priorTotal;
  const accounted = solPaid + solCarry + (FALLBACK ? fallbackPaid : total) + shieldedCarry;
  if (accounted !== holdersPot) problems.push(`I1: solana paid + carry + shielded planned + shielded carry = ${accounted} != holders pot ${holdersPot}`);
  const epochs = db.listEpochs();
  const e = epochs[0]; // newest first
  if (e) {
    const row = db.getEpoch(e.id)!;
    const cmp = (label: string, mine: bigint, theirs: string | null | undefined) => {
      if (theirs == null || BigInt(theirs) !== mine) problems.push(`I4 ${label}: independent ${mine}, engine ${theirs}`);
    };
    cmp("teamGross", teamGross, row.teamGrossZats);
    cmp("reserve", reserve, row.deliveryReserveZats);
    cmp("teamSolana", FALLBACK ? teamGross : teamGross - reserve, row.teamSolanaZats);
    cmp("holderShortfall", FALLBACK || total < SWAP_MIN ? 0n : total - paidTotal, row.holderShortfallZats); // no swap below the floor: nothing to fall short of
    if (FALLBACK) cmp("teamNative", 0n, row.teamNativeZats);
    if (total >= SWAP_MIN && !FALLBACK) cmp("teamNative (available - paid)", settledOut - 5000n * (n + chunksOf(n)) - paidTotal, row.teamNativeZats);
    // The treasury's real movement: what the swap delivered minus what holders got minus the real network fees.
    const txids = JSON.parse(row.zcashTxids) as string[];
    let realFees = 0n;
    const heights: number[] = [];
    for (const t of txids) {
      const tx = await zebrad("getrawtransaction", [t, 1]);
      realFees += BigInt(tx.ironwood?.valueBalanceZat ?? 0);
      heights.push(tx.height ?? -1);
      const outs = tx.ironwood?.actions?.length ?? 0;
      if (outs > PER_TX + 1) problems.push(`tx ${t} has ${outs} Ironwood actions (> ${PER_TX} recipients + change)`);
    }
    console.log("shielded payout txs", txids.length, "heights", heights.join(","), "real network fees", realFees, "engine feeZats", row.feeZats);
    if (realFees !== BigInt(row.feeZats)) problems.push(`engine feeZats ${row.feeZats} != real fees ${realFees}`);
    if (heights.some((h, i) => i > 0 && h <= heights[i - 1]!)) problems.push(`chunk heights not increasing: ${heights.join(",")}`);
    // Every treasury transaction mined since the pre snapshot, from the wallet's own list: this epoch's swap delivery
    // and payout chunks are attributed; anything else is another process on the shared regtest treasury (reported,
    // and taken out of the balance comparison, so a concurrent run cannot fail or pass this check by accident).
    const foreign = treasuryForeignSince(P.zcashHeight ?? 0, new Set(txids), row.swapRef);
    for (const f of foreign.list) console.log("treasury tx not from this epoch:", f);
    const treasuryDelta = treasuryTotal() - BigInt(P.treasury) - foreign.net;
    const expectedDelta = total >= SWAP_MIN && !FALLBACK ? settledOut - zPaid - realFees : 0n;
    if (treasuryDelta !== expectedDelta) problems.push(`treasury moved ${treasuryDelta}, expected settled ${settledOut} - paid ${zPaid} - fees ${realFees} = ${expectedDelta}`);
    if (row.teamNativeZats != null && BigInt(row.teamNativeZats) !== expectedDelta) problems.push(`I4 team native ZEC in ledger ${row.teamNativeZats} != what is really left in the treasury ${expectedDelta}`);
    console.log("engine epoch", row.id, "status", row.status, "attempts", row.attempts, "zcashTxids", row.zcashTxids);
  }
  const lamports = await direct.getBalance(new PublicKey(W.keeper));
  const keeperAta = getAssociatedTokenAddressSync(ZEC, new PublicKey(W.keeper), false, TOKEN_PROGRAM_ID);
  const keeperZecNow = BigInt((await direct.getTokenAccountBalance(keeperAta)).value.amount);
  const swapIn = total >= SWAP_MIN && !FALLBACK ? total + reserve : 0n;
  const keeperExpected = BigInt(P.keeperZec) + chain.total - solPaid - fallbackPaid - swapIn;
  if (keeperZecNow !== keeperExpected) problems.push(`keeper ZEC ${keeperZecNow} != before ${P.keeperZec} + claimed ${chain.total} - Solana paid ${solPaid} - swapped ${swapIn} = ${keeperExpected}`);
  const report = {
    holdersWithShare: owed.size, solanaChecked: solChecked, solanaPaid: solPaidCount, solanaCarried: solCarryCount,
    solPaidZats: solPaid.toString(), solCarryZats: solCarry.toString(),
    zcashChecked: zChecked, zcashPaid: zPaidCount, shieldedPlanned: sendable.length, shieldedPaidZats: zPaid.toString(),
    shieldedTotal: total.toString(), reserve: reserve.toString(), settledOut: settledOut.toString(), teamGross: teamGross.toString(),
    claimedChain: chain.total.toString(), claimedExpected: claimedExpected.toString(), claimTxs: chain.txs,
    keeperSolSpent: (P.keeperLamports - lamports) / 1e9, fallbackPaidZats: fallbackPaid.toString(), problems: problems.length,
  };
  console.log(JSON.stringify(report, null, 1));
  for (const p of problems.slice(0, 40)) console.log("PROBLEM", p);
  writeFileSync(Bun.env.RESULT ?? resultFile, JSON.stringify({ report, problems, carry: carryOut }, null, 1));
  console.log(problems.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${problems.length})`);
}

(mode === "pre" ? pre() : post()).then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
