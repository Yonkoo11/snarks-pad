// Subprocess for test/zcash-intent-live.test.ts (audit O-4), with its own sqlite file:
//   setup <epochId> <json [{wallet, ua, zats}]>   an epoch whose swap has settled, with planned shielded rows
//   run                                            one runEpoch (it resumes that epoch and pays the shielded rows)
import * as db from "../../src/db";
import { runEpoch } from "../../src/epoch/engine";
import { simulatedSwapAdapter } from "../../src/swap/simulated";

const [mode, epochId, rowsJson] = process.argv.slice(2);
if (mode === "setup") {
  db.upsertEpoch({
    id: epochId!, at: new Date().toISOString(), coinMints: "[]", harvestedZats: "0", feeZats: "0", status: "ok",
    swapProvider: "simulated", swapRef: "stress-o4", swapState: "settled", swapAmountOutZats: "0", zcashTxids: "[]", includeShielded: 1,
  });
  for (const r of JSON.parse(rowsJson!) as { wallet: string; ua: string; zats: string }[]) {
    db.planPayout({ epochId: epochId!, wallet: r.wallet, kind: "shielded", amountZats: r.zats, zcashAddress: r.ua, flag: null });
  }
  console.log("setup done");
} else {
  const out = await runEpoch(simulatedSwapAdapter, async () => {});
  console.log("run done", out.epoch?.status ?? JSON.stringify(out));
}
process.exit(0);
