// Waits out a pool's launch window on the chain's own clock. For scripts and tests that launch a coin and then trade it: a trade inside the first seconds pays the
// window's fee (dbc/window.ts), so a script that wants the tier's fee, or a test that checks an exact fee, waits here first. It is the wait the Coin page shows a person
// ("Wait 3 s"), made once by code. Read-only: it signs nothing.
import { PublicKey } from "@solana/web3.js";
import { getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as db from "../db";
import { getConnection, getDbcClient } from "../solana";
import { withBlockRetry } from "./trade";
import { configScheduleOf, hasWindow, launchWindowOf } from "./window";

/**
 * Resolves once the chain's clock is `marginSeconds` past the end of the launch window of `pool` (a DBC pool address), so every transaction sent afterwards pays the
 * coin's tier fee. Returns at once for a pool whose config has no window. Throws when the pool or its config cannot be read, or the chain's clock does not get there
 * within `timeoutMs` (a window is seconds long: a minute means the chain has stopped).
 */
export async function waitForWindowToClose(pool: string | PublicKey, marginSeconds = 1, timeoutMs = 60_000): Promise<void> {
  const virtualPool = await getDbcClient().state.getPool(pool);
  if (!virtualPool) throw new Error(`DBC pool ${String(pool)} not found`);
  const schedule = await configScheduleOf(virtualPool.poolState.config);
  const window = hasWindow(schedule) ? launchWindowOf(schedule, virtualPool.poolState.activationPoint) : null;
  if (!window) return;
  const until = Math.floor(Date.parse(window.endsAt) / 1000) + marginSeconds;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = Number((await withBlockRetry(() => getCurrentPoint(getConnection(), schedule.activationType))).toString());
    if (now >= until) return;
    if (Date.now() > deadline) throw new Error(`the chain's clock is ${until - now} s short of the end of the launch window after ${timeoutMs} ms`);
    await Bun.sleep(400);
  }
}

/** `waitForWindowToClose` for a coin the database knows as launched (what a script has after `confirmLaunch`): the same wait, by mint. */
export async function waitForCoinWindow(mint: string, marginSeconds = 1): Promise<void> {
  const coin = db.getCoin(mint);
  if (!coin?.poolId) throw new Error(`coin ${mint} is not launched: there is no pool to wait on`);
  await waitForWindowToClose(coin.poolId, marginSeconds);
}
