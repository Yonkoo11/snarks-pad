#!/usr/bin/env bun
// S4 F2, F3 and F4 against an API process over the local validator (ST-MD-01..04, ST-CW-02..05, ST-LW-05/06, audit/STRESS-TEST-PLAN-S4.md).
// Every launch goes through the API over HTTP as a browser's would; the creator keys live here and the keeper funds them; what the chain
// recorded is read back directly (token metadata, pool creator, fee counters, balances).
//   PAD_MODE=local bun stress/s4/live-launch.ts <api base> <seed.json>
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getTokenMetadata } from "@solana/spl-token";
import { config } from "../../src/config";
import { waitForWindowToClose } from "../../src/dbc/windowWait";
import { fundTestWallet } from "../../src/faucet";
import { loadKeeperKeypair } from "../../src/keeper";
import { getConnection, getDbcClient } from "../../src/solana";

const base = process.argv[2]!;
const seed = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as { configId100: string; configId400: string; mints: string[] };
const keeper = loadKeeperKeypair();
const conn = getConnection();
const out: Record<string, unknown>[] = [];
const say = (id: string, pass: boolean, detail: Record<string, unknown>): void => {
  out.push({ id, pass, ...detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} ${JSON.stringify(detail)}`);
};
const note = (id: string, detail: Record<string, unknown>): void => {
  out.push({ id, pass: null, ...detail });
  console.log(`[NOTE] ${id} ${JSON.stringify(detail)}`);
};

type Answer = { status: number; body: Record<string, any> };
async function api(method: string, path: string, body?: unknown, rawBody?: string): Promise<Answer> {
  const res = await fetch(`${base}${path}`, { method, headers: body === undefined && rawBody === undefined ? undefined : { "content-type": "application/json" }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
async function send(txBase64: string, signer: Keypair): Promise<{ sig: string; error: string | null }> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const c = await conn.confirmTransaction(sig, "confirmed");
    return { sig, error: c.value.err ? JSON.stringify(c.value.err) : null };
  } catch (err) {
    return { sig: "", error: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}
async function funded(): Promise<Keypair> {
  const k = Keypair.generate();
  await fundTestWallet(k.publicKey, 2, keeper);
  return k;
}
const zecOf = async (owner: PublicKey): Promise<bigint> => {
  try {
    return (await getAccount(conn, getAssociatedTokenAddressSync(config.solana.dbc.quoteMint, owner, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    return 0n;
  }
};
const chainCreator = async (poolId: string): Promise<string> => (await getDbcClient().state.getPool(poolId))!.poolState.creator.toBase58();
const launchBody = (creator: Keypair, over: Record<string, unknown>) => ({ creator: creator.publicKey.toBase58(), name: "S4", symbol: "SFOUR", description: "", imageUrl: "", feeTier: 100, ...over });
/** launch-tx, sign, send, confirm. */
async function launch(creator: Keypair, over: Record<string, unknown>): Promise<{ status: number; error: string | null; mint: string | null; poolId: string | null; sendError: string | null; body: Record<string, any> }> {
  const made = await api("POST", "/coins/launch-tx", launchBody(creator, over));
  if (made.status !== 200) return { status: made.status, error: made.body.error ?? null, mint: null, poolId: null, sendError: null, body: made.body };
  const sent = await send(made.body.tx, creator);
  if (sent.error) return { status: 200, error: null, mint: made.body.mint, poolId: null, sendError: sent.error, body: made.body };
  const confirmed = await api("POST", "/coins/confirm", { sig: sent.sig, mint: made.body.mint });
  return { status: 200, error: null, mint: made.body.mint, poolId: confirmed.body.poolId ?? null, sendError: confirmed.status === 200 ? null : `confirm ${confirmed.status} ${confirmed.body.error}`, body: made.body };
}
const metadataOf = async (mint: string): Promise<Record<string, unknown> | null> => (await fetch(`${new URL(base).origin}/m/${mint}.json`)).json().catch(() => null) as Promise<Record<string, unknown> | null>;

// ---- ST-MD-01: hostile text all the way to the chain ----
{
  const creator = await funded();
  const name = 'A "q" \\ b';
  const description = `line one\nline two, "quoted", </script>, \u{1f9ea}   é 中文 ${"x".repeat(200)}`.slice(0, 280);
  const r = await launch(creator, { name, symbol: "MDA", description });
  const file = r.mint ? await metadataOf(r.mint) : null;
  const meta = r.mint && r.poolId ? await getTokenMetadata(conn, new PublicKey(r.mint), "confirmed", TOKEN_2022_PROGRAM_ID) : null;
  say("ST-MD-01a quotes, a backslash, newlines, markup, emoji, U+2028 and combining marks reach the metadata file and the chain unchanged", r.status === 200 && r.sendError === null && file?.name === name && file?.description === description && meta?.name === name && meta?.symbol === "MDA" && meta?.uri === `${new URL(base).origin}/m/${r.mint}.json`, { status: r.status, sendError: r.sendError, fileName: file?.name, chainName: meta?.name, chainUri: meta?.uri });
}
{
  const creator = await funded();
  const name = "中".repeat(32); // 32 characters, 96 bytes of UTF-8
  const r = await launch(creator, { name, symbol: "CJK" });
  const meta = r.mint && r.poolId ? await getTokenMetadata(conn, new PublicKey(r.mint), "confirmed", TOKEN_2022_PROGRAM_ID) : null;
  if (r.status !== 200) note("ST-MD-01b a 32-character name of 96 bytes is refused by the API before anything is signed", { status: r.status, error: r.error });
  else say("ST-MD-01b a 32-character name of 96 bytes: the API accepted it, so the chain must accept it too (a refusal after signing is the defect)", r.sendError === null && meta?.name === name, { status: r.status, sendError: r.sendError, chainName: meta?.name?.length });
}

// ---- ST-MD-02: length caps ----
{
  const creator = await funded();
  const cases: [string, Record<string, unknown>, number, string | null][] = [
    ["name 32", { name: "n".repeat(32) }, 200, null],
    ["name 33", { name: "n".repeat(33) }, 400, "name"],
    ["description 280", { description: "d".repeat(280) }, 200, null],
    ["description 281", { description: "d".repeat(281) }, 400, "description"],
    ["description 10,000", { description: "d".repeat(10_000) }, 400, "description"],
    ["name 10,000", { name: "n".repeat(10_000) }, 400, "name"],
    ["NUL in name", { name: "a\u0000b" }, 400, "name"],
    ["NUL in description", { description: "a\u0000b\u001b[31m" }, 200, null],
    ["symbol 11", { symbol: "A".repeat(11) }, 400, "symbol"],
  ];
  const results: [string, number, unknown, unknown][] = [];
  let pass = true;
  let nulMint: string | null = null;
  for (const [label, over, status, field] of cases) {
    const r = await api("POST", "/coins/launch-tx", launchBody(creator, { symbol: `L${results.length}`, ...over }));
    results.push([label, r.status, r.body.error ?? null, r.body.field ?? null]);
    if (r.status !== status || (field && r.body.field !== field)) pass = false;
    if (label === "NUL in description" && r.status === 200) nulMint = r.body.mint;
  }
  const nulFile = nulMint ? await metadataOf(nulMint) : null;
  say("ST-MD-02 the caps are 32 / 280 / 10 to the character and name the field; a control character is refused in a name and kept (escaped) in a description whose JSON stays valid", pass && nulFile?.description === "a\u0000b\u001b[31m", { results, nulDescriptionRoundTrips: nulFile?.description === "a\u0000b\u001b[31m" });
}

// ---- ST-MD-03: a lone surrogate ----
{
  const creator = await funded();
  const raw = `{"creator":"${creator.publicKey.toBase58()}","name":"Snark\\ud800","symbol":"LONE","description":"","imageUrl":"","feeTier":100}`;
  const made = await api("POST", "/coins/launch-tx", undefined, raw);
  let sent: { sig: string; error: string | null } | null = null;
  let meta: Awaited<ReturnType<typeof getTokenMetadata>> | null = null;
  let file: Record<string, unknown> | null = null;
  if (made.status === 200) {
    sent = await send(made.body.tx, creator);
    if (!sent.error) {
      await api("POST", "/coins/confirm", { sig: sent.sig, mint: made.body.mint });
      meta = await getTokenMetadata(conn, new PublicKey(made.body.mint), "confirmed", TOKEN_2022_PROGRAM_ID);
      file = await metadataOf(made.body.mint);
    }
  }
  say("ST-MD-03 a lone surrogate in a name is never a 500: refused, or landed as well-formed UTF-8 on chain with a valid metadata file", made.status < 500 && (made.status !== 200 || (sent?.error === null && meta !== null && file !== null)), { status: made.status, error: made.body.error ?? null, sendError: sent?.error ?? null, chainName: meta?.name ? JSON.stringify(meta.name) : null, fileName: file ? JSON.stringify(file.name) : null });
}

// ---- ST-MD-04: socials lookalikes over HTTP ----
{
  const creator = await funded();
  const cases: [string, Record<string, unknown>, number, string | null][] = [
    ["x one-dot-leader host", { x: "https://x.com․evil.example/a" }, 400, "socials.x"],
    ["x encoded dot", { x: "https://x.com%2eevil.example/a" }, 400, "socials.x"],
    ["x trailing dot host", { x: "https://x.com./a" }, 400, "socials.x"],
    ["x userinfo", { x: "https://x.com@evil.example/a" }, 400, "socials.x"],
    ["website is x.com", { website: "https://x.com/a" }, 400, "socials.website"],
    ["website path with @x.com", { website: "https://evil.example/@x.com" }, 200, null],
    ["telegram invite with +", { telegram: "t.me/+invite" }, 400, "socials.telegram"],
    ["telegram 4 chars", { telegram: "@abcd" }, 400, "socials.telegram"],
    ["1,000 unknown keys", Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`k${i}`, "x"])), 400, "socials"],
    ["x as a number", { x: 12345 }, 400, "socials.x"],
  ];
  const results: [string, number, unknown, unknown][] = [];
  let pass = true;
  for (const [label, socials, status, field] of cases) {
    const r = await api("POST", "/coins/launch-tx", launchBody(creator, { symbol: `S${results.length}`, socials }));
    results.push([label, r.status, r.body.error ?? null, r.body.field ?? null]);
    if (r.status !== status || (field && r.body.field !== field)) pass = false;
  }
  const norm = await launch(creator, { symbol: "NORM", socials: { x: "https://X.COM:443/a?b=javascript:alert(1)", telegram: "https://T.ME/snarkspad/123", website: "EXAMPLE.com/path?q=1" } });
  const coin = norm.mint ? await api("GET", `/coins/${norm.mint}`) : null;
  say("ST-MD-04 lookalike and malformed links are refused naming the field; upper case, :443 and a query normalise to the canonical https address", pass && coin?.body.socials?.x === "https://x.com/a" && coin?.body.socials?.telegram === "https://t.me/snarkspad" && coin?.body.socials?.website === "https://example.com/path?q=1", { results, normalised: coin?.body.socials });
}

// ---- ST-CW-02: the 1% tier handover ----
{
  const launcher = await funded();
  const receiver = Keypair.generate();
  const r = await launch(launcher, { symbol: "CWONE", initialBuyZec: "50000000", creatorWallet: receiver.publicKey.toBase58() });
  const creatorNow = r.poolId ? await chainCreator(r.poolId) : null;
  const fees = r.mint ? await api("GET", `/coins/${r.mint}/creator-fees`) : null;
  const claimReceiver = r.mint ? await api("POST", `/coins/${r.mint}/creator-claim-tx`, { wallet: receiver.publicKey.toBase58() }) : null;
  const claimLauncher = r.mint ? await api("POST", `/coins/${r.mint}/creator-claim-tx`, { wallet: launcher.publicKey.toBase58() }) : null;
  say("ST-CW-02 1% tier: the pool is handed to the receiver, its creator share is 0, the receiver's claim is refused as no_creator_fee (nothing built for nothing), the launcher is not_creator", r.sendError === null && creatorNow === receiver.publicKey.toBase58() && fees?.body.creator === receiver.publicKey.toBase58() && fees?.body.creatorShareBps === 0 && claimReceiver?.status === 400 && claimReceiver.body.error === "no_creator_fee" && claimLauncher?.status === 403, { sendError: r.sendError, chainCreatorIsReceiver: creatorNow === receiver.publicKey.toBase58(), fees: fees?.body, receiverClaim: [claimReceiver?.status, claimReceiver?.body.error], launcherClaim: [claimLauncher?.status, claimLauncher?.body.error] });
}

// ---- ST-CW-03 / ST-CW-04: the 4% tier handover, a 0-SOL receiver's claim, the claim once funded ----
{
  const launcher = await funded();
  const buyer = await funded();
  const receiver = Keypair.generate();
  const stranger = Keypair.generate();
  const r = await launch(launcher, { symbol: "CWFOUR", feeTier: 400, initialBuyZec: "50000000", creatorWallet: receiver.publicKey.toBase58() });
  if (!r.poolId) say("ST-CW-03 4% tier handover launch", false, { status: r.status, error: r.error, sendError: r.sendError });
  else {
    await waitForWindowToClose(r.poolId);
    const buy = await api("POST", `/coins/${r.mint}/trade-tx`, { wallet: buyer.publicKey.toBase58(), side: "buy", amount: "250000000", slippageBps: 100 });
    const bought = await send(buy.body.tx, buyer);
    const fees = await api("GET", `/coins/${r.mint}/creator-fees`);
    const owed = BigInt(fees.body.curveZats ?? "0");
    const launcherClaim = await api("POST", `/coins/${r.mint}/creator-claim-tx`, { wallet: launcher.publicKey.toBase58() });
    const strangerClaim = await api("POST", `/coins/${r.mint}/creator-claim-tx`, { wallet: stranger.publicKey.toBase58() });
    const unfunded = await api("POST", `/coins/${r.mint}/creator-claim-tx`, { wallet: receiver.publicKey.toBase58(), kind: "curve" });
    const unfundedSend = unfunded.status === 200 ? await send(unfunded.body.tx, receiver) : null;
    say("ST-CW-03 4% tier: after a buy the creator share waits on the curve; the launcher and a stranger are 403 not_creator; the API builds the receiver's claim", bought.error === null && owed > 0n && fees.body.creator === receiver.publicKey.toBase58() && launcherClaim.status === 403 && strangerClaim.status === 403 && unfunded.status === 200, { buyError: bought.error, owedZats: owed.toString(), creatorShareBps: fees.body.creatorShareBps, launcher: [launcherClaim.status, launcherClaim.body.error], stranger: [strangerClaim.status, strangerClaim.body.error], receiverClaimBuilt: [unfunded.status, unfunded.body.claimableZats] });
    say("ST-CW-04 a receiver holding 0 SOL: the chain refuses the claim it signed (no lamports for the fee); once it holds 0.01 SOL the same claim lands and pays exactly what was owed", unfundedSend !== null && unfundedSend.error !== null && (await (async () => {
      await conn.confirmTransaction(await conn.requestAirdrop(receiver.publicKey, 10_000_000), "confirmed");
      const again = await api("POST", `/coins/${r.mint}/creator-claim-tx`, { wallet: receiver.publicKey.toBase58(), kind: "curve" });
      const before = await zecOf(receiver.publicKey);
      const sent = await send(again.body.tx, receiver);
      const delta = (await zecOf(receiver.publicKey)) - before;
      note("ST-CW-04 detail", { fundedClaim: [again.status, sent.error], receivedZats: delta.toString(), owedZats: owed.toString() });
      return sent.error === null && delta === owed;
    })()), { unfundedSendError: unfundedSend?.error?.slice(0, 160) });
  }
}

// ---- ST-CW-05: an on-curve address nobody can sign for ----
{
  const launcher = await funded();
  const results: [string, boolean, number, unknown][] = [];
  for (const [label, address] of [["the 1% config account", seed.configId100], ["the ZEC mint", config.solana.dbc.quoteMint.toBase58()]] as const) {
    const onCurve = PublicKey.isOnCurve(new PublicKey(address).toBytes());
    const r = await api("POST", "/coins/launch-tx", launchBody(launcher, { symbol: `CW${results.length}`, creatorWallet: address }));
    results.push([label, onCurve, r.status, r.body.error ?? null]);
  }
  note("ST-CW-05 an on-curve address the pad does not own passes the check even when nobody holds its key (a config account, the ZEC mint): the launcher's own responsibility, shown back in full with a tick on the form", { results });
}

// ---- ST-LW-05 / ST-LW-06: the quote during and after the window; trade-tx inside it ----
{
  const creator = await funded();
  const buyer = await funded();
  const made = await api("POST", "/coins/launch-tx", launchBody(creator, { symbol: "WINQ", initialBuyZec: "10000000" }));
  const sent = await send(made.body.tx, creator);
  const confirmed = await api("POST", "/coins/confirm", { sig: sent.sig, mint: made.body.mint });
  const mint = made.body.mint as string;
  const activation = Number((await getDbcClient().state.getPool(confirmed.body.poolId))!.poolState.activationPoint.toString());
  const samples: { t: number; feeBps: number | null; left: number; feeZec: string }[] = [];
  let tradeInWindow: Answer | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8_500) {
    const q = await api("GET", `/coins/${mint}/quote?side=buy&amount=100000000`);
    samples.push({ t: Number(((Date.now() - activation * 1000) / 1000).toFixed(2)), feeBps: q.body.feeBps ?? null, left: q.body.windowSecondsLeft ?? -1, feeZec: String(q.body.feeZec) });
    if (!tradeInWindow && Date.now() - t0 > 800) tradeInWindow = await api("POST", `/coins/${mint}/trade-tx`, { wallet: buyer.publicKey.toBase58(), side: "buy", amount: "100000000", slippageBps: 100 });
    await Bun.sleep(200);
  }
  const steps = new Set([9900, 7940, 5980, 4020, 2060, 100]);
  const fees = samples.map((s) => s.feeBps);
  const nonIncreasing = fees.every((f, i) => i === 0 || (f !== null && fees[i - 1] !== null && f <= fees[i - 1]!));
  const lefts = samples.map((s) => s.left);
  const leftNonIncreasing = lefts.every((l, i) => i === 0 || l <= lefts[i - 1]!);
  const last = samples.at(-1)!;
  const closedConsistent = samples.every((s) => (s.left === 0) === (s.feeBps === 100));
  say("ST-LW-05 the quote's feeBps walks down the steps and never up, windowSecondsLeft never up, and after the window it is 100 with 0 left; left is 0 exactly when the fee is the tier's", fees.every((f) => f !== null && steps.has(f)) && nonIncreasing && leftNonIncreasing && last.feeBps === 100 && last.left === 0 && closedConsistent, { samples: samples.length, first: samples[0], last, distinctFees: [...new Set(fees)] });
  const feeZec = BigInt(tradeInWindow?.body.quote?.feeZec ?? "0");
  const stepFees = [...steps].map((bps) => (100_000_000n * BigInt(bps) * 100_000n + 999_999_999n) / 1_000_000_000n);
  say("ST-LW-06 trade-tx inside the window still builds (nothing is refused) and its quote carries the step's fee on a 1 ZEC buy", tradeInWindow?.status === 200 && stepFees.includes(feeZec) && feeZec > 1_000_000n, { status: tradeInWindow?.status, feeZec: feeZec.toString(), stepFees: stepFees.map(String) });
  console.log(JSON.stringify({ windowMint: mint }));
}
console.log(JSON.stringify({ summary: { pass: out.filter((o) => o.pass === true).length, fail: out.filter((o) => o.pass === false).length, notes: out.filter((o) => o.pass === null).length } }));
