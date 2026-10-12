// Read-only: each launched coin's unclaimed partner fee, split by where it sits (the DBC curve, which a claim can cap, and the DAMM v2 position, which a claim takes whole).
import * as db from "../src/db";
import { accruedFees } from "../src/dbc/pot";

for (const coin of db.listCoins()) {
  if (coin.status !== "launched" || !coin.poolId) continue;
  const a = await accruedFees(coin);
  console.log(`${coin.symbol.padEnd(10)} curve ${String(a.curve).padStart(12)} zats  damm ${String(a.pool).padStart(12)} zats  ${coin.dammPool ? "graduated" : "on curve"}`);
}
