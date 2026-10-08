// GET /api/wallets/:wallet docs/API.md v2.9: one wallet's public profile data from the database alone. Read-only, public, no chain read, no
// key (INV-17). The wallet is checked before anything is read, and what is sent is never echoed back in an error.
import { walletView } from "../dbc/walletView";
import { json } from "./common";
import { boardMints } from "./traderRoutes";
import { decodeWallet } from "./validate";

const WALLET_ROUTE = /^\/api\/wallets\/([^/]+)$/;

/** The route of this request if it is the wallet route; null for any other (the caller carries on). */
export function handleWalletRoute(req: Request, url: URL): Response | null {
  if (req.method !== "GET") return null;
  const match = WALLET_ROUTE.exec(url.pathname);
  if (!match) return null;
  // Every launched coin the pad has not hidden (moderation, PAD_HIDDEN_MINTS): the featured list curates the home board only, and must not empty a
  // creator's own page (the mainnet rehearsal runs with PAD_FEATURED_MINTS=none, which hid every coin from every profile).
  return json(walletView(decodeWallet(match[1]!), boardMints(true)));
}
