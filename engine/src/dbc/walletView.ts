// GET /api/wallets/:wallet docs/API.md v2.9: what the pad's own database says about one wallet, for the profile page: the coins it launched or
// is the Creator wallet of, the trades it made on this pad, and when it first appeared. No chain read and no RPC call, so the answer is as fast as a database
// query and survives a chain that cannot be read. Nothing here is about rewards or shielded delivery: those are the wallet's own and sit behind its signature
// (optin/registry.ts readOptinStatus). The coins and the trades follow the coin list's rule: launched coins only (a pending launch is nowhere on the pad), and
// only the coins the board lists (visible.ts).
import * as db from "../db";
import { coinBaseView } from "./read";
import { isHidden, visibleCoins } from "./visible";

/** The newest trades of the wallet that are listed. */
export const WALLET_TRADES_LIMIT = 50;

export interface WalletCoin {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string;
  /** Who launched it, and who receives the creator's share of its fee (the pad's record; the pool on chain is the final word, see GET /coins/:mint/creator-fees). */
  creator: string;
  creatorWallet: string;
  stage: "curve" | "graduated";
  createdAt: string;
  feeBps: number;
  creatorShareBps: number;
  /** Always "launched": a launch that was prepared and never confirmed is not listed. */
  status: "launched";
}

/** A trade of the wallet: the same amounts as a trade on the tape (a buy's `amountZec` is what was paid, a sell's what was received). */
export interface WalletTrade {
  sig: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  amountToken: string;
  amountZec: string;
  at: string;
}

export interface WalletView {
  wallet: string;
  launched: WalletCoin[];
  trades: WalletTrade[];
  /** The earlier of its first listed trade and its first listed coin; null for a wallet the pad has never recorded. */
  firstSeenAt: string | null;
}

const walletCoin = (row: db.CoinRow): WalletCoin => {
  const v = coinBaseView(row);
  return {
    mint: v.mint, name: v.name, symbol: v.symbol, imageUrl: v.imageUrl, creator: v.creator, creatorWallet: v.creatorWallet,
    stage: v.stage, createdAt: v.createdAt, feeBps: v.feeBps, creatorShareBps: v.creatorShareBps, status: "launched",
  };
};

const walletTrade = (r: db.FeedTradeRow): WalletTrade => ({ sig: r.sig, mint: r.mint, symbol: r.symbol, side: r.side, amountToken: r.amountToken, amountZec: r.amountZec, at: r.at });

/** The earlier of two ISO times (`at` and `createdAt` are always written with toISOString, so they compare as text); null when neither is known. */
const earlier = (a: string | null, b: string | null): string | null => (a === null ? b : b === null || a <= b ? a : b);

/** `board`: the mints a profile may show, null = every launched coin. The route passes every coin the pad has not hidden (walletRoutes.ts), not the featured list. */
export function walletView(wallet: string, board: string[] | null): WalletView {
  const launched = visibleCoins(db.listLaunchedCoinsOfWallet(wallet), false, board ?? []);
  const trades = db.listFeedTradesOfWallet(wallet, WALLET_TRADES_LIMIT, board).filter((r) => !isHidden(r.mint)).map(walletTrade);
  const oldestCoin = launched.at(-1)?.createdAt ?? null; // newest first, so the last one is the oldest
  return { wallet, launched: launched.map(walletCoin), trades, firstSeenAt: earlier(db.firstTradeAtOfWallet(wallet, board), oldestCoin) };
}
