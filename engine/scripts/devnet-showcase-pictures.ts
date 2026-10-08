#!/usr/bin/env bun
// D-4 on devnet: two showcase coins WITH a picture and links, launched THROUGH THE DEPLOYED PAD'S OWN API the way a creator's browser does
// (POST /uploads, POST /coins/launch-tx, the creator's signature, POST /coins/confirm), to take the board's two tier slots from TIER2 and TIER6 of D-3: those were launched
// by a script before the picture feature existed and have no picture. "Green Snark" $GREENS on the 2% tier and "Blue Snark" $BLUES on the 6% tier, each with a small first buy
// inside the launch transaction so the board shows a price. The pictures are design/showcase-coins/*.png (scripts/make-showcase-pictures.ts).
//   SOLANA_DEVNET_RPC=https://api.devnet.solana.com scripts/devnet.sh bun scripts/devnet-showcase-pictures.ts [--api https://snarks.fun/api]
// From the Mac this reads the chain through the Mac's own endpoint, never the server's (ops/DEPLOY.md section 12): the line above is the public one, for when the Mac's own
// key has run out of credits. The creators are the D-3 test wallets (data/devnet-wallets.json, 0600, gitignored, test-only keys); a wallet short of SOL or stand-in ZEC is filled
// from the faucet key (data/keys/faucet-devnet.json). Prints the mints for PAD_FEATURED_MINTS, $SNARKS first (read from the board); writes
// probe/fee-scheduler/results/d4-showcase-pictures-<ts>.json. Devnet only.
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import bs58 from "bs58";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { getConnection } from "../src/solana";
import { call, launch, must, topUp, type Launched } from "./lib/devnet-live";

const arg = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const API = (arg("--api") ?? "https://snarks.fun/api").replace(/\/$/, "");
const SITE = API.replace(/\/api$/, ""); // where the pad's own /i and /m files are served (PUBLIC_BASE_URL)
const PICTURES = join(config.paths.repoRoot, "design", "showcase-coins");
const RESULTS = join(config.paths.repoRoot, "probe", "fee-scheduler", "results");
const FIRST_BUY = 10_000_000n; // 0.1 stand-in ZEC: a price on the board, a few percent of the curve
const LINKS = { website: "https://snarks.fun", x: "@SnarksPad" }; // no Telegram; the pad stores the X handle as https://x.com/SnarksPad

interface Wallets { defaults: string[] }
const wallets = JSON.parse(readFileSync(join(config.paths.dataDir, "devnet-wallets.json"), "utf8")) as Wallets;
const [creatorA, creatorB] = wallets.defaults.map((secret) => Keypair.fromSecretKey(bs58.decode(secret))) as [Keypair, Keypair];
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const COINS = [
  { name: "Green Snark", symbol: "GREENS", tier: 200, picture: "green-snark.png", creator: creatorA },
  { name: "Blue Snark", symbol: "BLUES", tier: 600, picture: "blue-snark.png", creator: creatorB },
];

/** The picture, stored by the pad (POST /uploads) the way the Launch page does it: the pad answers where its own clean copy is. */
async function upload(file: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([readFileSync(join(PICTURES, file))], file, { type: "image/png" }));
  const res = await fetch(`${API}/uploads`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`POST /uploads answered ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}

/** What a wallet or an explorer finds for the coin: the pad's record, the picture file, the metadata JSON and the token's own metadata address on the chain. */
async function readBack(mint: string, c: (typeof COINS)[number], imageUrl: string): Promise<string[]> {
  const coin = await must(API, "GET", `/coins/${mint}`);
  const picture = await fetch(imageUrl);
  const json = (await (await fetch(`${SITE}/m/${mint}.json`)).json()) as Record<string, any>;
  const onChain = await getTokenMetadata(getConnection(), new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  const problems = [
    [coin.imageUrl === imageUrl, "the coin's imageUrl is the uploaded picture"],
    [coin.feeBps === c.tier && coin.stage === "curve", "the coin sits on its tier, on the curve"],
    [coin.socials?.website === "https://snarks.fun/" && coin.socials?.x === "https://x.com/SnarksPad" && !coin.socials?.telegram, "the coin carries the website and X links and no Telegram"],
    [picture.status === 200 && picture.headers.get("content-type") === "image/png" && (await picture.arrayBuffer()).byteLength > 10_000, "the picture file answers 200 as a PNG"],
    [json.name === c.name && json.symbol === c.symbol && json.image === imageUrl && json.extensions?.website === "https://snarks.fun/" && json.extensions?.twitter === "https://x.com/SnarksPad", "the metadata JSON names the coin, the picture and the links"],
    [onChain?.uri === `${SITE}/m/${mint}.json` && onChain.name === c.name && onChain.symbol === c.symbol, "the token's on-chain metadata points at that JSON"],
  ] as const;
  return problems.filter(([ok]) => !ok).map(([, what]) => what);
}

async function showcaseCoin(c: (typeof COINS)[number]): Promise<Launched & { symbol: string; tier: number; imageUrl: string }> {
  await topUp(c.creator.publicKey, 0.05, 2n * FIRST_BUY);
  const imageUrl = await upload(c.picture);
  log(`${c.symbol}: picture stored by the pad at ${imageUrl}`);
  const description = `A devnet test coin of the pad, on the ${c.tier / 100}% tier.`;
  const l = await launch(API, c.creator, { name: c.name, symbol: c.symbol, description, imageUrl, feeTier: c.tier, firstBuyZats: FIRST_BUY, socials: LINKS });
  log(`LAUNCH ${c.symbol} tier ${c.tier} bps mint ${l.mint} pool ${l.poolId} launch tx ${l.sig} creator ${c.creator.publicKey.toBase58()}`);
  const missing = await readBack(l.mint, c, imageUrl);
  if (missing.length > 0) throw new Error(`${c.symbol} (${l.mint}) is launched but not as it should be: ${missing.join("; ")}`);
  log(`${c.symbol}: the record, the picture, the metadata JSON and the on-chain address all agree`);
  return { symbol: c.symbol, tier: c.tier, imageUrl, ...l };
}

async function main(): Promise<void> {
  log("pad API", API, "cluster", config.mode);
  const tiers = await must(API, "GET", "/tiers");
  for (const c of COINS) if (!(tiers.tiers as Record<string, any>[]).find((t) => t.feeBps === c.tier)?.available) throw new Error(`the pad does not offer the ${c.tier} bps tier`);
  const snarks = ((await must(API, "GET", "/coins")).coins as Record<string, any>[]).find((x) => x.symbol === "SNARKS");
  if (!snarks) throw new Error("the board lists no $SNARKS: PAD_FEATURED_MINTS cannot be composed from it");
  const launched = [];
  for (const c of COINS) launched.push(await showcaseCoin(c));
  const featured = [snarks.mint as string, ...launched.map((l) => l.mint)].join(",");
  log("PAD_FEATURED_MINTS for the pad:", featured);
  const board = await call(API, "GET", "/coins?all=1");
  log("the pad lists", (board.body.coins as unknown[]).length, "coins with ?all=1");
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `d4-showcase-pictures-${Date.now()}.json`), JSON.stringify({ probe: "D-4 showcase pictures", cluster: config.mode, api: API, at: new Date().toISOString(), featured, links: LINKS, firstBuyZats: FIRST_BUY.toString(), coins: launched }, null, 2));
}

await main();
