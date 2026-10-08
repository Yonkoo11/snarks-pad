// A coin launched with a picture from a device, end to end against the real local validator running the MAINNET Meteora DBC binary (skipped when it is
// not reachable): upload, launch-tx through the API, the creator signs and sends, confirm. Then the three things this feature exists for are read back:
// the coin's on-chain token metadata names the metadata JSON (not the picture), that JSON names the uploaded picture and the links, and the coin the API
// returns carries the links. The name and description carry quotes and Unicode all the way through.
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { handleRequest } from "../src/api";
import { uploadLimiter } from "../src/api/uploadRoutes";
import { config } from "../src/config";
import * as db from "../src/db";
import { ensureDbcConfig } from "../src/dbc/setup";
import { buildLaunchTx } from "../src/dbc/launch";
import { fundTestWallet } from "../src/faucet";
import { loadKeeperKeypair } from "../src/keeper";
import { metadataDir, metadataUrl, uploadUrl } from "../src/publicFiles/paths";
import { getConnection } from "../src/solana";
import { cosignedLaunch } from "./helpers/launch-cosign";
import { validatorUp } from "./helpers/validator-up";

const B = "http://pad.test/api";
const IP = { ip: "192.0.2.77" };
const NAME = 'The "Pizza" \\ coin \u{1f355} é中文';
const DESCRIPTION = 'line one\nline two, "quoted", </script>, é中文 \u{1f9ea}';
const LINKS = { website: "https://example.com/coin", x: "@snarkspad", telegram: "t.me/snarkspad" };

async function upload(): Promise<{ url: string }> {
  uploadLimiter.clear();
  const png = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#c42f6c" } }).png().toBuffer();
  const form = new FormData();
  form.append("file", new File([png], "my coin.png", { type: "image/png" }));
  const res = await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: form }), IP);
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string };
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleRequest(new Request(`${B}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), IP);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The creator signs, the engine co-signs (contract v2.9.1), then the transaction is sent and confirmed. */
async function signAndSend(txBase64: string, mint: string, signer: Keypair): Promise<string> {
  const conn = getConnection();
  const tx = await cosignedLaunch(txBase64, mint, signer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function newCreator(): Promise<Keypair> {
  await ensureDbcConfig();
  const creator = Keypair.generate();
  await fundTestWallet(creator.publicKey, 2, loadKeeperKeypair());
  return creator;
}

const metadataJson = (mint: string) => JSON.parse(readFileSync(join(metadataDir(), `${mint}.json`), "utf8")) as Record<string, unknown>;

describe.if(await validatorUp())("launch with a picture from a device (live validator)", () => {
  test("the on-chain uri is the metadata JSON, which names the uploaded picture and the links; the API returns the links", async () => {
    const creator = await newCreator();
    const { url: imageUrl } = await upload();
    const made = await api("POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: NAME, symbol: "PIZZA", description: DESCRIPTION, imageUrl, socials: LINKS });
    expect(made.status).toBe(200);
    const mint = made.body.mint as string;

    // before anything is signed the file a wallet will read is already there
    expect(existsSync(join(metadataDir(), `${mint}.json`))).toBe(true);

    const sig = await signAndSend(made.body.tx as string, mint, creator);
    const confirmed = await api("POST", "/coins/confirm", { sig, mint });
    expect(confirmed.status).toBe(200);

    // 1. the chain: the token's metadata uri is the address of the JSON, never of the picture
    const onChain = await getTokenMetadata(getConnection(), new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(onChain?.uri).toBe(metadataUrl(mint));
    expect(onChain?.uri).not.toBe(imageUrl);
    expect(onChain?.uri.length).toBeLessThanOrEqual(200);
    expect([onChain?.name, onChain?.symbol]).toEqual([NAME, "PIZZA"]);

    // 2. the JSON: the picture, the links, the exact text typed
    const json = metadataJson(mint);
    expect(json.image).toBe(imageUrl);
    expect(json.name).toBe(NAME);
    expect(json.description).toBe(DESCRIPTION);
    expect(json.extensions).toEqual({ website: "https://example.com/coin", twitter: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad" });
    expect(json.external_url).toBe("https://example.com/coin");
    expect(json.createdOn).toBe(config.publicFiles.baseUrl);
    expect(json.properties).toEqual({ files: [{ uri: imageUrl, type: "image/png" }], category: "image" });
    expect(existsSync(join(config.publicFiles.dir, "i", imageUrl.split("/").pop()!))).toBe(true);

    // 2b. the addresses a wallet fetches answer: the uri with that JSON, the picture as an image (the engine serves what Caddy serves on a server)
    const fetched = await handleRequest(new Request(`http://pad.test${new URL(onChain!.uri).pathname}`), IP);
    expect([fetched.status, fetched.headers.get("content-type")]).toEqual([200, "application/json"]);
    expect(await fetched.json()).toEqual(json);
    const picture = await handleRequest(new Request(`http://pad.test${new URL(json.image as string).pathname}`), IP);
    expect([picture.status, picture.headers.get("content-type"), picture.headers.get("cache-control")]).toEqual([200, "image/png", "public, max-age=31536000, immutable"]);

    // 3. the API: the links, canonical, on the coin's own route and in the list
    const coin = await api("GET", `/coins/${mint}`);
    expect(coin.body.socials).toEqual({ website: "https://example.com/coin", x: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad" });
    expect(coin.body.imageUrl).toBe(imageUrl);
    const list = await api("GET", "/coins?all=1&limit=100");
    const listed = (list.body.coins as { mint: string; socials: unknown }[]).find((c) => c.mint === mint);
    expect(listed?.socials).toEqual(coin.body.socials);
    expect(db.getCoin(mint)?.socials).toBe(JSON.stringify({ website: "https://example.com/coin", x: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad" }));
  });

  test("a coin launched without a picture or links shows the placeholder and carries empty links", async () => {
    const creator = await newCreator();
    const made = await api("POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: "Bare", symbol: "BARE", description: "" });
    expect(made.status).toBe(200);
    const mint = made.body.mint as string;
    await api("POST", "/coins/confirm", { sig: await signAndSend(made.body.tx as string, mint, creator), mint });
    const json = metadataJson(mint);
    expect(json.image).toBe(uploadUrl("placeholder.png"));
    expect(json.extensions).toEqual({});
    expect("external_url" in json).toBe(false);
    expect(existsSync(join(config.publicFiles.dir, "i", "placeholder.png"))).toBe(true);
    const coin = await api("GET", `/coins/${mint}`);
    expect([coin.body.imageUrl, coin.body.socials]).toEqual(["", {}]);
    const onChain = await getTokenMetadata(getConnection(), new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(onChain?.uri).toBe(metadataUrl(mint));
  });

  test("a launch that cannot be built leaves no metadata file behind", async () => {
    await ensureDbcConfig();
    const before = readdirSync(metadataDir()).length;
    await expect(buildLaunchTx({ creator: "not a wallet", name: "Nope", symbol: "NOPE", description: "", imageUrl: "" })).rejects.toThrow();
    expect(readdirSync(metadataDir()).length).toBe(before);
  });

  test("a coin launched before links existed answers with empty links, not an error", async () => {
    const creator = await newCreator();
    const made = await api("POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: "Old", symbol: "OLD", description: "" });
    const mint = made.body.mint as string;
    await api("POST", "/coins/confirm", { sig: await signAndSend(made.body.tx as string, mint, creator), mint });
    db.getDb().query("UPDATE coins SET socials = NULL WHERE mint = $m").run({ $m: mint }); // what a row from before the column looks like
    expect((await api("GET", `/coins/${mint}`)).body.socials).toEqual({});
  });
});
