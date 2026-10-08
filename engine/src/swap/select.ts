// Which swap adapter the epoch runs with: the simulated one locally, NEAR 1Click everywhere else. Shared by
// `bun run epoch` and the keeper loop so both refuse to start under the same conditions.
import { config } from "../config";
import { walletOwnsAddress } from "../zcash/devtool";
import { makeNear1ClickAdapter } from "./near1click";
import { simulatedSwapAdapter } from "./simulated";
import type { SwapAdapter } from "./types";

/** Devnet: the burn is real (stand-in ZEC), the Zcash side is a real testnet payment from the funding wallet into the pad's testnet treasury. Labelled "simulated". */
function selectDevnetSwapAdapter(): SwapAdapter {
  const treasuryAddress = process.env.TREASURY_ZCASH_ADDRESS;
  const walletDir = config.near1click.treasuryWalletDir;
  const { fundingWalletDir, fundingIdentityFile } = config.simulatedSwap;
  if (!treasuryAddress || !walletDir) throw new Error("PAD_MODE=devnet needs TREASURY_ZCASH_ADDRESS and TREASURY_WALLET_DIR (the pad's Zcash testnet treasury)");
  if (!fundingWalletDir || !fundingIdentityFile) throw new Error("PAD_MODE=devnet needs DEVNET_ZCASH_FUNDING_DIR and DEVNET_ZCASH_FUNDING_IDENTITY (the testnet wallet that pays the simulated swap's TAZ)");
  if (!walletOwnsAddress(walletDir, treasuryAddress)) throw new Error("TREASURY_ZCASH_ADDRESS is not an address of the wallet in TREASURY_WALLET_DIR");
  return simulatedSwapAdapter;
}

export function selectSwapAdapter(): SwapAdapter {
  if (config.isLocal) return simulatedSwapAdapter;
  if (config.mode === "devnet") return selectDevnetSwapAdapter();
  const treasuryAddress = process.env.TREASURY_ZCASH_ADDRESS;
  if (!treasuryAddress) {
    throw new Error(
      `PAD_MODE=${config.mode} needs TREASURY_ZCASH_ADDRESS set to the pad's real unified address; ` +
        "this build never wires one up automatically outside local mode.",
    );
  }
  // The swap pays this address and the settled amount is read from this wallet:
  // refuse to start unless the wallet really holds the address (INV-14).
  const walletDir = config.near1click.treasuryWalletDir;
  if (!walletDir) throw new Error("PAD_MODE needs TREASURY_WALLET_DIR: the treasury's zcash-devtool wallet directory");
  if (!walletOwnsAddress(walletDir, treasuryAddress)) throw new Error("TREASURY_ZCASH_ADDRESS is not an address of the wallet in TREASURY_WALLET_DIR; refusing to swap into it");
  return makeNear1ClickAdapter(treasuryAddress);
}
