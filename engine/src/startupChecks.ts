// What a mainnet process must have, and what it should not run without noticing (audit S6, lens 6-4). Config loading stays
// permissive (tests and tools import it under every mode); the two long-running entry points (scripts/keeper.ts,
// scripts/api.ts) call this before they start and stop on a fatal problem.
import type { PadMode } from "./config";

export interface StartupProblems {
  /** The process must not start: it would run on the wrong network or without its own RPC. */
  fatal: string[];
  /** The process may start, but the operator is told in the first lines of the journal. */
  warnings: string[];
}

export function mainnetStartupProblems(role: "keeper" | "api", mode: PadMode, env: NodeJS.ProcessEnv = process.env): StartupProblems {
  const out: StartupProblems = { fatal: [], warnings: [] };
  if (mode !== "mainnet") return out;
  if (!env.SOLANA_MAINNET_RPC?.trim()) {
    out.fatal.push("SOLANA_MAINNET_RPC is not set: the process would silently run on the public RPC (rate limited, no history), which a payout round cannot rely on. Set it in secrets.env (ops/DEPLOY.md).");
  }
  if (!env.ZCASH_LIGHTWALLETD?.trim()) {
    out.warnings.push("ZCASH_LIGHTWALLETD is not set: zcash-devtool is told to use 127.0.0.1:8137, the local regtest default. Set it unless a lightwalletd really listens there.");
  }
  if (role === "api" && !env.PUBLIC_DIR?.trim()) {
    out.warnings.push("PUBLIC_DIR is not set: coin pictures and metadata are written under engine/data/public, which Caddy does not serve. Set it to the directory Caddy serves (ops/DEPLOY.md).");
  }
  if (role === "api" && !env.LAUNCHPAD_SIGNER_PATH?.trim()) {
    out.warnings.push("LAUNCHPAD_SIGNER_PATH is not set: launches are built without the pad's launch signer, so trading terminals cannot attribute them to the pad (ops/keys-setup.sh <instance> signer, ops/DEPLOY.md 16).");
  }
  return out;
}

/** Prints the warnings, throws on the first fatal problem. */
export function assertStartable(role: "keeper" | "api", mode: PadMode, env: NodeJS.ProcessEnv = process.env): void {
  const { fatal, warnings } = mainnetStartupProblems(role, mode, env);
  for (const w of warnings) console.error(`ALERT config (${role}): ${w}`);
  if (fatal.length > 0) throw new Error(`refusing to start the ${role} on mainnet:\n  ${fatal.join("\n  ")}`);
}
