// A coin's metadata JSON docs/API.md v2.7: the file a wallet or an explorer reads at the coin's on-chain uri to learn its name, picture and
// links. Metaplex's token metadata points at THIS file, never at the picture itself (a uri that is an image shows no image in Phantom or Solscan).
// The file is `<PUBLIC_DIR>/m/<mint>.json`, served at `<PUBLIC_BASE_URL>/m/<mint>.json`, and written with JSON.stringify so a quote, a backslash or
// any Unicode in a name or a description can never break the file.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import type { Socials } from "../socials";
import { METADATA_NAME, metadataDir, mimeOfName, placeholderUrl } from "./paths";
import { ensurePlaceholder, writeFileAtomic } from "./store";

export interface MetadataInput {
  name: string;
  symbol: string;
  description: string;
  /** The coin's own image address (one of this pad's uploads), "" for none (the placeholder is shown), or a site path such as "/mascot.jpg" (the seed scripts). */
  imageUrl: string;
  socials: Socials;
}

/** The absolute address and media type of the picture the metadata names. */
export function imageOf(imageUrl: string): { image: string; type: string } {
  if (imageUrl === "") return { image: placeholderUrl(), type: "image/png" };
  const absolute = imageUrl.startsWith("/") ? `${config.publicFiles.baseUrl}${imageUrl}` : imageUrl;
  return { image: absolute, type: mimeOfName(absolute.slice(absolute.lastIndexOf("/") + 1).toLowerCase().replace(/\.jpeg$/, ".jpg")) };
}

/** The metadata object. `extensions` is always there; a link appears under its own key and at the top level (explorers read either), and `external_url` is the website. */
export function buildMetadata(input: MetadataInput): Record<string, unknown> {
  const { image, type } = imageOf(input.imageUrl);
  const links: Record<string, string> = {};
  if (input.socials.website) links.website = input.socials.website;
  if (input.socials.x) links.twitter = input.socials.x;
  if (input.socials.telegram) links.telegram = input.socials.telegram;
  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image,
    ...(links.website ? { external_url: links.website } : {}),
    extensions: { ...links },
    ...links,
    createdOn: config.publicFiles.baseUrl,
    properties: { files: [{ uri: image, type }], category: "image" },
  };
}

/** Writes the coin's metadata file (and makes sure the placeholder it may name is there). Throws on a mint that is not a mint, so no name is ever a path. */
export function writeMetadata(mint: string, input: MetadataInput, root: string = config.publicFiles.dir): void {
  const file = `${mint}.json`;
  if (!METADATA_NAME.test(file)) throw new Error("metadata is written only for a mint address");
  if (input.imageUrl === "") ensurePlaceholder(root);
  writeFileAtomic(metadataDir(root), file, JSON.stringify(buildMetadata(input)));
}

export function removeMetadata(mint: string, root: string = config.publicFiles.dir): void {
  const file = `${mint}.json`;
  if (METADATA_NAME.test(file)) rmSync(join(metadataDir(root), file), { force: true });
}
