// What may be stored as a coin's image (src/publicFiles/image.ts, store.ts; docs/API.md v2.7 POST /uploads). Pictures are made here with sharp,
// so no binary fixture sits in the repository. The things that matter: the kind comes from the first bytes alone; a PNG, JPEG or WEBP is written
// again (no EXIF, nothing riding after the picture, fitted inside 1000 x 1000, never enlarged); a GIF is stored as sent but only when its blocks
// end at the trailer; a name is the hash of the STORED bytes.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { BadImageError, MAX_GIF_SIDE, MAX_INPUT_PIXELS, gifFrameCount, processImage, sniffImage, storedName } from "../src/publicFiles/image";
import { UPLOAD_NAME, imagesDir } from "../src/publicFiles/paths";
import { ensurePlaceholder, ensurePublicDirs, storeUpload } from "../src/publicFiles/store";

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pub-"));
  roots.push(dir);
  return dir;
};
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const solid = (width: number, height: number) => ({ create: { width, height, channels: 4 as const, background: { r: 196, g: 47, b: 108, alpha: 1 } } });
const png = (w: number, h: number) => sharp(solid(w, h)).png().toBuffer();
const jpg = (w: number, h: number) => sharp(solid(w, h)).jpeg().toBuffer();
const webp = (w: number, h: number) => sharp(solid(w, h)).webp().toBuffer();
const gif = (w: number, h: number) => sharp(solid(w, h)).gif().toBuffer();
const twoFrameGif = (w: number, h: number) => {
  const frame = (v: number) => Buffer.alloc(w * h * 3, v);
  return sharp(Buffer.concat([frame(10), frame(200)]), { raw: { width: w, height: h * 2, channels: 3, pageHeight: h } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
};
const text = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const has = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).includes(needle);
const refused = (input: Uint8Array) => processImage(input).then(() => null, (e: unknown) => e);

describe("the kind comes from the first bytes, and from nothing else", () => {
  test("the four kinds are recognised from what sharp itself writes", async () => {
    expect(sniffImage(await png(8, 8))).toBe("png");
    expect(sniffImage(await jpg(8, 8))).toBe("jpg");
    expect(sniffImage(await webp(8, 8))).toBe("webp");
    expect(sniffImage(await gif(8, 8))).toBe("gif");
  });

  test("an SVG, an HTML page, a PDF, text, an empty file and a short one are none of them", () => {
    const things = [
      text('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>'),
      text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
      text("<!doctype html><html><body><script>alert(1)</script></body></html>"),
      text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"),
      text("GIF"), text("RIFF"), text("hello"), new Uint8Array(), new Uint8Array([0xff, 0xd8]), new Uint8Array(64),
    ];
    for (const t of things) expect(sniffImage(t)).toBeNull();
  });

  test("RIFF alone is not WEBP, and a PNG signature cut short is not a PNG", () => {
    expect(sniffImage(text("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]))).toBeNull();
  });

  test("processImage refuses the non-pictures with BadImageError before any decoder runs", async () => {
    for (const t of [text("<svg xmlns='http://www.w3.org/2000/svg'/>"), text("%PDF-1.4"), new Uint8Array()]) expect(await refused(t)).toBeInstanceOf(BadImageError);
  });

  test("a file that starts like a PNG but is not one is refused, not stored", async () => {
    const lie = cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), text("<script>alert(1)</script>"));
    expect(await refused(lie)).toBeInstanceOf(BadImageError);
  });
});

describe("a PNG, JPEG or WEBP is written again", () => {
  test("a large PNG is fitted inside 1000 x 1000 and stays a PNG", async () => {
    const out = await processImage(await png(3000, 2000));
    expect([out.kind, out.width, out.height]).toEqual(["png", 1000, 667]);
    expect(sniffImage(out.bytes)).toBe("png");
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1000, 667]);
  });

  test("a tall JPEG is fitted by its height; a small picture is never enlarged", async () => {
    const tall = await processImage(await jpg(500, 2500));
    expect([tall.kind, tall.width, tall.height]).toEqual(["jpg", 200, 1000]);
    for (const [make, kind] of [[png, "png"], [jpg, "jpg"], [webp, "webp"]] as const) {
      const small = await processImage(await make(120, 80));
      expect([small.kind, small.width, small.height]).toEqual([kind, 120, 80]);
    }
  });

  test("a WEBP stays a WEBP", async () => {
    const out = await processImage(await webp(1500, 1500));
    expect([out.kind, out.width, out.height]).toEqual(["webp", 1000, 1000]);
    expect((await sharp(out.bytes).metadata()).format).toBe("webp");
  });

  test("a JPEG is written at quality 90: the same bytes sharp gives for the same fit at that quality", async () => {
    const input = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg({ quality: 100 }).toBuffer();
    const out = await processImage(input);
    const direct = await sharp(input).rotate().resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    expect(Buffer.compare(Buffer.from(out.bytes), direct)).toBe(0);
    const other = await sharp(input).jpeg({ quality: 60 }).toBuffer();
    expect(Buffer.compare(Buffer.from(out.bytes), other)).not.toBe(0);
  });

  test("EXIF is stripped (the orientation is applied first, so a phone photo is not left on its side)", async () => {
    const withExif = await sharp(solid(100, 50)).jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "private-camera-owner", Make: "SecretCam" } } }).toBuffer();
    expect((await sharp(withExif).metadata()).orientation).toBe(6);
    expect(has(withExif, "private-camera-owner")).toBe(true); // the fixture does carry it
    const out = await processImage(withExif);
    expect(has(out.bytes, "private-camera-owner")).toBe(false);
    expect(has(out.bytes, "SecretCam")).toBe(false);
    expect(has(out.bytes, "Exif")).toBe(false);
    expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
    expect([out.width, out.height]).toEqual([50, 100]); // orientation 6 = turned a quarter
  });

  test("nothing that rides after the picture, and no comment, survives: a polyglot comes out as a plain picture", async () => {
    const page = "<html><script>alert(document.cookie)</script></html>";
    const pngPoly = cat(await png(64, 64), text(page));
    const jpgPoly = cat(await jpg(64, 64), text(page));
    const webpPoly = cat(await webp(64, 64), text(page));
    for (const poly of [pngPoly, jpgPoly, webpPoly]) {
      expect(has(poly, "<script>")).toBe(true);
      const out = await processImage(poly);
      expect(has(out.bytes, "<script>")).toBe(false);
      expect(has(out.bytes, "document.cookie")).toBe(false);
    }
  });

  test("a picture with more pixels than the limit is refused before it is decoded", async () => {
    const huge = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(huge.length).toBeLessThan(5 * 1024 * 1024); // a small file that unpacks into 56 megapixels
    expect(await refused(huge)).toBeInstanceOf(BadImageError);
  });

  test("a truncated or corrupt picture is refused", async () => {
    const whole = await png(300, 300);
    expect(await refused(whole.subarray(0, 40))).toBeInstanceOf(BadImageError);
    const broken = Uint8Array.from(whole);
    broken.fill(0x41, 60, 200);
    expect(await refused(broken)).toBeInstanceOf(BadImageError);
  });
});

describe("the pixel limit is 25 million, and a picture over it is refused before any pixel is decoded (S4-03)", () => {
  /** A real 1 x 1 PNG whose IHDR claims `w` x `h` (CRC recomputed): a header that lies about the picture behind it, so a decoder that believed it would reserve gigabytes. */
  const claiming = async (w: number, h: number): Promise<Uint8Array> => {
    const p = Uint8Array.from(await png(1, 1));
    const dv = new DataView(p.buffer);
    dv.setUint32(16, w);
    dv.setUint32(20, h);
    dv.setUint32(29, Bun.hash.crc32(p.subarray(12, 29)) >>> 0);
    return p;
  };
  const reason = async (input: Uint8Array): Promise<string> => ((await refused(input)) as Error).message;

  test("the stated number", () => {
    expect(MAX_INPUT_PIXELS).toBe(25_000_000);
  });

  test("a 1 x 1 PNG claiming 20,000 x 20,000 is refused for its size, at once, not for the missing pixels behind the claim", async () => {
    const lie = await claiming(20_000, 20_000);
    expect(lie.length).toBeLessThan(200);
    const t0 = performance.now();
    const err = await refused(lie);
    expect(err).toBeInstanceOf(BadImageError);
    expect((err as Error).message).toMatch(/pixel limit/);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test("the limit is exact: 5,000 x 5,000 gets past the size check (and fails on the pixels that are not there), 5,001 x 5,000 does not", async () => {
    expect(await reason(await claiming(5_000, 5_000))).not.toMatch(/pixel limit/);
    expect(await reason(await claiming(5_001, 5_000))).toMatch(/pixel limit/);
    expect(await refused(await claiming(2_147_483_647, 1))).toBeInstanceOf(BadImageError); // a width libpng itself will not read
  });

  test("the old limit of 50 million is gone: a 7,071 x 7,071 claim, which used to pass the size check, is refused for its size", async () => {
    expect(await reason(await claiming(7_071, 7_071))).toMatch(/pixel limit/);
  });

  test("a real picture just under the limit still comes out fitted inside 1000 x 1000", async () => {
    const big = await sharp({ create: { width: 4_000, height: 6_000, channels: 3, background: "#c42f6c" } }).png({ compressionLevel: 9 }).toBuffer(); // 24 million pixels, a few KB
    const out = await processImage(big);
    expect([out.kind, out.width, out.height]).toEqual(["png", 667, 1_000]);
  }, 60_000);
});

describe("a GIF is kept as sent, if it is a picture that ends where it should", () => {
  test("the stored bytes are the bytes sent, and the size is the first frame's", async () => {
    const input = await twoFrameGif(40, 30);
    expect(gifFrameCount(input)).toBe(2);
    const out = await processImage(input);
    expect(out.kind).toBe("gif");
    expect(Buffer.compare(Buffer.from(out.bytes), Buffer.from(input))).toBe(0);
    expect([out.width, out.height]).toEqual([40, 30]);
  });

  test("anything after the trailer is refused, as is a missing trailer", async () => {
    const input = await gif(32, 32);
    expect(await refused(cat(input, text("<script>alert(1)</script>")))).toBeInstanceOf(BadImageError);
    expect(await refused(input.subarray(0, input.length - 1))).toBeInstanceOf(BadImageError);
    expect(await refused(cat(input, new Uint8Array([0])))).toBeInstanceOf(BadImageError);
  });

  test("a GIF cut short in the middle, or with a block that points past the end, is refused", async () => {
    const input = await twoFrameGif(40, 30);
    expect(gifFrameCount(input.subarray(0, Math.floor(input.length / 2)))).toBeNull();
    const bad = Uint8Array.from(input);
    bad[bad.length - 2] = 0x7f; // the last sub-block now claims 127 bytes
    expect(gifFrameCount(bad)).toBeNull();
    expect(await refused(bad)).toBeInstanceOf(BadImageError);
  });

  test("a GIF wider than the stored limit is refused", async () => {
    expect(await refused(await gif(MAX_GIF_SIDE + 1, 8))).toBeInstanceOf(BadImageError);
    expect((await processImage(await gif(MAX_GIF_SIDE, 8))).width).toBe(MAX_GIF_SIDE);
  });
});

describe("a GIF's logical screen is bounded too, not only its first frame", () => {
  /** A real 2 x 2 GIF whose logical screen descriptor (bytes 6-9) claims w x h: what a viewer allocates, while sharp reports the frame. */
  const withScreen = async (w: number, h: number): Promise<Uint8Array> => {
    const g = Uint8Array.from(await gif(2, 2));
    g[6] = w & 255;
    g[7] = w >> 8;
    g[8] = h & 255;
    g[9] = h >> 8;
    return g;
  };

  test("a 2 x 2 frame on a screen over the limit on either side is refused; on a screen at the limit it passes (S4 ST-UP-05)", async () => {
    expect(await refused(await withScreen(MAX_GIF_SIDE + 1, 2))).toBeInstanceOf(BadImageError);
    expect(await refused(await withScreen(2, MAX_GIF_SIDE + 1))).toBeInstanceOf(BadImageError);
    expect(await refused(await withScreen(65535, 65535))).toBeInstanceOf(BadImageError);
    expect(await refused(await withScreen(0, 2))).toBeInstanceOf(BadImageError);
    const ok = await processImage(await withScreen(MAX_GIF_SIDE, 2));
    expect(ok.kind).toBe("gif");
  });
});

describe("the name is the hash of the stored bytes", () => {
  test("the first 24 hex digits of the sha256, then the stored kind's extension", async () => {
    const out = await processImage(await jpg(300, 200));
    const hex = createHash("sha256").update(out.bytes).digest("hex");
    expect(storedName(out.bytes, out.kind)).toBe(`${hex.slice(0, 24)}.jpg`);
    expect(storedName(out.bytes, out.kind)).toMatch(UPLOAD_NAME);
  });

  test("the hash is of what is STORED: two different originals that become the same picture share a name", async () => {
    const root = scratch();
    const plain = await sharp(solid(100, 100)).jpeg({ quality: 100 }).toBuffer();
    const tagged = await sharp(solid(100, 100)).jpeg({ quality: 100 }).withExif({ IFD0: { Copyright: "x" } }).toBuffer();
    expect(Buffer.compare(plain, tagged)).not.toBe(0);
    const a = await storeUpload(plain, root);
    const b = await storeUpload(tagged, root);
    expect(a.name).toBe(b.name);
    expect(readdirSync(imagesDir(root)).filter((f) => UPLOAD_NAME.test(f))).toEqual([a.name]);
  });

  test("a GIF's name is the hash of the GIF itself", async () => {
    const root = scratch();
    const input = await twoFrameGif(20, 20);
    const stored = await storeUpload(input, root);
    expect(stored.name).toBe(`${createHash("sha256").update(input).digest("hex").slice(0, 24)}.gif`);
  });
});

describe("storing", () => {
  test("a file lands under i/, group-readable and not world-readable, with no temporary file left behind", async () => {
    const root = scratch();
    const stored = await storeUpload(await png(2000, 1000), root);
    const file = join(imagesDir(root), stored.name);
    const bytes = readFileSync(file);
    expect([stored.width, stored.height, stored.bytes]).toEqual([1000, 500, bytes.length]);
    expect(stored.url.endsWith(`/i/${stored.name}`)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(statSync(imagesDir(root)).mode & 0o777).toBe(0o750);
    expect(readdirSync(imagesDir(root)).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  });

  test("the same picture twice is one file; the second send renews its time, which is what the sweep counts from", async () => {
    const root = scratch();
    const input = await png(64, 64);
    const first = await storeUpload(input, root);
    const file = join(imagesDir(root), first.name);
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(file, old, old);
    const second = await storeUpload(input, root);
    expect(second.name).toBe(first.name);
    expect(Date.now() - statSync(file).mtimeMs).toBeLessThan(60_000);
  });

  test("the placeholder is written under i/ once and left alone after", () => {
    const root = scratch();
    ensurePublicDirs(root);
    ensurePlaceholder(root);
    const file = join(imagesDir(root), "placeholder.png");
    expect(existsSync(file)).toBe(true);
    expect(sniffImage(readFileSync(file))).toBe("png");
    const mtime = statSync(file).mtimeMs;
    ensurePlaceholder(root);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });
});
