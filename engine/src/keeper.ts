// Keeper keypair: the pad's operating key (harvests fees, sells, pays Solana ZEC,
// signs platform-config creation). Local mode generates a throwaway keypair on
// first run and persists it (gitignored). Never logged, never committed.
import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config";

let cached: Keypair | null = null;

/** A member key from a JSON secret-key file (the devnet stand-in owner, config.devnetCoSignerKeypair); never generated. */
export function loadKeypairFile(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export function loadKeeperKeypair(): Keypair {
  if (cached) return cached;
  const path = config.paths.keeperKeypair;
  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
    cached = Keypair.fromSecretKey(secret);
    return cached;
  }
  if (!config.isLocal) {
    throw new Error(
      `keeper keypair not found at ${path}. Set KEEPER_KEYPAIR_PATH for ${config.mode} mode; refusing to auto-generate outside local mode.`,
    );
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  cached = kp;
  return kp;
}
