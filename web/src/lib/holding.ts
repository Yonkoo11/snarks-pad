// What a connected wallet holds of a coin and of Solana ZEC, so the box can size a sell and say when a buy is short.
// Real mode reads the public token accounts over the RPC the site is built with; the mock answers fixed amounts so
// the states can be seen. null = not known (no RPC answer, or no ZEC mint known on this network), never 0.
import { Connection, PublicKey } from '@solana/web3.js'
import { USE_REAL } from './api'

export interface Balances {
  token: bigint | null // base units of the coin
  zec: bigint | null // zats of Solana ZEC
}

const RPC: string = import.meta.env.VITE_RPC || 'http://127.0.0.1:8899'

async function tokenBalance(conn: Connection, owner: PublicKey, mint: string): Promise<bigint | null> {
  try {
    const r = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
    let sum = 0n
    for (const a of r.value) {
      const info = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount
      if (info) sum += BigInt(info)
    }
    return sum
  } catch { return null }
}

/** Mock only: a wallet that holds 250,000 of the coin and 0.3 ZEC, so a 0.1 buy fits and the 0.5 / 1 / 5 presets show the short state. */
const MOCK: Balances = { token: 250_000n * 1_000_000n, zec: 30_000_000n }

export async function readBalances(wallet: string, mint: string, quoteMint: string | null): Promise<Balances> {
  if (!USE_REAL) return MOCK
  let owner: PublicKey
  try { owner = new PublicKey(wallet) } catch { return { token: null, zec: null } }
  const conn = new Connection(RPC, 'confirmed')
  const [token, zec] = await Promise.all([tokenBalance(conn, owner, mint), quoteMint ? tokenBalance(conn, owner, quoteMint) : Promise.resolve(null)])
  return { token, zec }
}

/** Just the wallet's Solana ZEC, in zats, for the Launch page's Max: the pad's own quote mint (GET /tiers) names the token on every network. null = not known (no mint named, no RPC answer), never 0. */
export async function readZecBalance(wallet: string, quoteMint: string | null): Promise<bigint | null> {
  if (!USE_REAL) return MOCK.zec
  if (!quoteMint) return null
  let owner: PublicKey
  try { owner = new PublicKey(wallet) } catch { return null }
  return tokenBalance(new Connection(RPC, 'confirmed'), owner, quoteMint)
}
