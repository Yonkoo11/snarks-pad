// A coin's metadata JSON (src/publicFiles/metadata.ts, docs/API.md v2.7. The on-chain uri names THIS file; a wallet reads the name, the picture and
// the links from it. It is written with JSON.stringify, so whatever a creator types survives intact.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { config } from "../src/config";
import { MAX_URI_CHARS, metadataDir, metadataUrl, placeholderUrl, uploadUrl } from "../src/publicFiles/paths";
import { buildMetadata, imageOf, removeMetadata, writeMetadata } from "../src/publicFiles/metadata";

const BASE = config.publicFiles.baseUrl;
const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "meta-"));
  roots.push(dir);
  return dir;
};
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const mint = () => Keypair.generate().publicKey.toBase58();
const NAME = "0123456789abcdef01234567.png";

describe("the object", () => {
  test("every field a wallet reads: name, symbol, description, image, the links under their own keys and at the top, createdOn, the picture as a file", () => {
    const m = buildMetadata({
      name: "Release The Snarks", symbol: "SNARKS", description: "a pink pizza-slice monster", imageUrl: uploadUrl(NAME),
      socials: { website: "https://example.com/", x: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad" },
    });
    expect(m).toEqual({
      name: "Release The Snarks", symbol: "SNARKS", description: "a pink pizza-slice monster", image: `${BASE}/i/${NAME}`,
      external_url: "https://example.com/",
      extensions: { website: "https://example.com/", twitter: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad" },
      website: "https://example.com/", twitter: "https://x.com/snarkspad", telegram: "https://t.me/snarkspad",
      createdOn: BASE,
      properties: { files: [{ uri: `${BASE}/i/${NAME}`, type: "image/png" }], category: "image" },
    });
  });

  test("with no links there is no external_url and no top-level link, and `extensions` is still an object", () => {
    const m = buildMetadata({ name: "N", symbol: "S", description: "", imageUrl: uploadUrl(NAME), socials: {} });
    expect(m.extensions).toEqual({});
    for (const key of ["external_url", "website", "twitter", "telegram"]) expect(key in m).toBe(false);
  });

  test("only the links given appear; X is written as `twitter`", () => {
    const m = buildMetadata({ name: "N", symbol: "S", description: "", imageUrl: "", socials: { x: "https://x.com/abc" } });
    expect(m.extensions).toEqual({ twitter: "https://x.com/abc" });
    expect(m.twitter).toBe("https://x.com/abc");
    expect("external_url" in m).toBe(false);
  });

  test("a coin with no image shows the placeholder, which is a PNG", () => {
    expect(imageOf("")).toEqual({ image: placeholderUrl(), type: "image/png" });
    expect(placeholderUrl()).toBe(`${BASE}/i/placeholder.png`);
  });

  test("the picture's type follows the stored name, and a site path (the seed scripts' /mascot.jpg) becomes an address under the base", () => {
    expect(imageOf(uploadUrl("0123456789abcdef01234567.jpg")).type).toBe("image/jpeg");
    expect(imageOf(uploadUrl("0123456789abcdef01234567.webp")).type).toBe("image/webp");
    expect(imageOf(uploadUrl("0123456789abcdef01234567.gif")).type).toBe("image/gif");
    expect(imageOf("/mascot.jpg")).toEqual({ image: `${BASE}/mascot.jpg`, type: "image/jpeg" });
  });
});

describe("the file", () => {
  test("a name and a description with quotes, backslashes, newlines, emoji and markup come back exactly as typed", () => {
    const root = scratch();
    const m = mint();
    const name = 'He said "hi" \\ back \u{1f600}';
    const description = 'line one\nline two with "quotes", a \\backslash, </script><script>alert(1)</script>, é中文 \u{1f9ea},   and a lone \ud800 surrogate';
    writeMetadata(m, { name, symbol: "QTE", description, imageUrl: uploadUrl(NAME), socials: {} }, root);
    const text = readFileSync(join(metadataDir(root), `${m}.json`), "utf8");
    const parsed = JSON.parse(text) as { name: string; description: string };
    expect(parsed.name).toBe(name);
    expect(parsed.description).toBe(description); // even the lone surrogate: JSON.stringify writes it as an escape, so the file stays valid UTF-8 and valid JSON
    expect(text.includes("</script>")).toBe(true); // JSON, not HTML: nothing here is interpreted
    expect(text.split("\n")).toHaveLength(1); // one line: the newline in the description is \n inside a string
  });

  test("it lands at m/<mint>.json, group-readable only, and writing again replaces it", () => {
    const root = scratch();
    const m = mint();
    writeMetadata(m, { name: "A", symbol: "A", description: "", imageUrl: "", socials: {} }, root);
    const file = join(metadataDir(root), `${m}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    writeMetadata(m, { name: "B", symbol: "B", description: "", imageUrl: "", socials: {} }, root);
    expect((JSON.parse(readFileSync(file, "utf8")) as { name: string }).name).toBe("B");
    expect(readdirSync(metadataDir(root))).toEqual([`${m}.json`]);
  });

  test("a coin with no image brings the placeholder file along, so the address in its JSON answers", () => {
    const root = scratch();
    writeMetadata(mint(), { name: "A", symbol: "A", description: "", imageUrl: "", socials: {} }, root);
    expect(readdirSync(join(root, "i"))).toEqual(["placeholder.png"]);
  });

  test("a name that is not a mint address is never written, whatever it holds", () => {
    const root = scratch();
    for (const bad of ["../escape", "a/b", "", "x".repeat(60), "..", "%2e%2e%2fx", "mint.json"]) {
      expect(() => writeMetadata(bad, { name: "A", symbol: "A", description: "", imageUrl: "", socials: {} }, root)).toThrow();
    }
    expect(readdirSync(root)).toEqual([]);
  });

  test("removing is by mint only and quiet when there is nothing", () => {
    const root = scratch();
    const m = mint();
    writeMetadata(m, { name: "A", symbol: "A", description: "", imageUrl: "", socials: {} }, root);
    removeMetadata("../../etc/passwd", root);
    removeMetadata(mint(), root);
    expect(readdirSync(metadataDir(root))).toEqual([`${m}.json`]);
    removeMetadata(m, root);
    expect(readdirSync(metadataDir(root))).toEqual([]);
  });
});

describe("the address written on chain", () => {
  test("is <PUBLIC_BASE_URL>/m/<mint>.json and fits the 200 characters Metaplex stores", () => {
    const m = mint();
    expect(metadataUrl(m)).toBe(`${BASE}/m/${m}.json`);
    expect(metadataUrl(m).length).toBeLessThanOrEqual(MAX_URI_CHARS);
    expect(`${"https://".padEnd(100, "a")}/m/${"1".repeat(44)}.json`.length).toBeLessThanOrEqual(MAX_URI_CHARS); // the longest base the config accepts still fits
  });
});
