// Unified-address parsing for opt-in registration. We do not implement ZIP-316
// (bech32m + F4Jumble) ourselves: zcash-devtool's `inspect` command already
// decodes any Zcash address string and reports its network, kind and receivers
// (verified interactively, see probe/zcash-batch). Shelling out to it is the
// same "call zcash-devtool if it has a parse command" path the build spec allows.
import { config, type ZcashNetwork } from "../config";

export type AddressRejection = "bad_address" | "no_orchard_receiver";
export type AddressCheck = { ok: true } | { ok: false; reason: AddressRejection };

function devtoolNetworkToZcashNetwork(s: string): ZcashNetwork | null {
  const t = s.trim().toLowerCase();
  if (t === "regtest") return "regtest";
  if (t === "testnet" || t === "test") return "test";
  if (t === "main" || t === "mainnet") return "main";
  return null;
}

function runInspect(address: string): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync([config.paths.zcashDevtoolBin, "inspect", address]);
  const stdout = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  return { exitCode: proc.exitCode ?? 1, stdout };
}

/**
 * Requires a unified address with an Orchard receiver, on the network this pad
 * is currently operating (config.zcash.network). Rejects transparent addresses,
 * Sapling-only addresses, and any address on the wrong network.
 */
/** The checks that need no subprocess (audit S2-13: run these before the signature, the devtool check only after it). */
export function precheckZcashAddress(address: string): AddressCheck {
  const trimmed = address.trim();
  // Only a bech32 string ever reaches the subprocess: no leading "-", no spaces,
  // no shell or option syntax. Non-unified prefixes are rejected without spawning.
  if (!/^[A-Za-z0-9]{1,2000}$/.test(trimmed)) return { ok: false, reason: "bad_address" };
  if (!trimmed.startsWith("u")) return { ok: false, reason: "no_orchard_receiver" };
  if (!/^u(test|regtest)?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(trimmed)) return { ok: false, reason: "bad_address" };
  return { ok: true };
}

export function checkZcashAddress(address: string, expectedNetwork: ZcashNetwork = config.zcash.network): AddressCheck {
  const pre = precheckZcashAddress(address);
  if (!pre.ok) return pre;
  const trimmed = address.trim();

  const { exitCode, stdout } = runInspect(trimmed);
  if (exitCode !== 0) return { ok: false, reason: "bad_address" };

  // Kind first: a transparent or Sapling-only address is "no_orchard_receiver"
  // regardless of which network its encoding happens to resemble (regtest
  // transparent/Sapling addresses share testnet's HRP, only unified addresses
  // have a distinct "uregtest" prefix).
  const kindLine = /Kind:\s*(.+)/.exec(stdout)?.[1]?.trim();
  if (kindLine !== "Unified Address") return { ok: false, reason: "no_orchard_receiver" };

  const hasOrchard = /^\s*-\s*Orchard\s*\(/m.test(stdout);
  if (!hasOrchard) return { ok: false, reason: "no_orchard_receiver" };

  const networkLine = /Network:\s*(\S+)/.exec(stdout)?.[1];
  const network = networkLine ? devtoolNetworkToZcashNetwork(networkLine) : null;
  if (!network || network !== expectedNetwork) return { ok: false, reason: "bad_address" };

  return { ok: true };
}

/** Never expose a full zcash address (api-contract.md privacy rule). */
export function maskZcashAddress(address: string): string {
  if (address.length <= 10) return "…";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
