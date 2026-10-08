// What a trade pays on a coin's curve RIGHT NOW (contract v2.8 `feeNowBps`, `windowSecondsLeft` on GET /coins/:mint). Since v2.8.1 these come from the coin's own
// row and this server's clock, with no RPC call: the config's fee schedule stored at launch, the pool's activation point stored at confirm (or filled in by the
// coin's first chain read, dbc/read.ts), and the SDK's own fee helper over them (dbc/window.ts windowNowByClock). The clock is read one second back, so the
// countdown errs toward waiting. Read-only; the API imports it (INV-17).
import type { CoinRow } from "../db";
import type { CoinView } from "./read";
import { storedWindowOf, windowNowByClock } from "./window";

export interface LiveFee {
  /** The fee a trade landing now pays on the bonding curve, in bps. null once the coin has graduated (its pool's fee is `postGraduationFeeBps` plus a dynamic part) or while the coin's window facts are not known yet. */
  feeNowBps: number | null;
  /** Whole seconds until the launch window closes; 0 once it has. */
  windowSecondsLeft: number;
}

const GRADUATED: LiveFee = { feeNowBps: null, windowSecondsLeft: 0 };
const NOT_KNOWN: LiveFee = { feeNowBps: null, windowSecondsLeft: 0 };

/** The live fee of a coin's curve. A coin with no recorded config has no schedule: its tier fee, flat. */
export function liveFeeOf(coin: CoinRow, stage: CoinView["stage"], nowMs: number = Date.now()): LiveFee {
  if (stage === "graduated") return GRADUATED;
  if (!coin.configId) return { feeNowBps: coin.feeBps, windowSecondsLeft: 0 };
  const facts = storedWindowOf(coin);
  return facts ? windowNowByClock(facts.schedule, facts.activation, nowMs) : NOT_KNOWN;
}
