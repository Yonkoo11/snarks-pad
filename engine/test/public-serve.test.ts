// The engine's own copy of what Caddy serves (src/publicFiles/serve.ts): /i/<name> and /m/<mint>.json from PUBLIC_DIR, with the headers Caddy sends, and
// nothing else: no other path reaches the disk, whatever it holds.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import sharp from "sharp";
import { handleRequest } from "../src/api";
import { uploadLimiter } from "../src/api/uploadRoutes";
import { config } from "../src/config";
import { metadataDir } from "../src/publicFiles/paths";
import { writeMetadata } from "../src/publicFiles/metadata";
import { ensurePlaceholder } from "../src/publicFiles/store";

const get = (path: string, method = "GET") => handleRequest(new Request(`http://pad.test${path}`, { method }), { ip: "192.0.2.50" });
const made: string[] = [];
afterAll(() => {
  for (const f of made) rmSync(f, { force: true });
});

async function uploaded(): Promise<{ name: string; file: string }> {
  uploadLimiter.clear();
  const png = await sharp({ create: { width: 90, height: 60, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 47, b: 108 } } }).png().toBuffer();
  const form = new FormData();
  form.append("file", new File([png], "x.png", { type: "image/png" }));
  const res = await handleRequest(new Request("http://pad.test/api/uploads", { method: "POST", body: form }), { ip: "192.0.2.51" });
  const { url } = (await res.json()) as { url: string };
  const name = url.slice(url.lastIndexOf("/") + 1);
  const file = join(config.publicFiles.dir, "i", name);
  made.push(file);
  return { name, file };
}

describe("an uploaded image", () => {
  test("is served at /i/<name> with the stored bytes, the right type, a year's cache and nosniff", async () => {
    const { name, file } = await uploaded();
    const res = await get(`/i/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-pad-mode")).toBe(config.mode);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), readFileSync(file))).toBe(0);
  });

  test("HEAD answers the headers and the length, with no body", async () => {
    const { name, file } = await uploaded();
    const res = await get(`/i/${name}`, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(readFileSync(file).length));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("the placeholder is served the same way", async () => {
    ensurePlaceholder();
    const res = await get("/i/placeholder.png");
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
  });
});

describe("a coin's metadata", () => {
  test("is served at /m/<mint>.json as JSON, cached for a minute", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    writeMetadata(mint, { name: 'Say "hi"', symbol: "HI", description: "d", imageUrl: "", socials: { x: "https://x.com/abc" } });
    made.push(join(metadataDir(), `${mint}.json`));
    const res = await get(`/m/${mint}.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const json = (await res.json()) as { name: string; twitter: string };
    expect([json.name, json.twitter]).toEqual(['Say "hi"', "https://x.com/abc"]);
  });
});

describe("nothing else is served from disk", () => {
  test("a name that is not exactly one of the shapes is a plain 404, whatever it looks like", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    for (const path of [
      "/i/", "/i", "/m/", "/i/pic.png", "/i/0123456789abcdef01234567.svg", "/i/0123456789abcdef01234567.png.bak", "/i/0123456789ABCDEF01234567.png", "/i/0123456789abcdef01234567.png/x",
      "/i/%2e%2e%2fpackage.json", "/i/..%2fpackage.json", "/i/%2F%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/i//0123456789abcdef01234567.png", "/i/0123456789abcdef01234567.png%00",
      "/i/..\\package.json", "/i/placeholder.PNG", "/i/placeholder.png.bak", `/m/${mint}`, `/m/${mint}.json.bak`, `/m/..%2Fpackage.json`, "/m/x.json", `/m/${mint}.json/`,
      `/m/${mint}.JSON`, "/m/.tmp-0123456789ab",
    ]) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(res.headers.get("content-type")).toBe("application/json");
    }
  });

  test("a name of the right shape with no file behind it is 404 too", async () => {
    expect((await get("/i/0123456789abcdef0123abcd.png")).status).toBe(404);
    expect((await get(`/m/${Keypair.generate().publicKey.toBase58()}.json`)).status).toBe(404);
  });

  test("only GET and HEAD read a file: any other method falls through to the router's 404", async () => {
    const { name } = await uploaded();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handleRequest(new Request(`http://pad.test/i/${name}`, { method }), { ip: "192.0.2.52" });
      expect([method, res.status]).toEqual([method, 404]);
    }
  });
});
