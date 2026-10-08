// Which coins the public lists show (config.api.featuredMints, config.api.hiddenMints). A listing filter only: nothing is deleted or blocked on chain.
import { config } from "../config";

/**
 * The listed coins. Hidden coins (moderation) are never listed, `all` included. Then: all the rest when no featured list is set or `all` is asked for, else
 * only the featured mints (order kept).
 */
export function visibleCoins<T extends { mint: string }>(coins: T[], all: boolean, featured: string[] = config.api.featuredMints, hidden: string[] = config.api.hiddenMints): T[] {
  const shown = hidden.length === 0 ? coins : coins.filter((c) => !hidden.includes(c.mint));
  if (all || featured.length === 0) return shown;
  const keep = new Set(featured);
  return shown.filter((c) => keep.has(c.mint));
}

/** Whether the pad keeps this coin off its lists. */
export const isHidden = (mint: string, hidden: string[] = config.api.hiddenMints): boolean => hidden.includes(mint);
