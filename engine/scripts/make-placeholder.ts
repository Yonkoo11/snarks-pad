#!/usr/bin/env bun
// Draws engine/assets/placeholder.png, the picture a coin launched without an image shows in a wallet or an explorer (src/publicFiles/store.ts
// copies it under /i when the API starts). Plain shapes in the site's own paper and ink colours (design/build-brief.md), no text and no font,
// so the same file comes out on every machine. Run it only to change the picture; the PNG is committed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const PAPER = "#f5efe2";
const PAPER_3 = "#ece4d2";
const INK = "#2b2420";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${PAPER}"/>
  <circle cx="256" cy="256" r="150" fill="${PAPER_3}" stroke="${INK}" stroke-width="10"/>
  <circle cx="256" cy="256" r="112" fill="none" stroke="${INK}" stroke-width="6" stroke-dasharray="2 14" stroke-linecap="round"/>
  <path d="M 196 300 L 316 212" stroke="${INK}" stroke-width="10" stroke-linecap="round" opacity="0.25"/>
</svg>`;

const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
const out = join(import.meta.dir, "..", "assets", "placeholder.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
