// One DAMM v2 client for the read-only views (quote, pot, fixed, pool vaults). getCpAmm() in ../solana.ts builds a new client on every
// call, which parses the program's large IDL (measured 35 ms on this Mac, against 0.15 ms for the quote it is built to compute), and a
// public route must not spend that per request. The client holds nothing but the connection and the program, so one is enough.
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { getConnection } from "../solana";

let client: CpAmm | null = null;

export function viewCpAmm(): CpAmm {
  client ??= new CpAmm(getConnection());
  return client;
}
