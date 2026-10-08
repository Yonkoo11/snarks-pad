// The v2.6 trader routes docs/API.md on the real chain, the real database and the real server process that scripts/e2e.ts has
// just run five rounds through. Every expected number is worked out here from the chain, the database or the Meteora SDKs, never by
// calling the engine's own view code, so a mistake in a view cannot agree with itself.
import { homedir } from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import * as sqds from "@sqds/multisig";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { payoutRail } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";
import { tradeSplit } from "../src/dbc/tiers";
import { buildTradeTx, confirmTrade, type TradeQuote } from "../src/dbc/trade";
import { epochReceiptMessage, shieldedViewMessage } from "../src/optin/message";
import { getConnection, getCpAmm, getDbcClient } from "../src/solana";
import { enhanceWallet, receivedMemos, rewardMemo, syncWallet } from "../src/zcash/devtool";

export interface TraderCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface TraderRun {
  apiBase: string;
  /** Graduated to DAMM v2 in the second round (the 1% tier, its fee claimer a plain keypair). */
  graduated: string;
  /** On the curve; its fee claimer is vault 0 of a Squads multisig. */
  vaultCoin: { mint: string; multisig: PublicKey };
  /** On the curve, on a creator-fee tier, launched by `creator`. */
  tierCoin: { mint: string; bps: number; symbol: string; creator: Keypair };
  whale: Keypair;
  /** Every wallet the run made: the only holders the graduated coin has. */
  known: Set<string>;
  optinBuyers: { keypair: Keypair; walletDir: string }[];
  /** A holder of the graduated coin that every round paid on the Solana rail. */
  solanaHolder: string;
  /** The rounds the checks name: the first, the one that paid the graduated coin last, the Squads-vault coin's and the tier coin's. */
  rounds: { first: db.EpochRow; graduated: db.EpochRow; vault: db.EpochRow; tier: db.EpochRow };
  buy: (signer: Keypair, mint: string, zats: bigint) => Promise<string>;
}

// ---- small helpers ----

async function getJson<T>(run: TraderRun, path: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${run.apiBase}${path}`, init);
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

const postJson = <T>(run: TraderRun, path: string, body: unknown) => getJson<T>(run, path, { method: "POST", body: JSON.stringify(body) });

/** A group that throws is one failed check naming the error (its message only, with this machine's home folder shortened), not an e2e that dies before it writes its result. */
async function guarded(name: string, group: () => Promise<TraderCheck[]>): Promise<TraderCheck[]> {
  try {
    return await group();
  } catch (err) {
    const message = String((err as Error)?.message ?? err).split(homedir()).join("~");
    return [{ label: `api v2.6 ${name}: the checks ran to the end`, pass: false, detail: message.slice(0, 300) }];
  }
}

/** Every string, number and boolean in a JSON value, as text. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "object") for (const v of Object.values(value)) leaves(v, out);
  else out.push(String(value));
  return out;
}

const hasLeaf = (body: unknown, secrets: string[]): boolean => leaves(body).some((l) => secrets.includes(l));
const pctOf = (part: bigint, whole: bigint): number => (Number(part) * 100) / Number(whole);
const absDiff = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
const sum = (xs: bigint[]): bigint => xs.reduce((s, x) => s + x, 0n);

async function tokenBalance(mint: PublicKey, wallet: string): Promise<bigint> {
  try {
    return (await getAccount(getConnection(), getAssociatedTokenAddressSync(mint, new PublicKey(wallet), false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  } catch {
    return 0n; // no token account yet
  }
}

// ---- the trades the checks look at, made before the first route is asked (every chain-backed answer is cached for seconds) ----

interface Placed {
  dammBuy: bigint;
  dammSig: string;
  /** The whole pool fee the DAMM buy was quoted to pay, before it was made. */
  dammFeeZec: bigint;
  tierBuys: bigint[];
  /** The three trades just recorded: the DAMM buy, the whale's tier-coin buy and the creator's. */
  sigs: string[];
}

async function placeTrades(run: TraderRun): Promise<Placed> {
  const { graduated, tierCoin, whale } = run;
  const dammBuy = 30_000_000n;
  const quote = (await buildTradeTx({ wallet: whale.publicKey.toBase58(), mint: graduated, side: "buy", amount: dammBuy.toString(), slippageBps: 100 })).quote;
  const dammSig = await run.buy(whale, graduated, dammBuy);
  await confirmTrade(dammSig, graduated);
  const tierBuys = [50_000_000n, 5_000_000n];
  const whaleSig = await run.buy(whale, tierCoin.mint, tierBuys[0]!);
  await confirmTrade(whaleSig, tierCoin.mint);
  const creatorSig = await run.buy(tierCoin.creator, tierCoin.mint, tierBuys[1]!); // the creator's own buy: the tape marks it `dev`
  await confirmTrade(creatorSig, tierCoin.mint);
  return { dammBuy, dammSig, dammFeeZec: BigInt(quote.feeZec), tierBuys, sigs: [dammSig, whaleSig, creatorSig] };
}

// ---- quote ----

interface QuoteJson {
  side: string;
  in: string;
  out: string;
  minOut: string;
  feeZec: string;
  priceImpactBps: number;
  route: string;
  slippageBps: number;
  at: string;
}

const SLIPPAGE_BPS = 50;

/**
 * The API's quote and the one trade-tx builds are the same numbers. A pool whose fee moves with time can straddle a tick between
 * the two reads, so a difference is tried twice more (after the API's 2 s snapshot expired) before it counts.
 */
async function quoteAndBuilder(run: TraderRun, mint: string, side: "buy" | "sell", amount: bigint): Promise<{ api: QuoteJson; built: TradeQuote; same: boolean }> {
  const wallet = run.whale.publicKey.toBase58();
  let result: { api: QuoteJson; built: TradeQuote; same: boolean } | null = null;
  for (let attempt = 0; attempt < 3 && !result?.same; attempt++) {
    if (attempt > 0) await Bun.sleep(2_100);
    const api = (await getJson<QuoteJson>(run, `/coins/${mint}/quote?side=${side}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`)).body;
    const built = (await buildTradeTx({ wallet, mint, side, amount: amount.toString(), slippageBps: SLIPPAGE_BPS })).quote;
    result = { api, built, same: api.in === built.in && api.out === built.out && api.minOut === built.minOut && api.feeZec === built.feeZec };
  }
  return result!;
}

async function curveQuoteChecks(run: TraderRun): Promise<TraderCheck[]> {
  const { tierCoin } = run;
  type Answer = QuoteJson & { error?: string; field?: string };
  const ask = (amount: string) => getJson<Answer>(run, `/coins/${tierCoin.mint}/quote?side=buy&amount=${amount}`);
  const [small, big, tooBig] = [await ask("20000000"), await ask("200000000"), await ask("100000000000")];
  const fee = (zats: bigint) => tradeSplit(zats, tierCoin.bps).fee.toString();
  return [
    {
      label: `api v2.6 quote: the fee on a curve buy is the ${tierCoin.bps / 100}% tier's to the zat, and a quote sent no slippage uses 100 bps`,
      pass: small.body.feeZec === fee(20_000_000n) && big.body.feeZec === fee(200_000_000n) && small.body.slippageBps === 100,
      detail: `20M: ${small.body.feeZec} (model ${fee(20_000_000n)}), 200M: ${big.body.feeZec} (model ${fee(200_000_000n)})`,
    },
    {
      label: "api v2.6 quote: price impact grows with the size of the buy, and a buy past the fundraising target is 400 bad_amount on amount",
      pass: big.body.priceImpactBps > small.body.priceImpactBps && tooBig.status === 400 && tooBig.body.error === "bad_amount" && tooBig.body.field === "amount",
      detail: `impact ${small.body.priceImpactBps} bps at 0.2 ZEC, ${big.body.priceImpactBps} bps at 2 ZEC; past the target: ${tooBig.status} ${tooBig.body.error}`,
    },
  ];
}

async function quoteChecks(run: TraderRun): Promise<TraderCheck[]> {
  const buyZats = 20_000_000n;
  const sellTokens = 1_000_000_000n; // 1,000 tokens at 6 decimals
  const cases = [
    { name: "buy on the graduated coin", mint: run.graduated, side: "buy" as const, amount: buyZats, route: "damm" },
    { name: "sell on the graduated coin", mint: run.graduated, side: "sell" as const, amount: sellTokens, route: "damm" },
    { name: "buy on the curve", mint: run.tierCoin.mint, side: "buy" as const, amount: buyZats, route: "curve" },
    { name: "sell on the curve", mint: run.tierCoin.mint, side: "sell" as const, amount: sellTokens, route: "curve" },
  ];
  const out: TraderCheck[] = [];
  for (const c of cases) {
    const { api, built, same } = await quoteAndBuilder(run, c.mint, c.side, c.amount);
    const sane = api.route === c.route && api.side === c.side && api.slippageBps === SLIPPAGE_BPS && Number.isInteger(api.priceImpactBps) && api.priceImpactBps >= 0;
    out.push({ label: `api v2.6 quote: a ${c.name} routes to ${c.route} and equals the numbers trade-tx builds for the same trade`, pass: same && sane, detail: `api=${JSON.stringify(api)} builder=${JSON.stringify(built)}` });
  }
  return [...out, ...(await curveQuoteChecks(run))];
}

// ---- pot ----

interface PotJson {
  accruedZats: string;
  holdersZats: string;
  teamZats: string;
  minClaimZats: string;
  nextPayoutAt: string | null;
  lastPayout: { epochId: string; at: string; totalZats: string; shieldedZats: string } | null;
  asOf: string;
}

/** What a round paid holders on both rails (the team's sweep is neither). */
function paidIn(epochId: string): { total: bigint; shielded: bigint } {
  const rows = db.getPayouts(epochId);
  const on = (rail: "solana" | "shielded") => sum(rows.filter((p) => payoutRail(p) === rail).map((p) => BigInt(p.amountZats)));
  return { total: on("solana") + on("shielded"), shielded: on("shielded") };
}

const splitHolds = (p: PotJson): boolean => BigInt(p.teamZats) === (BigInt(p.accruedZats) * 2500n) / 10_000n && BigInt(p.holdersZats) === BigInt(p.accruedZats) - BigInt(p.teamZats);

function lastPayoutIs(pot: PotJson, round: db.EpochRow): boolean {
  const paid = paidIn(round.id);
  return pot.lastPayout?.epochId === round.id && pot.lastPayout.at === round.at && pot.lastPayout.totalZats === paid.total.toString() && pot.lastPayout.shieldedZats === paid.shielded.toString() && paid.total > 0n;
}

async function potChecks(run: TraderRun, placed: Placed): Promise<TraderCheck[]> {
  const { tierCoin, graduated, vaultCoin, rounds } = run;
  const ask = async (mint: string) => (await getJson<PotJson>(run, `/coins/${mint}/pot`)).body;
  const [tier, grad, vault] = [await ask(tierCoin.mint), await ask(graduated), await ask(vaultCoin.mint)];
  const treasury = (await getJson<{ nextEpochAt: string | null }>(run, "/treasury")).body;
  const heldByPool = BigInt((await getDbcClient().state.getPoolFeeMetrics(db.getCoin(tierCoin.mint)!.poolId!)).current.partnerQuoteFee.toString());
  const modelTier = sum(placed.tierBuys.map((b) => tradeSplit(b, tierCoin.bps).partner));
  const modelGrad = (placed.dammFeeZec * 80n) / 100n; // the partner's locked position earns what the pool keeps after Meteora's 20%
  const slack = placed.dammFeeZec / 100n > 2n ? placed.dammFeeZec / 100n : 2n;
  return [
    { label: "api v2.6 pot: a curve coin's accrued fee is what the pool itself holds for the partner, and equals the modelled split of the two buys just made, to the zat", pass: tier.accruedZats === heldByPool.toString() && heldByPool === modelTier && modelTier > 0n, detail: `answer=${tier.accruedZats} pool counter=${heldByPool} model=${modelTier}` },
    { label: "api v2.6 pot: a graduated coin's accrued fee is its locked position's unclaimed fee: 80% of the pool fee the buy paid (within 1% of it)", pass: absDiff(BigInt(grad.accruedZats), modelGrad) <= slack && BigInt(grad.accruedZats) > 0n, detail: `answer=${grad.accruedZats} model=${modelGrad} pool fee=${placed.dammFeeZec}` },
    { label: "api v2.6 pot: holders' part and the team's floor(25%) add up to the accrued fee; the minimum claim and the next payout are the engine's own (the same instant /treasury shows)", pass: [tier, grad, vault].every(splitHolds) && tier.minClaimZats === config.epoch.minClaimZats.toString() && tier.nextPayoutAt !== null && tier.nextPayoutAt === treasury.nextEpochAt, detail: `tier=${JSON.stringify([tier.holdersZats, tier.teamZats])} next=${tier.nextPayoutAt} treasury=${treasury.nextEpochAt}` },
    { label: "api v2.6 pot: the last payout is the newest round that paid the coin's holders (the vault coin's round 4, the tier coin's round 5, the graduated coin's round 3), with what that round paid on both rails", pass: lastPayoutIs(tier, rounds.tier) && lastPayoutIs(vault, rounds.vault) && lastPayoutIs(grad, rounds.graduated), detail: `tier=${JSON.stringify(tier.lastPayout)} vault=${vault.lastPayout?.epochId} graduated=${grad.lastPayout?.epochId}` },
  ];
}

// ---- fixed ----

interface FixedJson {
  config: { id: string; source: string };
  curveFee: { bps: number; source: string };
  graduatedFee: { minBps: number; maxBps: number; source: string };
  creatorShare: { bps: number; percentage: number; source: string };
  migration: { thresholdZats: string; source: string };
  liquidity: { partnerLockedPct: number; creatorLockedPct: number; unlockedPct: number; source: string };
  tokenAuthorities: { mintAuthority: string | null; freezeAuthority: string | null; source: string };
  feeClaimer: { address: string; kind: string; multisig: { address: string; threshold: number; members: number; timeLock: number; autonomous: boolean } | null; source: string };
  pause: { padCanPause: boolean; curve: { pausableByMeteoraCurrentCode: boolean; source: string }; pool: { pausableByMeteora: boolean; paused: boolean | null; source: string } };
}

/** bps of a fee numerator over the program's 1,000,000,000 denominator (the DBC config keeps it as a number, DAMM v2 packs it in 32 bytes). */
const feeBps = (numerator: { toString(): string }): number => Number(numerator.toString()) / 100_000;
/** The base fee of a DAMM v2 config or pool: the first 8 bytes of its packed fee data are cliff_fee_numerator (u64, little endian). */
const dammBaseFeeBps = (packed: { data: number[] }): number => feeBps(Buffer.from(packed.data).readBigUInt64LE(0));

/** Where the DAMM v2 side of "what is fixed" is read from: the config account the migration names, and the pool itself once it exists. */
async function graduatedFeeMismatches(f: FixedJson, coin: db.CoinRow): Promise<string[]> {
  const cp = getCpAmm();
  const base = dammBaseFeeBps((await cp.fetchConfigState(new PublicKey(f.graduatedFee.source))).poolFees.baseFee);
  const wrong: string[] = [];
  if (f.graduatedFee.minBps !== base || f.graduatedFee.maxBps !== Math.round(base * 1.2)) wrong.push(`graduated fee ${f.graduatedFee.minBps}..${f.graduatedFee.maxBps} against the DAMM v2 config's ${base}`);
  if (coin.dammPool && dammBaseFeeBps((await cp.fetchPoolState(new PublicKey(coin.dammPool))).poolFees.baseFee.baseFeeInfo) !== base) wrong.push("the graduated pool's own base fee differs from its config's");
  return wrong;
}

/** The differences between a /fixed answer and what the chain says, read here straight from the config, the mint and the DAMM v2 accounts. */
async function fixedMismatches(f: FixedJson, mint: string): Promise<string[]> {
  const coin = db.getCoin(mint)!;
  const pool = (await getDbcClient().state.getPool(coin.poolId!))!.poolState;
  const cfg = (await getDbcClient().state.getPoolConfig(pool.config))!;
  const token = await getMint(getConnection(), new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  const id = pool.config.toBase58();
  const wrong: string[] = [];
  const must = (what: string, ok: boolean): void => void (ok || wrong.push(what));
  must("config account", f.config.id === id && f.config.source === id);
  must("curve fee", f.curveFee.bps === feeBps(cfg.poolFees.baseFee.cliffFeeNumerator));
  must("creator share", f.creatorShare.percentage === cfg.creatorTradingFeePercentage && f.creatorShare.bps === 80 * cfg.creatorTradingFeePercentage);
  must("migration threshold", f.migration.thresholdZats === cfg.migrationQuoteThreshold.toString());
  must("locked liquidity", f.liquidity.partnerLockedPct === cfg.partnerPermanentLockedLiquidityPercentage && f.liquidity.creatorLockedPct === cfg.creatorPermanentLockedLiquidityPercentage && f.liquidity.unlockedPct === cfg.partnerLiquidityPercentage + cfg.creatorLiquidityPercentage);
  must("token authorities", f.tokenAuthorities.mintAuthority === (token.mintAuthority?.toBase58() ?? null) && f.tokenAuthorities.freezeAuthority === (token.freezeAuthority?.toBase58() ?? null) && f.tokenAuthorities.source === mint);
  must("fee claimer", f.feeClaimer.address === cfg.feeClaimer.toBase58());
  return [...wrong, ...(await graduatedFeeMismatches(f, coin))];
}

/** Every `source` an answer names. */
function sourcesOf(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  for (const [key, v] of Object.entries(value)) {
    if (key === "source" && typeof v === "string") out.push(v);
    else sourcesOf(v, out);
  }
  return out;
}

async function missingSources(f: FixedJson): Promise<string[]> {
  const sources = [...new Set(sourcesOf(f))];
  const infos = await getConnection().getMultipleAccountsInfo(sources.map((s) => new PublicKey(s)), "confirmed");
  return sources.filter((_, i) => infos[i] === null);
}

/** A second API process, started the way production runs it (SQUADS_MULTISIG set), for the one coin whose claimer is a vault. */
async function withVaultApi<T>(run: TraderRun, use: (base: string) => Promise<T>): Promise<T> {
  const port = config.api.port + 1;
  const base = `http://localhost:${port}/api`;
  const proc = Bun.spawn(["bun", "run", "scripts/api.ts"], { cwd: config.paths.engineRoot, stdout: "ignore", stderr: "ignore", env: { ...process.env, PAD_API_PORT: String(port), SQUADS_MULTISIG: run.vaultCoin.multisig.toBase58() } });
  try {
    for (let i = 0; i < 40 && !(await fetch(`${base}/treasury`).catch(() => null))?.ok; i++) await Bun.sleep(500);
    return await use(base);
  } finally {
    proc.kill();
  }
}

async function vaultFixedCheck(run: TraderRun): Promise<TraderCheck> {
  const f = await withVaultApi(run, async (base) => (await (await fetch(`${base}/coins/${run.vaultCoin.mint}/fixed`)).json()) as FixedJson);
  const chain = await sqds.accounts.Multisig.fromAccountAddress(getConnection(), run.vaultCoin.multisig, "confirmed");
  const vault = sqds.getVaultPda({ multisigPda: run.vaultCoin.multisig, index: 0 })[0].toBase58();
  const expected = { address: run.vaultCoin.multisig.toBase58(), threshold: chain.threshold, members: chain.members.length, timeLock: chain.timeLock, autonomous: chain.configAuthority.equals(PublicKey.default) };
  const m = f.feeClaimer.multisig;
  return {
    label: "api v2.6 fixed: the Squads-vault coin names the vault as fee claimer and its multisig: 2 of 3, no time lock, no config authority (nobody can change the members alone)",
    pass: f.feeClaimer.kind === "squads_vault" && f.feeClaimer.address === vault && JSON.stringify(m) === JSON.stringify(expected) && m?.threshold === 2 && m.members === 3 && m.autonomous,
    detail: `kind=${f.feeClaimer.kind} multisig=${JSON.stringify(m)}`,
  };
}

async function fixedSpecificChecks(run: TraderRun): Promise<TraderCheck[]> {
  const ask = async (mint: string) => (await getJson<FixedJson>(run, `/coins/${mint}/fixed`)).body;
  const [grad, tier] = [await ask(run.graduated), await ask(run.tierCoin.mint)];
  const dammProgram = config.solana.dbc.dammProgramId.toBase58();
  return [
    { label: "api v2.6 fixed: the graduated coin reads its pool as enabled; nothing here can pause a pool or the curve, and the answer says Meteora can pause the pool", pass: grad.pause.pool.paused === false && grad.pause.pool.source === db.getCoin(run.graduated)!.dammPool && !grad.pause.padCanPause && grad.pause.pool.pausableByMeteora && !grad.pause.curve.pausableByMeteoraCurrentCode && grad.feeClaimer.kind === "other" && grad.feeClaimer.multisig === null, detail: JSON.stringify(grad.pause) },
    { label: `api v2.6 fixed: the ${run.tierCoin.bps / 100}% tier coin: curve fee ${run.tierCoin.bps} bps, creator share 6000 bps (75%), DAMM v2 pool fee ${run.tierCoin.bps}..${Math.round(run.tierCoin.bps * 1.2)} bps, pool not created yet (paused null, source the DAMM v2 program)`, pass: tier.curveFee.bps === run.tierCoin.bps && tier.creatorShare.bps === 6000 && tier.creatorShare.percentage === 75 && tier.graduatedFee.minBps === run.tierCoin.bps && tier.graduatedFee.maxBps === Math.round(run.tierCoin.bps * 1.2) && tier.pause.pool.paused === null && tier.pause.pool.source === dammProgram, detail: JSON.stringify([tier.curveFee, tier.creatorShare, tier.graduatedFee, tier.liquidity]) },
  ];
}

async function fixedChecks(run: TraderRun): Promise<TraderCheck[]> {
  const coins = [["graduated 1% coin", run.graduated], ["Squads-vault coin", run.vaultCoin.mint], [`${run.tierCoin.bps / 100}% tier coin`, run.tierCoin.mint]] as const;
  const out: TraderCheck[] = [];
  for (const [name, mint] of coins) {
    const { status, body: f } = await getJson<FixedJson>(run, `/coins/${mint}/fixed`);
    const wrong = [...(await fixedMismatches(f, mint)), ...(await missingSources(f)).map((s) => `source ${s} is not on chain`)];
    out.push({ label: `api v2.6 fixed: the ${name}: every value equals the chain's (config, mint, DAMM v2 config and pool accounts) and every source account exists`, pass: status === 200 && wrong.length === 0, detail: wrong.join("; ") || "all equal" });
  }
  return [...out, ...(await fixedSpecificChecks(run)), await vaultFixedCheck(run)];
}

// ---- holders ----

interface HolderRowJson {
  rank: number;
  wallet: string;
  balance: string;
  pct: number;
  tags: string[];
  label?: string;
}

interface HoldersJson {
  holders: HolderRowJson[];
  total: number;
  holdersCount: number;
  top10Pct: number;
  devPct: number;
  poolPct: number | null;
  supply: string;
  asOf: string;
  source: string;
}

/** The first request is served from the keeper's sample while the API reads the chain in the background: ask until the chain's numbers are in. */
async function holdersFromChain(run: TraderRun): Promise<{ status: number; body: HoldersJson }> {
  let last = await getJson<HoldersJson>(run, `/coins/${run.graduated}/holders?limit=100`);
  for (let i = 0; i < 40 && last.status === 200 && last.body.source !== "chain"; i++) {
    await Bun.sleep(500);
    last = await getJson<HoldersJson>(run, `/coins/${run.graduated}/holders?limit=100`);
  }
  return last;
}

async function poolVaultOf(coin: db.CoinRow): Promise<{ account: string; balance: bigint }> {
  const pool = await getCpAmm().fetchPoolState(new PublicKey(coin.dammPool!));
  const account = pool.tokenAMint.toBase58() === coin.mint ? pool.tokenAVault : pool.tokenBVault;
  return { account: account.toBase58(), balance: BigInt((await getConnection().getTokenAccountBalance(account, "confirmed")).value.amount) };
}

async function holderBalanceChecks(run: TraderRun, h: HoldersJson, status: number): Promise<TraderCheck[]> {
  const mint = new PublicKey(run.graduated);
  const people = h.holders.filter((r) => !r.tags.includes("pool"));
  const onChain = new Map<string, bigint>();
  for (const w of run.known) onChain.set(w, await tokenBalance(mint, w));
  const holding = [...onChain].filter(([, b]) => b > 0n).map(([w]) => w).sort();
  const vault = await poolVaultOf(db.getCoin(run.graduated)!);
  const poolRow = h.holders.find((r) => r.wallet === vault.account);
  const ordered = h.holders.every((r, i) => r.rank === i + 1 && (i === 0 || BigInt(h.holders[i - 1]!.balance) >= BigInt(r.balance)));
  return [
    { label: "api v2.6 holders: the numbers come from the chain read in the background (source chain, taken just now), not only from the keeper's sample", pass: status === 200 && h.source === "chain" && Date.now() - Date.parse(h.asOf) < 120_000, detail: `source=${h.source} asOf=${h.asOf}` },
    { label: "api v2.6 holders: the wallets listed are exactly the wallets that hold the coin on chain (every wallet this run made, read here), each with its on-chain balance, largest first", pass: JSON.stringify(people.map((r) => r.wallet).sort()) === JSON.stringify(holding) && people.every((r) => r.balance === onChain.get(r.wallet)?.toString()) && ordered, detail: `${people.length} listed, ${holding.length} hold the coin on chain` },
    { label: "api v2.6 holders: the DAMM v2 pool's vault is a row tagged pool with its on-chain balance, labelled, and never counted as a holder", pass: !!poolRow && poolRow.tags.length === 1 && poolRow.tags[0] === "pool" && poolRow.balance === vault.balance.toString() && !!poolRow.label && people.every((r) => r.wallet !== vault.account), detail: `vault ${vault.account} balance=${vault.balance} row=${JSON.stringify(poolRow)}` },
  ];
}

async function holderTotalsChecks(run: TraderRun, h: HoldersJson): Promise<TraderCheck[]> {
  const coin = db.getCoin(run.graduated)!;
  const supply = (await getMint(getConnection(), new PublicKey(run.graduated), "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const people = h.holders.filter((r) => !r.tags.includes("pool"));
  const pools = h.holders.filter((r) => r.tags.includes("pool"));
  const near = (got: number | null, want: number): boolean => got !== null && Math.abs(got - want) <= 0.00011;
  const top10 = sum(people.slice(0, 10).map((r) => BigInt(r.balance)));
  const creatorHeld = people.filter((r) => r.wallet === coin.creator).map((r) => BigInt(r.balance))[0] ?? 0n;
  const optedIn = people.filter((r) => db.getOptin(r.wallet)?.active === 1);
  return [
    { label: "api v2.6 holders: supply is the mint's; holdersCount counts the wallets (pool vaults left out) and total adds the pool rows; every pct is a share of total supply", pass: h.supply === supply.toString() && h.holdersCount === people.length && h.total === h.holders.length && h.total === people.length + pools.length && h.holders.every((r) => near(r.pct, pctOf(BigInt(r.balance), supply))), detail: `supply=${h.supply} holdersCount=${h.holdersCount} total=${h.total}` },
    { label: "api v2.6 holders: top10Pct, devPct and poolPct equal the shares worked out from the balances above", pass: near(h.top10Pct, pctOf(top10, supply)) && near(h.devPct, pctOf(creatorHeld, supply)) && near(h.poolPct, pctOf(sum(pools.map((r) => BigInt(r.balance))), supply)), detail: `top10=${h.top10Pct} dev=${h.devPct} pool=${h.poolPct}` },
    { label: "api v2.9 holders: the creator's row is tagged dev; nothing marks or counts the wallets with shielded delivery on (there are some among these holders); no Zcash address is in the answer", pass: people.filter((r) => r.tags.includes("dev")).map((r) => r.wallet).join() === coin.creator && people.every((r) => r.tags.every((t) => t === "dev")) && !("optedInCount" in h) && optedIn.length >= 3 && !hasLeaf(h, db.listActiveOptins().map((o) => o.zcashAddress)), detail: `${optedIn.length} holders have shielded delivery on, none is marked` },
  ];
}

async function holdersChecks(run: TraderRun): Promise<TraderCheck[]> {
  const { status, body } = await holdersFromChain(run);
  return [...(await holderBalanceChecks(run, body, status)), ...(await holderTotalsChecks(run, body))];
}

// ---- trades: the tape ----

interface FeedRowJson {
  sig: string;
  mint: string;
  symbol: string;
  side: string;
  wallet: string;
  amountToken: string;
  amountZec: string;
  at: string;
  tags: string[];
}

const sameTrades = (api: FeedRowJson[], recorded: db.TradeRow[]): boolean =>
  api.length === recorded.length && recorded.every((t) => api.some((a) => a.sig === t.sig && a.side === t.side && a.wallet === t.wallet && a.amountToken === t.amountToken && a.amountZec === t.amountZec && a.at === t.at));

async function tapeChecks(run: TraderRun, placed: Placed): Promise<TraderCheck[]> {
  const { tierCoin, graduated } = run;
  const tape = async (path: string) => (await getJson<{ trades: FeedRowJson[] }>(run, path)).body.trades;
  const [newest, tierTape, gradTape] = [await tape("/trades?limit=3&all=1"), await tape(`/coins/${tierCoin.mint}/trades?limit=100`), await tape(`/coins/${graduated}/trades?limit=100`)];
  const inOrder = newest.every((t, i) => i === 0 || newest[i - 1]!.at > t.at || (newest[i - 1]!.at === t.at && newest[i - 1]!.sig > t.sig));
  const creator = tierCoin.creator.publicKey.toBase58();
  return [
    { label: "api v2.6 trades: GET /trades gives the newest trades of every coin first: the three just recorded, newest block time first (trades of the same second by signature, as the price chart orders them)", pass: JSON.stringify(newest.map((t) => t.sig).sort()) === JSON.stringify([...placed.sigs].sort()) && inOrder, detail: `got ${newest.map((t) => `${t.at.slice(11, 19)} ${t.sig.slice(0, 6)}`).join(", ")}` },
    { label: "api v2.6 trades: a coin's tape is exactly the trades the database recorded for it, with its symbol, and `dev` marks the creator's own buy and nothing else", pass: sameTrades(tierTape, db.listTradesForMint(tierCoin.mint, 100)) && tierTape.every((t) => t.symbol === tierCoin.symbol && t.tags.includes("dev") === (t.wallet === creator)) && tierTape.some((t) => t.tags.includes("dev")), detail: `${tierTape.length} trades, ${tierTape.filter((t) => t.tags.includes("dev")).length} by the creator` },
    { label: "api v2.6 trades: the buy made on the graduated pool is in its tape with the ZEC the chain moved, next to the trades the seed recorded", pass: sameTrades(gradTape, db.listTradesForMint(graduated, 100)) && gradTape.some((t) => t.sig === placed.dammSig && t.side === "buy" && t.amountZec === placed.dammBuy.toString()), detail: `${gradTape.length} trades` },
  ];
}

// ---- trades: the live stream, through the real server ----

interface Chunk {
  done: boolean;
  value?: Uint8Array;
}

interface Tap {
  status: number;
  retryAfter: string | null;
  errorBody: string | null;
  text: string;
  reader: { read(): Promise<Chunk>; cancel(): Promise<void> } | null;
  pending: Promise<Chunk> | null;
  decoder: TextDecoder;
  /** Aborting the request closes the connection (cancelling the reader alone leaves it open, and the server only frees the slot when it sees it close). */
  abort: AbortController;
}

async function openTap(run: TraderRun, path: string, headers: Record<string, string> = {}): Promise<Tap> {
  const abort = new AbortController();
  const res = await fetch(`${run.apiBase}${path}`, { headers, signal: abort.signal });
  const open = res.status === 200 && res.body !== null;
  return { status: res.status, retryAfter: res.headers.get("retry-after"), errorBody: open ? null : await res.text(), text: "", reader: open ? res.body!.getReader() : null, pending: null, decoder: new TextDecoder(), abort };
}

/** Reads the stream until `done` holds for what it has sent so far, or `ms` pass. A read that timed out is kept, so no chunk is lost to it. */
async function readUntil(tap: Tap, done: (text: string) => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (tap.reader && !done(tap.text) && Date.now() < deadline) {
    tap.pending ??= tap.reader.read();
    const chunk = await Promise.race([tap.pending, Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (chunk === null) break;
    tap.pending = null;
    if (chunk.done) break;
    tap.text += tap.decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
  }
  return done(tap.text);
}

const closeTap = async (tap: Tap): Promise<void> => {
  tap.abort.abort();
  await tap.reader?.cancel().catch(() => undefined);
};

/** The trade events in what a stream has sent: `id`, `event` and the parsed `data`. */
function tradeEvents(text: string): { id: number; data: FeedRowJson }[] {
  return text.split("\n\n").flatMap((block) => {
    const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
    return field("event") === "trade" ? [{ id: Number(field("id")), data: JSON.parse(field("data")!) as FeedRowJson }] : [];
  });
}

async function liveStreamChecks(run: TraderRun, taps: Tap[]): Promise<TraderCheck[]> {
  const { tierCoin, whale } = run;
  const live = await openTap(run, `/events/trades?mint=${tierCoin.mint}`);
  taps.push(live);
  const greeted = await readUntil(live, (t) => t.includes("retry: 3000"), 3_000);
  const sig = await run.buy(whale, tierCoin.mint, 4_000_000n);
  await confirmTrade(sig, tierCoin.mint); // recorded by this process; the API process learns of it from the database
  const arrived = await readUntil(live, (t) => t.includes(sig), 10_000);
  const event = tradeEvents(live.text).find((e) => e.data.sig === sig);
  const replay = await openTap(run, `/events/trades?mint=${tierCoin.mint}`, { "last-event-id": String((event?.id ?? 1) - 1) });
  taps.push(replay);
  const replayed = await readUntil(replay, (t) => t.includes(sig), 5_000);
  return [
    { label: "api v2.6 stream: GET /events/trades answers 200 as text/event-stream and sends its retry line at once", pass: live.status === 200 && greeted, detail: `status=${live.status} first bytes=${JSON.stringify(live.text.slice(0, 40))}` },
    { label: "api v2.6 stream: a trade this process recorded reaches the stream of the API process within 10 s, once, as a trade event with the tape's fields", pass: arrived && tradeEvents(live.text).filter((e) => e.data.sig === sig).length === 1 && event?.data.symbol === tierCoin.symbol && event.data.side === "buy" && event.data.amountZec === "4000000" && event.data.mint === tierCoin.mint, detail: `event=${JSON.stringify(event)}` },
    { label: "api v2.6 stream: a reconnect with Last-Event-ID replays the trade recorded after that id", pass: replayed && tradeEvents(replay.text)[0]?.data.sig === sig, detail: `replayed ${tradeEvents(replay.text).length} event(s) after id ${(event?.id ?? 1) - 1}` },
  ];
}

async function streamLimitChecks(run: TraderRun, taps: Tap[]): Promise<TraderCheck[]> {
  while (taps.filter((t) => t.status === 200).length < 4) taps.push(await openTap(run, "/events/trades")); // four streams open from this address
  const fifth = await openTap(run, "/events/trades");
  const other = await openTap(run, "/events/trades", { "x-forwarded-for": "198.51.100.7" });
  taps.push(other);
  await closeTap(taps[taps.length - 2]!);
  let again = await openTap(run, "/events/trades");
  for (let i = 0; i < 10 && again.status !== 200; i++) {
    await Bun.sleep(300);
    again = await openTap(run, "/events/trades"); // the slot of a closed stream is freed when the server sees the disconnect
  }
  taps.push(again);
  return [
    { label: "api v2.6 stream: a fifth stream from one address is 429 rate_limited with retry-after 5, and a client behind the proxy (x-forwarded-for) has its own four", pass: fifth.status === 429 && fifth.retryAfter === "5" && fifth.errorBody === '{"error":"rate_limited"}' && other.status === 200, detail: `fifth=${fifth.status} retry-after=${fifth.retryAfter} proxied client=${other.status}` },
    { label: "api v2.6 stream: closing a stream frees its slot", pass: again.status === 200, detail: `reopened with status ${again.status}` },
  ];
}

async function streamChecks(run: TraderRun): Promise<TraderCheck[]> {
  const taps: Tap[] = [];
  try {
    return [...(await liveStreamChecks(run, taps)), ...(await streamLimitChecks(run, taps))];
  } finally {
    await Promise.all(taps.map(closeTap));
  }
}

// ---- rewards and the memo check ----

interface RewardsJson {
  wallet: string;
  solana: { count: number; totalZats: string; payouts: { epochId: string; at: string; sig: string; zats: string; coins: { mint: string; shareZats: string }[] }[] };
  memoFormat: string;
}

/** What POST /optin/status answers a wallet's own signature (contract v2.9). */
interface OptinStatusJson {
  optedIn: boolean;
  zcashAddressMasked: string | null;
  pendingZats: string;
  shielded: {
    rounds: number;
    commitments: { epochId: string; at: string; snapshotSha256: string | null; commitments: string[] }[];
    fallback: { count: number; totalZats: string; payouts: { epochId: string; sig: string; zats: string }[] };
  };
}

/** A wallet's shielded delivery, read the one way the API allows: a fresh nonce and the wallet's own signature over the status text. */
async function statusOf(run: TraderRun, owner: Keypair): Promise<OptinStatusJson> {
  const wallet = owner.publicKey.toBase58();
  const { body } = await getJson<{ nonce: string }>(run, `/optin/nonce?wallet=${wallet}`);
  const message = new TextEncoder().encode(shieldedViewMessage(wallet, body.nonce));
  const signature = bs58.encode(nacl.sign.detached(message, owner.secretKey));
  return (await postJson<OptinStatusJson>(run, "/optin/status", { wallet, nonce: body.nonce, signature })).body;
}

function paidRows(wallet: string, rail: "solana" | "shielded"): db.PayoutRow[] {
  return db.listEpochs().flatMap((e) => db.getPayouts(e.id)).filter((p) => p.wallet === wallet && payoutRail(p) === rail);
}

const sharesText = (list: { mint: string; amount: string }[]): string => list.map((s) => `${s.mint}:${s.amount}`).sort().join(",");

async function solanaRewardsCheck(run: TraderRun): Promise<TraderCheck> {
  const w = run.solanaHolder;
  const { body: r } = await getJson<RewardsJson>(run, `/rewards/${w}`);
  const rows = paidRows(w, "solana");
  const shares = (epochId: string) => sharesText(db.listEpochCoinShares(epochId).filter((s) => s.wallet === w).map((s) => ({ mint: s.mint, amount: s.amountZats })));
  const expected = rows.map((p) => `${p.epochId}|${p.sig}|${p.amountZats}|${shares(p.epochId)}`).sort();
  const got = r.solana.payouts.map((p) => `${p.epochId}|${p.sig}|${p.zats}|${sharesText(p.coins.map((c) => ({ mint: c.mint, amount: c.shareZats })))}`).sort();
  return {
    label: "api v2.6 rewards: a Solana-rail holder: every round it was paid (count, total, transaction, amount and its share from each coin) equals the payout rows, and the public answer says nothing about the shielded rail (v2.9)",
    pass: rows.length >= 3 && r.solana.count === rows.length && r.solana.totalZats === sum(rows.map((p) => BigInt(p.amountZats))).toString() && JSON.stringify(got) === JSON.stringify(expected) && !("shielded" in r) && !JSON.stringify(r).includes("optedIn") && r.memoFormat === "SNARKS pad reward, epoch <epochId>",
    detail: `${rows.length} rounds in the rows, ${r.solana.count} in the answer, total ${r.solana.totalZats}`,
  };
}

async function shieldedRewardsChecks(run: TraderRun): Promise<TraderCheck[]> {
  const owner = run.optinBuyers[0]!.keypair;
  const w = owner.publicKey.toBase58();
  const { body: pub } = await getJson<RewardsJson>(run, `/rewards/${w}`);
  const r = await statusOf(run, owner);
  const rows = paidRows(w, "shielded");
  const secrets = [db.getOptin(w)!.zcashAddress, ...rows.map((p) => p.sig!), ...rows.map((p) => p.amountZats)];
  const listed = r.shielded.commitments;
  const inFile = listed.every((c) => c.commitments.length > 0 && c.snapshotSha256 === db.getEpochSnapshot(c.epochId)?.sha256 && c.commitments.every((x) => db.getEpochSnapshot(c.epochId)!.json.includes(x)));
  return [
    { label: "api v2.9 signed status: a shielded holder, against its own signature: the rounds it was paid equal the payout rows, and each round lists its commitments, all of them found in that round's published snapshot file", pass: rows.length >= 1 && r.optedIn && r.shielded.rounds === rows.length && listed.length === rows.length && inFile && new Set(listed.map((c) => c.epochId)).size === rows.length, detail: `${rows.length} shielded rounds in the rows, ${listed.length} listed` },
    { label: "api v2.9 signed status: a shielded holder's answers (the signed one and the public rewards) hold no Zcash address, no transaction id and no amount (compared as whole values), and the public rewards hold nothing shielded", pass: !hasLeaf(r, secrets) && !hasLeaf(pub, secrets) && !JSON.stringify(r).includes(secrets[0]!) && !JSON.stringify(pub).includes(secrets[0]!) && rows.every((p) => !JSON.stringify(r).includes(p.sig!) && !JSON.stringify(pub).includes(p.sig!)) && !("shielded" in pub) && !JSON.stringify(pub).includes("optedIn"), detail: `${secrets.length} secrets looked for` },
  ];
}

interface MemoJson {
  epochId: string | null;
  matches: boolean;
  coins: { mint: string; symbol: string }[];
  checks: { memo: boolean; txid: boolean | null; commitment: boolean | null };
  round: { at: string; status: string; shielded: { count: number; totalZats: string }; zcashTxids: string[]; snapshot: { sha256: string; memoSig: string | null; url: string } | null } | null;
  rows?: { mint: string; shareZats: string; commitment: string }[];
}

/** The memo as the holder's own Zcash wallet shows it on the note it received in the first round. */
function memoSeenByHolder(run: TraderRun): { memo: string; txid: string } {
  const holder = run.optinBuyers[0]!;
  const row = db.getPayouts(run.rounds.first.id).find((p) => p.wallet === holder.keypair.publicKey.toBase58() && payoutRail(p) === "shielded")!;
  syncWallet(holder.walletDir);
  enhanceWallet(holder.walletDir); // a light wallet reads a memo from the full transaction
  const memo = receivedMemos(holder.walletDir, row.sig!).find((m) => m.startsWith("SNARKS pad reward"));
  if (!memo) throw new Error("the holder's wallet shows no receipt memo on its note");
  return { memo, txid: row.sig! };
}

async function memoChecks(run: TraderRun): Promise<TraderCheck[]> {
  const { first, vault } = run.rounds;
  const { memo, txid } = memoSeenByHolder(run);
  const ask = async (body: unknown) => (await postJson<MemoJson>(run, "/rewards/verify-memo", body)).body;
  const [real, wrongTxid, noBatch, foreign] = [await ask({ memo, txid }), await ask({ memo, txid: "0".repeat(64) }), await ask({ memo: rewardMemo(vault.id) }), await ask({ memo: "hello" })];
  const snap = db.getEpochSnapshot(first.id)!;
  return [
    { label: "api v2.6 verify-memo: the memo a holder's own wallet shows on a real shielded note, with the transaction id it shows, is matched to its round: the round's coins, its transactions and its snapshot hash", pass: real.epochId === first.id && real.matches && real.checks.memo && real.checks.txid === true && real.checks.commitment === null && real.round?.zcashTxids.includes(txid) === true && real.round.snapshot?.sha256 === snap.sha256 && real.rows === undefined && JSON.stringify(real.coins.map((c) => c.mint).sort()) === JSON.stringify((JSON.parse(first.coinMints) as string[]).sort()), detail: `${memo} -> epoch ${real.epochId?.slice(-5)} matches=${real.matches} checks=${JSON.stringify(real.checks)}` },
    { label: "api v2.6 verify-memo: the same memo with a transaction id that is not in the round's batch does not match (checks.txid false, checks.memo still true)", pass: wrongTxid.epochId === first.id && !wrongTxid.matches && wrongTxid.checks.memo && wrongTxid.checks.txid === false, detail: JSON.stringify(wrongTxid.checks) },
    { label: "api v2.6 verify-memo: a round that paid no shielded batch (the Squads-vault round) is named but its memo fails: the pad never wrote it; text that is not the pad's names no round", pass: noBatch.epochId === vault.id && !noBatch.matches && !noBatch.checks.memo && foreign.epochId === null && !foreign.matches, detail: `no batch: ${JSON.stringify(noBatch.checks)}; foreign: epochId=${foreign.epochId}` },
  ];
}

/** A signed proof of wallet ownership, the receipt's scheme: the nonce comes from the API and is spent by the first use. */
async function proofFor(run: TraderRun, owner: Keypair, signer: Keypair, epochId: string): Promise<{ wallet: string; nonce: string; signature: string }> {
  const wallet = owner.publicKey.toBase58();
  const { body } = await getJson<{ nonce: string }>(run, `/optin/nonce?wallet=${wallet}`);
  const message = new TextEncoder().encode(epochReceiptMessage(wallet, epochId, body.nonce));
  return { wallet, nonce: body.nonce, signature: bs58.encode(nacl.sign.detached(message, signer.secretKey)) };
}

async function memoProofChecks(run: TraderRun): Promise<TraderCheck[]> {
  const { first } = run.rounds;
  const holder = run.optinBuyers[0]!.keypair;
  const memo = rewardMemo(first.id);
  const good = await proofFor(run, holder, holder, first.id);
  const opened = await postJson<MemoJson>(run, "/rewards/verify-memo", { memo, ...good });
  const replayed = await postJson<{ error: string }>(run, "/rewards/verify-memo", { memo, ...good });
  const forged = await postJson<{ error: string }>(run, "/rewards/verify-memo", { memo, ...(await proofFor(run, holder, run.whale, first.id)) });
  const own = db.listEpochCoinShares(first.id).filter((s) => s.wallet === holder.publicKey.toBase58());
  const file = db.getEpochSnapshot(first.id)!.json;
  const rows = opened.body.rows ?? [];
  return [
    { label: "api v2.6 verify-memo: with a signed proof the wallet gets its own rows of the round (coin, share, commitment), every commitment is in the published file, and the answer says the wallet's commitment is there", pass: opened.status === 200 && opened.body.matches && opened.body.checks.commitment === true && rows.length === own.length && rows.length > 0 && sharesText(rows.map((r) => ({ mint: r.mint, amount: r.shareZats }))) === sharesText(own.map((s) => ({ mint: s.mint, amount: s.amountZats }))) && rows.every((r) => file.includes(r.commitment)), detail: `${rows.length} row(s), checks=${JSON.stringify(opened.body.checks)}` },
    { label: "api v2.6 verify-memo: a nonce works once (400 stale_nonce on the replay) and a proof signed by another key is 400 invalid_signature", pass: replayed.status === 400 && replayed.body.error === "stale_nonce" && forged.status === 400 && forged.body.error === "invalid_signature", detail: `replay=${replayed.status} ${replayed.body.error}; forged=${forged.status} ${forged.body.error}` },
  ];
}

// ---- epochs: the new fields and the CSV ----

interface EpochJson {
  id: string;
  at: string;
  coinMints: string[];
  harvestedZats: string;
  solanaPayouts: { count: number; totalZats: string };
  shielded: { count: number; totalZats: string };
  feeZats: string;
  deliveryCostZats: string | null;
  teamNetZats: string | null;
  status: string;
  split: { holdersZats: string; teamZats: string; deliveryCostZats: string | null; teamNetZats: string | null; holderShortfallZats: string };
  snapshot: { sha256: string; memoSig: string | null } | null;
}

const CSV_HEADER = "epochId,at,status,coinMints,claimedZats,holdersZats,teamZats,deliveryCostZats,teamNetZats,holderShortfallZats,zcashNetworkFeeZats,solanaPayoutCount,solanaPayoutZats,shieldedCount,shieldedZats,snapshotSha256,snapshotMemoSig";

/** The cells a round's CSV row must hold, in the contract's column order, from what GET /epochs says. */
const csvRowOf = (e: EpochJson): string[] => [
  e.id, e.at, e.status, e.coinMints.join(";"), e.harvestedZats, e.split.holdersZats, e.split.teamZats, e.split.deliveryCostZats ?? "", e.split.teamNetZats ?? "", e.split.holderShortfallZats,
  e.feeZats, String(e.solanaPayouts.count), e.solanaPayouts.totalZats, String(e.shielded.count), e.shielded.totalZats, e.snapshot?.sha256 ?? "", e.snapshot?.memoSig ?? "",
];

async function epochFieldChecks(run: TraderRun, epochs: EpochJson[]): Promise<TraderCheck[]> {
  const first = epochs.find((e) => e.id === run.rounds.first.id)!;
  const ledger = db.getEpoch(first.id)!;
  const net = BigInt(ledger.teamGrossZats!) - BigInt(ledger.deliveryCostZats!);
  return [{
    label: "api v2.6 epochs: every round carries deliveryCostZats and teamNetZats at its top level, the same as split's; the first round's are the ledger's (delivery cost, and the team's gross share less it)",
    pass: epochs.every((e) => e.deliveryCostZats === e.split.deliveryCostZats && e.teamNetZats === e.split.teamNetZats) && first.deliveryCostZats === ledger.deliveryCostZats && first.teamNetZats === net.toString() && net >= 0n,
    detail: `cost=${first.deliveryCostZats} net=${first.teamNetZats} ledger gross=${ledger.teamGrossZats}`,
  }];
}

async function csvChecks(run: TraderRun): Promise<TraderCheck[]> {
  const epochs = (await getJson<{ epochs: EpochJson[] }>(run, "/epochs")).body.epochs;
  const res = await fetch(`${run.apiBase}/epochs.csv`);
  const text = await res.text();
  const [header, ...lines] = text.trimEnd().split("\n");
  const cells = lines.map((l) => l.split(","));
  const shieldedAmounts = db.listEpochs().flatMap((e) => db.getPayouts(e.id)).filter((p) => payoutRail(p) === "shielded").map((p) => p.amountZats);
  const privateValues = [...run.known, ...db.listActiveOptins().map((o) => o.zcashAddress), ...shieldedAmounts];
  const leaked = cells.flat().filter((c) => privateValues.includes(c)).length;
  return [
    ...(await epochFieldChecks(run, epochs)),
    { label: "api v2.6 epochs.csv: served as an attachment named snarks-epochs.csv; the header is the contract's columns in order, one row per published round, newest first", pass: res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/csv") && (res.headers.get("content-disposition") ?? "").includes('filename="snarks-epochs.csv"') && header === CSV_HEADER && cells.length === epochs.length && cells.every((c, i) => c[0] === epochs[i]!.id), detail: `${res.status} ${res.headers.get("content-type")}, ${cells.length} rows for ${epochs.length} rounds` },
    { label: "api v2.6 epochs.csv: every cell equals what GET /epochs says for that round (claimed, holders, team, delivery cost, team net, shortfall, Zcash fee, both rails' counts and totals, snapshot hash and memo signature)", pass: !text.includes('"') && epochs.every((e, i) => JSON.stringify(cells[i]) === JSON.stringify(csvRowOf(e))) && epochs.every((e) => e.harvestedZats === db.getEpoch(e.id)!.harvestedZats && (e.snapshot?.sha256 ?? "") === (db.getEpochSnapshot(e.id)?.sha256 ?? "")), detail: `${cells.length} rows` },
    { label: "api v2.6 epochs.csv: public numbers only: no wallet, no Zcash address and no single holder's shielded amount in any cell", pass: leaked === 0, detail: `${privateValues.length} private values looked for in ${cells.flat().length} cells, ${leaked} cell(s) equal one` },
  ];
}

/** Runs every v2.6 route against the live API of the e2e run; each group is guarded, so one broken group does not hide the others. */
export async function traderApiChecks(run: TraderRun): Promise<TraderCheck[]> {
  const placed = await placeTrades(run);
  return [
    ...(await guarded("quote", () => quoteChecks(run))),
    ...(await guarded("pot", () => potChecks(run, placed))),
    ...(await guarded("fixed", () => fixedChecks(run))),
    ...(await guarded("holders", () => holdersChecks(run))),
    ...(await guarded("trades", () => tapeChecks(run, placed))),
    ...(await guarded("stream", () => streamChecks(run))),
    ...(await guarded("rewards", async () => [await solanaRewardsCheck(run), ...(await shieldedRewardsChecks(run))])),
    ...(await guarded("verify-memo", async () => [...(await memoChecks(run)), ...(await memoProofChecks(run))])),
    ...(await guarded("epochs", () => csvChecks(run))),
  ];
}
