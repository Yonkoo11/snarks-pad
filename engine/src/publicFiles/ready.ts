// What the API does about its hosted files before it listens: refuses a mainnet start whose files would be addressed from a dev origin, makes
// the two directories and the placeholder, and (src/publicFiles/sweep.ts) starts the hourly clean-up.
import { config } from "../config";
import { ensurePlaceholder, ensurePublicDirs } from "./store";

/**
 * A coin's on-chain uri is the address of its metadata file and can never change, so on mainnet it must be a real https address. The dev default
 * (this engine on 127.0.0.1) is refused there; on devnet it only gets a warning, because a developer's Mac runs devnet mode without a server.
 */
export function assertPublicBaseUrl(mode: string = config.mode, baseUrl: string = config.publicFiles.baseUrl): void {
  if (mode === "mainnet" && !baseUrl.startsWith("https://")) {
    throw new Error(`PUBLIC_BASE_URL must be an https address on mainnet (got ${baseUrl}): it is written on chain in every coin's metadata uri and can never change. Set it in engine.env, for example https://snarks.fun`);
  }
  if (mode === "devnet" && !baseUrl.startsWith("https://")) {
    console.warn(`[api] PUBLIC_BASE_URL is ${baseUrl}: coin images and metadata launched now are addressed from there and only work on this machine`);
  }
}

/** Run once when the API starts (src/api.ts startApiServer). Throws, and so stops the start, on a mainnet configuration that cannot be right. */
export function prepareHostedFiles(): void {
  assertPublicBaseUrl();
  ensurePublicDirs();
  ensurePlaceholder();
}
