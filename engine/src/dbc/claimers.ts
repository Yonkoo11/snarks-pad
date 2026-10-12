// Picks the FeeClaimer for a coin from the fee claimer its DBC config names
// (permanent per config, so coins launched under an older config keep their
// old claimer). Keeper-side only: it loads the keeper key.
import { PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { loadKeeperKeypair, loadKeypairFile } from "../keeper";
import { localKeypairFeeClaimer, type FeeClaimer } from "./claim";
import { SquadsVaultFeeClaimer, vaultOf } from "./squads";

export { feeClaimerAddressOf } from "./graduation";

/**
 * The claimer able to sign for `address`: the keeper key itself (Option A) or
 * the vault of the configured Squads multisig (Option B). Anything else is an
 * error, never a guess: a claim for a claimer this process cannot sign for
 * could not land, and silently skipping it would leave fees unclaimed.
 */
export async function claimerFor(address: PublicKey): Promise<FeeClaimer> {
  const keeper = loadKeeperKeypair();
  if (address.equals(keeper.publicKey)) return localKeypairFeeClaimer(keeper);
  const multisig = config.solana.dbc.squadsMultisig;
  if (multisig && address.equals(vaultOf(multisig))) {
    // the test network's stand-in owner co-signs the keeper's claims (config.devnetCoSignerKeypair is null outside devnet mode)
    const coSigner = config.devnetCoSignerKeypair ? loadKeypairFile(config.devnetCoSignerKeypair) : null;
    return SquadsVaultFeeClaimer.create({ multisigPda: multisig, keeper, coSigner });
  }
  throw new Error(`no claimer for fee claimer ${address.toBase58()}: it is neither the keeper key nor the vault of SQUADS_MULTISIG`);
}
