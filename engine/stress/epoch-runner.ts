#!/usr/bin/env bun
// scripts/epoch.ts for the chaos runs (audit/STRESS-REPORT.md scenario 3). Same runEpoch; the only difference: with
// FAKE_1CLICK_URL set it swaps through the REAL near1click adapter pointed at stress/fake-1click-server.ts (whose quote
// signer it is told to trust) instead of the simulated adapter. Local mode only.
// Needs TREASURY_WALLET_DIR set to the regtest treasury wallet when FAKE_1CLICK_URL is set.
import { config } from "../src/config";
import { runEpoch } from "../src/epoch/engine";
import { selectSwapAdapter } from "../src/swap/select";
import { makeNear1ClickAdapter, walletReceipt } from "../src/swap/near1click";
import { makeOneClickClient } from "../src/swap/near1click-api";
import { defaultUnifiedAddress } from "../src/zcash/devtool";
import { TREASURY_DIR } from "../src/zcash/regtest";
import type { SwapAdapter } from "../src/swap/types";

if (!config.isLocal) throw new Error("the stress epoch runner is local-only");

async function adapter(): Promise<SwapAdapter> {
  const url = Bun.env.FAKE_1CLICK_URL;
  if (!url) return selectSwapAdapter();
  const { signer } = (await (await fetch(`${url}/__signer`)).json()) as { signer: string };
  return makeNear1ClickAdapter(defaultUnifiedAddress(TREASURY_DIR), {
    client: makeOneClickClient({ baseUrl: `${url}/v0` }),
    receivedByTreasury: walletReceipt(TREASURY_DIR),
    quoteSigner: signer,
  });
}

const out = await runEpoch(await adapter());
if (out.paused) console.log("paused:", out.paused);
else if (out.halted) console.log("halted:", out.halted.join("; "));
else if (out.awaitingClaims) console.log("epoch waiting:", out.awaitingClaims.join("; "));
else if (out.epoch) console.log("epoch", out.epoch.id, "status", out.epoch.status);
else console.log("no fees to claim this epoch; no epoch recorded");
process.exit(0);
