// Run as a subprocess by test/api-no-keeper.test.ts with KEEPER_KEYPAIR_PATH
// pointing into a directory that does not exist: any code path that tries to
// load the keeper key then throws, and the route answers 500. Prints one JSON
// line per route: [method, path, status].
import { handleRequest } from "../../src/api";

const mint = process.env.PROBE_MINT!;
const wallet = process.env.PROBE_WALLET!;
const sigOfNothing = "1".repeat(87); // a base58 signature-shaped string that no tx has

const requests: [string, string, unknown?][] = [
  ["GET", "/api/coins"],
  ["GET", `/api/coins/${mint}`],
  ["POST", "/api/coins/launch-tx", { creator: wallet, name: "Probe", symbol: "PRB", description: "", imageUrl: "", initialBuyZec: "1000000" }],
  ["POST", "/api/coins/confirm", { sig: sigOfNothing, mint }],
  ["POST", `/api/coins/${mint}/trade-tx`, { wallet, side: "buy", amount: "1000000", slippageBps: 100 }],
  ["POST", `/api/coins/${mint}/trade-confirm`, { sig: sigOfNothing }],
  ["GET", `/api/optin/nonce?wallet=${wallet}`],
  ["POST", "/api/optin/status", { wallet, nonce: "probe", signature: "1".repeat(87) }],
  ["GET", `/api/wallets/${wallet}`],
  ["GET", "/api/treasury"],
  ["GET", "/api/epochs"],
  ["POST", "/api/faucet", { wallet }],
  ["GET", "/api/nope"],
  // contract v2.6: the trader panel, the tape, the rewards of a wallet, the memo check and the CSV
  ["GET", `/api/coins/${mint}/quote?side=buy&amount=1000000`],
  ["GET", `/api/coins/${mint}/holders`],
  ["GET", `/api/coins/${mint}/pot`],
  ["GET", `/api/coins/${mint}/fixed`],
  ["GET", `/api/coins/${mint}/trades`],
  ["GET", "/api/trades"],
  ["GET", `/api/rewards/${wallet}`],
  ["POST", "/api/rewards/verify-memo", { memo: "SNARKS pad reward, epoch epoch-none" }],
  ["GET", "/api/epochs.csv"],
  ["GET", "/api/events/trades"],
];

for (const [method, path, body] of requests) {
  const res = await handleRequest(new Request(`http://localhost${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }));
  console.log(JSON.stringify([method, path.split("?")[0]!.replace(mint, ":mint").replace(wallet, ":wallet"), res.status]));
}
process.exit(0);
