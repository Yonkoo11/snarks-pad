// The "Creator wallet" of a launch: an optional wallet that receives the creator's share of the trading fee. The DBC
// program makes the launcher sign as the pool's creator, so the launch transaction hands the pool to this wallet with `transfer_pool_creator` (the launcher
// signs once; the receiver need not sign or hold SOL). After the handover only the receiver can claim the creator fee and own the creator's locked LP, and the
// launcher never can: a wrong address strands both for good. So this wallet is refused unless it is a real wallet (on the ed25519 curve) that is not one of the pad's
// own. Pure checks plus one database read; nothing is signed and no keeper key is loaded (INV-17).
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { recordedExcludedOwners } from "../holders";
import { expectedFeeClaimer } from "./config";

/** A Creator wallet that cannot be used (the API answers 400 `bad_creator_wallet`). `reason` is for the server log; it is never sent to a caller. */
export class CreatorWalletError extends Error {
  constructor(public reason: "not_a_wallet" | "off_curve" | "pad_owned") {
    super(reason);
  }
}

/** Every wallet this pad holds a key to or pays itself through: the keeper, the fee claimers and Squads members it has recorded, the team wallet, the vault. */
export function padOwnedWallets(): Set<string> {
  const owned = recordedExcludedOwners();
  const more = [config.epoch.team.wallet, config.solana.dbc.feeClaimer?.toBase58(), config.solana.dbc.squadsMultisig?.toBase58(), expectedFeeClaimer()?.toBase58()];
  for (const w of more) if (w) owned.add(w);
  return owned;
}

function canonicalPubkey(raw: unknown): PublicKey {
  if (typeof raw !== "string" || raw.length < 32 || raw.length > 44) throw new CreatorWalletError("not_a_wallet");
  try {
    const key = new PublicKey(raw);
    if (key.toBase58() === raw) return key;
  } catch {
    // falls through: not base58 of 32 bytes
  }
  throw new CreatorWalletError("not_a_wallet");
}

/**
 * The wallet to hand the pool to, or null when there is none to hand it to: nothing given (undefined, null or ""), or the launcher's own address (the launcher already is
 * the creator, and the program refuses a handover to the same key). Throws CreatorWalletError for an address that is not a canonical base58 wallet, is off the curve (a PDA or
 * token account: nobody can sign for it) or belongs to the pad.
 */
export function requireCreatorWallet(raw: unknown, launcher: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const key = canonicalPubkey(raw);
  if (!PublicKey.isOnCurve(key.toBytes())) throw new CreatorWalletError("off_curve");
  const address = key.toBase58();
  if (address === launcher) return null;
  if (padOwnedWallets().has(address)) throw new CreatorWalletError("pad_owned");
  return address;
}
