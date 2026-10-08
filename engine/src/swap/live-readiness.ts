// What the live swap script must demand of the keeper BEFORE it runs, decided from
// the persisted swap row for the key. A resume of a swap that already has a signed
// or confirmed deposit must never be blocked by "fund the keeper" checks (the ZEC is
// already gone: a zero balance is expected), and a fresh swap must still be refused
// when the keeper cannot pay for it. The adapter itself already orders this correctly
// (submit() resumes any row past `quoted` before it looks at a balance, and never signs
// outside `quoted`); this module keeps the script's preflight in step with it.
import type { Near1ClickPhase } from "../db";

export interface FundingNeeds {
  /** Keeper Solana ZEC >= the amount: only before a deposit is signed. */
  zec: boolean;
  /** Keeper SOL for fees/rent: also while a signed deposit may still need rebroadcasting. */
  sol: boolean;
  /** A dry quote and a deposit simulation: only for a swap that has not signed yet. */
  quoteAndSimulation: boolean;
}

export function fundingNeeds(phase: Near1ClickPhase | undefined): FundingNeeds {
  const fresh = phase === undefined || phase === "quoted";
  return { zec: fresh, sol: fresh || phase === "signed", quoteAndSimulation: fresh };
}

export interface KeeperBalances {
  lamports: bigint;
  zecZats: bigint;
}

export function balanceProblems(
  needs: FundingNeeds,
  have: KeeperBalances,
  want: { amountZats: bigint; minLamports: bigint; keeper: string; zecAccount: string; zecLabel: string },
): string[] {
  const problems: string[] = [];
  if (needs.sol && have.lamports < want.minLamports) problems.push(`fund the keeper ${want.keeper} with at least ${Number(want.minLamports) / 1e9} SOL (0.005 recommended)`);
  if (needs.zec && have.zecZats < want.amountZats) problems.push(`fund the keeper's ZEC account ${want.zecAccount} with at least ${want.zecLabel} of Solana ZEC`);
  return problems;
}
