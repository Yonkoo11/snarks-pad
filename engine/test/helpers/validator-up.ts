// Suites that need the local validator (mainnet DBC/DAMM v2/Squads binaries on :8899) or the built zcash-devtool run only where
// those exist, so a fresh clone without the toolchain gets skips, not connection errors. `bun run local:up` starts the validator.
import { existsSync } from "node:fs";
import { config } from "../../src/config";
import { getConnection } from "../../src/solana";

export async function validatorUp(): Promise<boolean> {
  try {
    await getConnection().getVersion();
    return config.isLocal;
  } catch {
    return false;
  }
}

/** Tests that read the treasury through the pinned zcash-devtool binary run only where it was built (`scripts/build-devtool.sh`). */
export function devtoolPresent(): boolean {
  return existsSync(config.paths.zcashDevtoolBin);
}
