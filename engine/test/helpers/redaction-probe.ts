// Subprocess for test/devnet-wiring.test.ts: talks to a dead RPC whose URL carries a key and fails every way an engine
// process can fail, to see what reaches stdout/stderr. The key itself is only ever in env/URL, never printed here.
import { config } from "../../src/config";
import { getConnection } from "../../src/solana";

console.log("mode", config.mode);
try {
  await getConnection().getVersion();
} catch (err) {
  console.error("caught:", err); // as scripts/epoch.ts does
  console.error(`as text: ${(err as Error).message}`);
}
console.error("a url on its own line", process.env.SOLANA_DEVNET_RPC);
throw new Error(`uncaught, carries ${process.env.SOLANA_DEVNET_RPC}`); // the runtime's own uncaught-error printing
