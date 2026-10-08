// What the site does with a launch transaction docs/API.md v2.9.1, dbc/cosign.ts): the creator's wallet signs first, then
// POST /coins/launch-cosign checks the transaction against what the engine built and adds the coin's own signature. A chain test that
// sends a launch built by POST /coins/launch-tx goes through here; sending the wallet-signed transaction alone fails signature verification.
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { handleRequest } from "../../src/api";

export async function cosignedLaunch(txBase64: string, mint: string, signer: Keypair, ctx: { ip: string | null } = { ip: null }): Promise<VersionedTransaction> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  tx.sign([signer]);
  const body = JSON.stringify({ mint, tx: Buffer.from(tx.serialize()).toString("base64") });
  const res = await handleRequest(new Request("http://pad.test/api/coins/launch-cosign", { method: "POST", body, headers: { "content-type": "application/json" } }), ctx);
  if (res.status !== 200) throw new Error(`launch-cosign answered ${res.status}: ${await res.text()}`);
  const { tx: signed } = (await res.json()) as { tx: string };
  return VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
}
