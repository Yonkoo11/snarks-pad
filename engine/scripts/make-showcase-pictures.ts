#!/usr/bin/env bun
// Draws design/showcase-coins/green-snark.png and blue-snark.png: the owner's crayon mascot (web/public/mascot-600.jpg) with its pigment turned to
// green and to blue, for the two showcase coins on the devnet board. No picture generator is involved: the colours of the
// drawing are rotated and nothing else is drawn. Each picture is 600 x 600, the whole mascot, the paper's own tone all around it.
//   bun scripts/make-showcase-pictures.ts
// The hue is rotated by sharp's modulate. That also turns the paper (its cream rotates to a cold blue-green, or to a pink), so the paper is divided
// out first (it becomes a neutral grey, which has no hue to turn), the pigment is rotated, and the paper is multiplied back: where there is only
// paper, the pixel comes out as it went in. The PNGs are committed; run this only to change them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const repo = join(import.meta.dir, "..", "..");
const SOURCE = join(repo, "web", "public", "mascot-600.jpg");
const OUT_DIR = join(repo, "design", "showcase-coins");
const SIDE = 600;
/** The paper, measured on eight patches along the edges of the source (each within one level of these, grain of 4 levels): the margins are this colour. */
const PAPER = { r: 245, g: 237, b: 219 };
/** The level the paper is lifted to while the hue turns: a hair under white, so no grain pixel clips. */
const LIFTED = 250;
/**
 * Degrees of hue, counter-clockwise in LCh. The pink body sits at about 350 degrees: +130 lands on green, +240 on blue. The saturation multiplier wins back
 * the chroma that sRGB cannot hold at that hue and lightness: the pigment's mean chroma (CIELAB C*) is 47.0 in the original, 47.0 in the green (with 1.1;
 * 43.7 without) and 43.0 in the blue (with 1.25; 36.9 without, and the blue cannot go much further).
 */
const VARIANTS = [
  { file: "green-snark.png", hue: 130, saturation: 1.1 },
  { file: "blue-snark.png", hue: 240, saturation: 1.25 },
];

/** The mascot with its pigment turned by `hue` degrees and its paper unchanged, at the source's own size. */
async function turned(hue: number, saturation: number): Promise<Buffer> {
  const paper = [PAPER.r, PAPER.g, PAPER.b];
  const lifted = await sharp(SOURCE).linear(paper.map((c) => LIFTED / c), [0, 0, 0]).png().toBuffer();
  const rotated = await sharp(lifted).modulate({ hue, saturation }).png().toBuffer();
  return sharp(rotated).linear(paper.map((c) => c / LIFTED), [0, 0, 0]).png().toBuffer();
}

mkdirSync(OUT_DIR, { recursive: true });
for (const v of VARIANTS) {
  // Fitting comes last, on its own: sharp applies colour changes after resizing, and the margins must stay the paper's colour.
  const picture = await sharp(await turned(v.hue, v.saturation))
    .resize(SIDE, SIDE, { fit: "contain", background: PAPER })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(OUT_DIR, v.file), picture);
  console.log(`wrote design/showcase-coins/${v.file} (${picture.length} bytes, hue +${v.hue})`);
}
