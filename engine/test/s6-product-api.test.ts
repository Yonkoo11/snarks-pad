// Audit S6, product decisions 3 and 5 at the API:
//   3  a Creator wallet on a tier whose creator share is 0 (mainnet's only tier) is refused: there is nothing to hand over but a
//      name, and the named wallet never signed for it (the site does not send the field on such a tier; this is the backstop).
//   5  the chain routes together stop making chain reads past an hourly ceiling (503 busy, retry-after, one alert per episode),
//      after the per-address limit, so a flood from many addresses costs at most the ceiling of the API's own RPC budget.
// No chain: both refusals come before any chain read.
import { afterAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { handleRequest, setChainRouteCeilingForTests } from "../src/api";
import { config } from "../src/config";
import * as db from "../src/db";

const B = "http://pad.test/api";
const key = () => Keypair.generate().publicKey.toBase58();
const post = (path: string, body: unknown, ip: string | null = "203.0.113.70") => handleRequest(new Request(`${B}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { ip });

describe("decision 3: a creator wallet is refused where the tier has no creator share", () => {
  test("the 1% tier (the default and mainnet's only one) with another wallet named: 400 creator_wallet_no_share, before any chain read", async () => {
    const r = await post("/coins/launch-tx", { creator: key(), name: "Named", symbol: "NMD", description: "", imageUrl: "", creatorWallet: key() });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "creator_wallet_no_share", field: "creatorWallet" });
  });

  test("the launcher's own wallet, or no wallet, is not a handover and passes this check (what the site sends)", async () => {
    const creator = key();
    for (const body of [{ creatorWallet: creator }, {}]) {
      const r = await post("/coins/launch-tx", { creator, name: "Named", symbol: "NMD", description: "", imageUrl: "", ...body, feeTier: 12_345 });
      expect(await r.json()).toEqual({ error: "bad_request", field: "feeTier" }); // the next check in line: the tier (the share rule needs a known tier)
    }
  });

  test("the wallet's shape is checked before the tier, as the contract states; the share rule only after a known tier", async () => {
    const r = await post("/coins/launch-tx", { creator: key(), name: "Named", symbol: "NMD", description: "", imageUrl: "", creatorWallet: "abc", feeTier: 3 });
    expect(await r.json()).toEqual({ error: "bad_creator_wallet", field: "creatorWallet" });
    const r2 = await post("/coins/launch-tx", { creator: key(), name: "Named", symbol: "NMD", description: "", imageUrl: "", creatorWallet: key(), feeTier: 3 });
    expect(await r2.json()).toEqual({ error: "bad_request", field: "feeTier" });
  });

  test("a wallet that is not a wallet is still bad_creator_wallet", async () => {
    const r = await post("/coins/launch-tx", { creator: key(), name: "Named", symbol: "NMD", description: "", imageUrl: "", creatorWallet: "not-a-wallet" });
    expect(await r.json()).toEqual({ error: "bad_creator_wallet", field: "creatorWallet" });
  });
});

describe("decision 5: the API's chain routes have an hourly ceiling", () => {
  afterAll(() => setChainRouteCeilingForTests(config.api.chainRouteCeilingPerHour));

  test("the default is 3,000 an hour", () => {
    expect(config.api.chainRouteCeilingPerHour).toBe(3_000);
  });

  test("past the ceiling every chain route answers 503 busy with retry-after from any address, an alert is recorded once, loopback is never counted", async () => {
    setChainRouteCeilingForTests(2);
    const fees = (ip: string | null) => handleRequest(new Request(`${B}/coins/${key()}/creator-fees`), { ip });
    expect((await fees("203.0.113.71")).status).toBe(404); // passes the ceiling, then an unknown mint: no chain read
    expect((await fees("203.0.113.72")).status).toBe(404);
    const refused = await fees("203.0.113.73");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "busy" });
    expect(Number(refused.headers.get("retry-after")) >= 1).toBe(true);
    expect((await post(`/coins/${key()}/trade-tx`, { wallet: key(), side: "buy", amount: "1" }, "203.0.113.74")).status).toBe(503);
    expect((await post(`/coins/${key()}/creator-claim-tx`, { wallet: key() }, "203.0.113.75")).status).toBe(503);
    expect((await fees("127.0.0.1")).status).toBe(404); // the operator's own calls
    const open = db.listOpenAlerts().filter((a) => a.kind === "api_chain_ceiling");
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toContain("reached 2 reads this hour");
  });
});
