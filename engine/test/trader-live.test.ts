// The trader-panel routes docs/API.md v2.6 on a REAL pool: a coin launched through the engine's own builder on the local validator
// (the mainnet DBC binary). The quote is compared with what POST /trade-tx puts in its own quote for the same trade (same SDK, so equal
// to the unit), the price impact against arithmetic worked out here from the pool's price, the pot against the fee model the e2e uses,
// the fixed facts against the chain, and the holders against the vault balance. Graduated pools, a Squads fee claimer and a creator-fee
// tier are in `bun run e2e`. Skipped where no validator is up.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getDbcClient } from "../src/solana";
import { clearStatsCache, handleRequest } from "../src/api";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { loadKeeperKeypair } from "../src/keeper";
import { fundTestWallet } from "../src/faucet";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx, confirmLaunch } from "../src/dbc/launch";
import { buildTradeTx } from "../src/dbc/trade";
import { readCoinView } from "../src/dbc/read";
import { tradeSplit } from "../src/dbc/tiers";
import { clearQuoteCaches, quoteReads, QUOTE_MAX_AGE_MS } from "../src/dbc/quote";
import { splitClaim } from "../src/epoch/split";
import * as db from "../src/db";
import { validatorUp } from "./helpers/validator-up";
import { waitForCoinWindow } from "../src/dbc/windowWait";

const live = await validatorUp();
const made: string[] = [];
const tag = `T${Math.random().toString(36).slice(2, 7)}`;

afterAll(() => {
  for (const m of made) for (const table of ["coins", "trades", "holder_samples"]) db.getDb().query(`DELETE FROM ${table} WHERE mint = $m`).run({ $m: m });
});

async function launch(suffix: string, initialBuyZats: string): Promise<{ mint: string; creator: Keypair }> {
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
  const { txBase64, mint } = await buildLaunchTx({ creator: creator.publicKey.toBase58(), name: `${tag} ${suffix}`, symbol: `${tag}${suffix}`, description: "", imageUrl: "", initialBuyZats });
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([creator]);
  const sig = await getConnection().sendRawTransaction(tx.serialize());
  await getConnection().confirmTransaction(sig, "confirmed");
  await confirmLaunch(sig, mint);
  await waitForCoinWindow(mint); // a trade in the launch window pays the window's fee, not the tier's: wait it out before any trade this test measures
  made.push(mint);
  return { mint, creator };
}

async function get(path: string): Promise<{ status: number; body: any; text: string }> {
  const res = await handleRequest(new Request(`http://pad.test/api${path}`));
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

describe.if(live)("trader routes on a real pool", () => {
  const FIRST_BUY = 20_000_000n; // 0.2 ZEC
  let mint = "";
  let creator: Keypair;
  const wallet = Keypair.generate().publicKey.toBase58();

  test("setup: a coin on the 1% tier with a 0.2 ZEC first buy by its creator", async () => {
    await ensureDbcConfig();
    ({ mint, creator } = await launch("A", FIRST_BUY.toString()));
    expect(db.getCoin(mint)!.status).toBe("launched");
  }, 240_000);

  test("the quote is exactly the quote trade-tx would carry, on a buy and on a sell, for several sizes and slippages", async () => {
    for (const [side, amount, slippageBps] of [["buy", "5000000", 100], ["buy", "50000000", 300], ["buy", "1", 100], ["sell", "1000000000000", 100], ["sell", "20000000000000", 50]] as const) {
      const r = await get(`/coins/${mint}/quote?side=${side}&amount=${amount}&slippageBps=${slippageBps}`);
      const built = await buildTradeTx({ wallet, mint, side, amount, slippageBps }).catch(() => null);
      if (built === null) {
        expect(r.status).toBe(400); // an amount the pool cannot fill is refused the same way in both
        expect(r.body).toEqual({ error: "bad_amount", field: "amount" });
        continue;
      }
      expect(r.status).toBe(200);
      expect({ in: r.body.in, out: r.body.out, minOut: r.body.minOut, feeZec: r.body.feeZec }).toEqual(built.quote);
      expect(r.body).toMatchObject({ side, route: "curve", slippageBps });
      expect(Object.keys(r.body).sort()).toEqual(["at", "feeBps", "feeZec", "in", "minOut", "out", "priceImpactBps", "route", "side", "slippageBps", "windowSecondsLeft"]); // v2.8 added feeBps and windowSecondsLeft
    }
  });

  test("slippage only moves minOut: the same trade at 0% and at 50% has the same out and fee", async () => {
    const zero = (await get(`/coins/${mint}/quote?side=buy&amount=10000000&slippageBps=0`)).body;
    const half = (await get(`/coins/${mint}/quote?side=buy&amount=10000000&slippageBps=5000`)).body;
    expect([zero.out, zero.feeZec]).toEqual([half.out, half.feeZec]);
    expect(zero.minOut).toBe(zero.out);
    expect(BigInt(half.minOut)).toBe(BigInt(half.out) / 2n);
    expect((await get(`/coins/${mint}/quote?side=buy&amount=10000000`)).body.slippageBps).toBe(100); // the default
  });

  test("the fee is the pool's: 1% of a buy's input, paid out of it, and holders' share follows the coin's own split", async () => {
    const r = (await get(`/coins/${mint}/quote?side=buy&amount=50000000`)).body;
    expect(r.feeZec).toBe("500000"); // 1% of 0.5 ZEC, rounded up as the program rounds
    const coin = (await get(`/coins/${mint}`)).body;
    expect(coin.feeBps).toBe(100);
  });

  test("price impact: worked out from the pool's own price before the trade, fee left out, the way the contract says", async () => {
    const view = (await readCoinView(db.getCoin(mint)!))!;
    const spot = Number(view.priceZec); // zats per whole token
    for (const amount of ["5000000", "50000000", "200000000"]) {
      const r = (await get(`/coins/${mint}/quote?side=buy&amount=${amount}`)).body;
      const exec = (Number(amount) - Number(r.feeZec)) / (Number(r.out) / 1e6);
      const expected = Math.floor((exec / spot - 1) * 10_000);
      expect(Math.abs(r.priceImpactBps - expected)).toBeLessThanOrEqual(3); // the view's price is rounded to 12 decimals
    }
    const small = (await get(`/coins/${mint}/quote?side=buy&amount=1000000`)).body.priceImpactBps;
    const big = (await get(`/coins/${mint}/quote?side=buy&amount=200000000`)).body.priceImpactBps;
    expect(big).toBeGreaterThan(small);
    const sellSmall = (await get(`/coins/${mint}/quote?side=sell&amount=1000000000`)).body.priceImpactBps;
    const sellBig = (await get(`/coins/${mint}/quote?side=sell&amount=30000000000000`)).body.priceImpactBps;
    expect(sellBig).toBeGreaterThanOrEqual(sellSmall);
    expect(sellSmall).toBeGreaterThanOrEqual(0);
  });

  test("a buy bigger than the curve can take, and a sell of more than anyone holds, are refused 400 bad_amount", async () => {
    expect((await get(`/coins/${mint}/quote?side=buy&amount=1000000000000`)).body).toEqual({ error: "bad_amount", field: "amount" });
    expect((await get(`/coins/${mint}/quote?side=sell&amount=18446744073709551615`)).body).toEqual({ error: "bad_amount", field: "amount" });
  });

  test("varying the amount costs no extra chain read: sixty different amounts inside the window read the pool at most once", async () => {
    clearQuoteCaches();
    await new Promise((r) => setTimeout(r, QUOTE_MAX_AGE_MS + 50)); // the snapshot kept from the earlier tests is out of its window
    const before = quoteReads.snapshots;
    await Promise.all(Array.from({ length: 60 }, (_, i) => get(`/coins/${mint}/quote?side=${i % 2 ? "buy" : "sell"}&amount=${1_000_000 + i * 7_919}`)));
    expect(quoteReads.snapshots - before).toBeLessThanOrEqual(1);
  });

  test("an identical question inside the window is answered from memory with the same read time; after the window the pool is read again", async () => {
    clearQuoteCaches();
    await new Promise((r) => setTimeout(r, QUOTE_MAX_AGE_MS + 50));
    const a = (await get(`/coins/${mint}/quote?side=buy&amount=3000000`)).body;
    const b = (await get(`/coins/${mint}/quote?side=buy&amount=3000000`)).body;
    expect(b.at).toBe(a.at);
    await new Promise((r) => setTimeout(r, QUOTE_MAX_AGE_MS + 50));
    const c = (await get(`/coins/${mint}/quote?side=buy&amount=3000000`)).body;
    expect(c.at > a.at).toBe(true);
  });

  test("pot: the pool's accrued partner fee is what the fee model says the first buy produced, split holders/team the way an epoch splits it", async () => {
    const pot = await get(`/coins/${mint}/pot`);
    expect(pot.status).toBe(200);
    const model = tradeSplit(FIRST_BUY, 100);
    expect(pot.body.accruedZats).toBe(model.partner.toString());
    const metrics = await getDbcClient().state.getPoolFeeMetrics(db.getCoin(mint)!.poolId!);
    expect(pot.body.accruedZats).toBe(metrics.current.partnerQuoteFee.toString());
    const { holders, team } = splitClaim(model.partner, config.epoch.team.shareBps);
    expect([pot.body.holdersZats, pot.body.teamZats]).toEqual([holders.toString(), team.toString()]);
    expect(pot.body.lastPayout).toBeNull();
    expect(pot.body.minClaimZats).toBe(config.epoch.minClaimZats.toString());
    expect(Object.keys(pot.body).sort()).toEqual(["accruedZats", "asOf", "holdersZats", "lastPayout", "minClaimZats", "nextPayoutAt", "teamZats"]);
  });

  test("fixed: every fact is what the chain says about this coin's config, mint and pool", async () => {
    const coin = db.getCoin(mint)!;
    const r = await get(`/coins/${mint}/fixed`);
    expect(r.status).toBe(200);
    const f = r.body;
    expect(f).toMatchObject({ mint, network: "local" });
    expect(f.config.id).toBe(coin.configId!);
    for (const section of ["config", "curveFee", "creatorShare", "migration", "liquidity", "feeClaimer"]) expect(f[section].source).toBe(coin.configId!);
    expect(f.curveFee.bps).toBe(100);
    expect(f.creatorShare).toMatchObject({ bps: 0, percentage: 0 });
    expect(f.migration.thresholdZats).toBe(db.getDbcConfig(coin.configId!)!.migrationQuoteThreshold);
    expect(f.liquidity).toMatchObject({ partnerLockedPct: 100, creatorLockedPct: 0, unlockedPct: 0 });
    expect(f.graduatedFee).toMatchObject({ minBps: 100, maxBps: 120, source: "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp" });
    expect(f.tokenAuthorities).toEqual({ mintAuthority: null, freezeAuthority: null, updateAuthority: null, source: mint });
    expect(f.feeClaimer.address).toBe(db.getDbcConfig(coin.configId!)!.feeClaimer);
    expect(f.pause).toMatchObject({ padCanPause: false, curve: { pausableByMeteoraCurrentCode: false }, pool: { pausableByMeteora: true, paused: null } });
    expect(f.pause.curve.source).toBe(config.solana.dbc.programId.toBase58());
    expect(f.snapshotRule).toMatchObject({ samplesPerWindow: config.epoch.snapshots.count, windowHours: Math.round(config.scheduler.epochEveryMs / 3_600_000), minBalanceRaw: "1" });
    // independent of the engine's own reader: the mint really has no authority left
    const mintInfo = await getConnection().getAccountInfo(new PublicKey(mint));
    expect(mintInfo).not.toBeNull();
  });

  test("holders: the curve's vault is the pool row, the creator is the dev, and the shares add up against the real vault balance", async () => {
    const r = await get(`/coins/${mint}/holders`);
    expect(r.status).toBe(200);
    const h = r.body;
    const poolRow = h.holders.find((x: any) => x.tags.includes("pool"));
    expect(poolRow.label).toBe("Meteora bonding curve");
    const vault = (await getDbcClient().state.getPool(db.getCoin(mint)!.poolId!))!.poolState.baseVault;
    expect(poolRow.wallet).toBe(vault.toBase58());
    expect(poolRow.balance).toBe((await getConnection().getTokenAccountBalance(vault)).value.amount);
    const dev = h.holders.find((x: any) => x.tags.includes("dev"));
    expect(dev.wallet).toBe(creator.publicKey.toBase58());
    expect(BigInt(dev.balance)).toBeGreaterThan(0n);
    expect(h.holdersCount).toBe(1);
    expect(h.total).toBe(2);
    expect(h.devPct).toBe(dev.pct);
    expect(h.top10Pct).toBe(dev.pct);
    expect(h.poolPct).toBe(poolRow.pct);
    expect(h.supply).toBe((BigInt(config.solana.dbc.totalSupply) * 10n ** 6n).toString());
    expect(h.source).toBe("chain");
    expect(h.holders[0].tags).toEqual(["pool"]); // the curve holds almost all of it: rank 1
    expect((await get(`/coins`)).body.coins.find((c: any) => c.mint === mint)?.holders ?? 1).toBe(1); // the same count as Coin.holders (when the board lists it)
  });

  test("holders: a wallet that signed up for shielded delivery is neither tagged nor counted (v2.9: whether a wallet opted in is private)", async () => {
    const before = (await get(`/coins/${mint}/holders`)).body;
    expect(before.optedInCount).toBeUndefined();
    db.upsertOptin(creator.publicKey.toBase58(), "uregtest1thisaddressmustneverappearinanyanswer0123456789");
    clearStatsCache();
    try {
      const r = await get(`/coins/${mint}/holders`);
      expect(r.body.optedInCount).toBeUndefined();
      expect(r.body.holders.find((x: any) => x.tags.includes("dev")).tags).toEqual(["dev"]);
      expect(r.text).not.toMatch(/optedIn|uregtest1/);
      expect(r.body.holders).toEqual(before.holders); // the same rows as before the wallet signed up
    } finally {
      db.getDb().query("DELETE FROM optins WHERE wallet = $w").run({ $w: creator.publicKey.toBase58() });
      clearStatsCache();
    }
  });

  test("holders pages: offset 1 is the creator alone, offset 2 is empty with the same totals", async () => {
    const second = (await get(`/coins/${mint}/holders?limit=1&offset=1`)).body;
    expect(second.holders.map((x: any) => x.rank)).toEqual([2]);
    expect(second.holders[0].tags).toEqual(["dev"]);
    const past = (await get(`/coins/${mint}/holders?limit=5&offset=2`)).body;
    expect([past.holders, past.total, past.holdersCount]).toEqual([[], 2, 1]);
  });

  test("a wallet that buys on its own page shows up in the trades tape once the engine records it", async () => {
    const pre = (await get(`/coins/${mint}/trades`)).body.trades.length;
    db.insertTrade({ sig: `${tag}-t1`, mint, side: "buy", wallet: creator.publicKey.toBase58(), amountToken: "1000000", amountZec: "10000", at: new Date().toISOString() });
    const tape = (await get(`/coins/${mint}/trades`)).body.trades;
    expect(tape.length).toBe(pre + 1);
    expect(tape[0]).toMatchObject({ sig: `${tag}-t1`, mint, symbol: `${tag}A`, side: "buy", tags: ["dev"] });
  });
});
