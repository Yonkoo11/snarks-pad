// How much quote (ZEC zats) a buy on a DBC curve can still take. An exact-in swap larger than the room the curve has left is
// refused by the program ("Insufficient Liquidity"), so QA helpers that need a big buy clamp to this instead of guessing.

/** 95% of the room left under the migration threshold (the pool fee is taken from the input); 0 when the curve is full. */
export function curveRoomZats(migrationQuoteThreshold: bigint, quoteReserve: bigint): bigint {
  const left = migrationQuoteThreshold - quoteReserve;
  return left > 0n ? (left * 95n) / 100n : 0n;
}
