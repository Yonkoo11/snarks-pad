// A stuck epoch must not block forever (audit O-2). Before this, one unfinished epoch (a 1Click swap that
// never resolves, a pending batch with no stored bytes, a shielded row left pending) stopped every later claim
// and payout until a human acted. Now such an epoch is PARKED (status needs_attention) once it has stayed
// unfinished for too many runs or too long; it keeps being progressed on every run and its rows stay unsent
// and counted as owed. Later epochs may then start only if the parked money is PROVABLY separate from what
// they will spend; otherwise the keeper stays halted and says why.
//
// "Separate" is checked, not assumed. The only balance an epoch shares with another is the keeper's Solana ZEC
// account (new claims land in it, payouts leave it) and the treasury's native ZEC wallet. A later epoch pays
// only rows it planned from its own claims plus carry, so it cannot spend the parked epoch's money as long as
// the account holds at least everything that is owed from it, parked rows included. A swap that is out with
// 1Click holds its money outside both: a later epoch cannot touch it, and when it settles it is attributed by
// its own delivery txid (a txid already counted for another swap is refused, near1click.ts), so nothing is
// counted twice.
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { config } from "../config";
import * as db from "../db";
import { loadKeeperKeypair } from "../keeper";
import { getConnection } from "../solana";

export interface IsolationDeps {
  /** The keeper's Solana ZEC balance right now. */
  keeperZecBalance: () => Promise<bigint>;
  /** The treasury wallet's spendable native ZEC, or null if it cannot be read. */
  treasurySpendableZats: () => Promise<bigint | null>;
}

export const chainIsolationDeps: IsolationDeps = {
  async keeperZecBalance() {
    const ata = getAssociatedTokenAddressSync(config.solana.dbc.quoteMint, loadKeeperKeypair().publicKey, false, TOKEN_PROGRAM_ID);
    const info = await getConnection().getAccountInfo(ata, "confirmed");
    if (!info) return 0n; // no account yet: nothing is held
    return (await getAccount(getConnection(), ata, "confirmed", TOKEN_PROGRAM_ID)).amount;
  },
  async treasurySpendableZats() {
    const { getBalance, syncWallet } = await import("../zcash/devtool");
    try {
      if (config.isLocal) {
        const { TREASURY_DIR } = await import("../zcash/regtest");
        return getBalance(TREASURY_DIR).spendableZats;
      }
      const dir = config.near1click.treasuryWalletDir;
      if (!dir) return null;
      syncWallet(dir);
      return getBalance(dir).spendableZats;
    } catch {
      return null;
    }
  },
};

/** Why an unfinished epoch counts as stuck (too many runs, or too old), or null. */
export function stuckReason(epoch: db.EpochRow, nowMs: number): string | null {
  const attempts = epoch.attempts ?? 0;
  if (attempts >= config.epoch.stuckMaxAttempts) return `unfinished after ${attempts} runs`;
  // The age counts from the first run that ended unfinished, not from the draft: a draft waits for the owner's approval of its
  // claims for as long as that takes, and that wait is not the epoch being stuck (audit S6, lens 3-3).
  const ageMs = nowMs - Date.parse(epoch.unfinishedSince ?? epoch.at);
  if (ageMs >= config.epoch.stuckMaxAgeMs) return `unfinished for ${Math.round(ageMs / 3_600_000)} hours`;
  return null;
}

/** Everything that stops a new epoch from starting while parked epochs still owe money; empty means isolated. */
export async function isolationProblems(deps: IsolationDeps): Promise<string[]> {
  const parked = db.listParkedEpochs().filter((e) => db.epochHasUnsentPayouts(e.id));
  if (parked.length === 0) return [];
  const problems: string[] = [];
  const owedFromKeeper = db.sumOwedFromKeeper();
  const held = await deps.keeperZecBalance();
  if (held < owedFromKeeper) {
    problems.push(`the keeper holds ${held} zats of Solana ZEC but ${owedFromKeeper} is owed from it (parked epochs included): the parked money cannot be told apart from new fees`);
  }
  const owedFromTreasury = db.sumUnsentShieldedSettled();
  if (owedFromTreasury > 0n) {
    const spendable = await deps.treasurySpendableZats();
    if (spendable === null) problems.push(`${owedFromTreasury} zats are owed from the treasury wallet for a settled swap, and the wallet balance could not be read`);
    else if (spendable < owedFromTreasury) problems.push(`the treasury wallet holds ${spendable} spendable zats but ${owedFromTreasury} is owed from it for settled swaps`);
  }
  return problems;
}
