// What a wallet holds of the pad's coins, for the profile's Holdings tab. Read in the browser through the connection the site is built with (the same one the buy box
// reads balances through, lib/holding.ts): the engine has no balance route and a profile costs it no RPC call. The pad's coins are Token-2022 mints, so one read of the
// wallet's Token-2022 accounts, kept to the mints the engine lists, is enough; Solana ZEC is a classic SPL token and is not among them.
import { Connection, PublicKey } from '@solana/web3.js'
import { api, USE_REAL } from './api'
import { holdingsOf, type Holding } from './profile'
import type { IndexCoin } from './types'

const RPC: string = import.meta.env.VITE_RPC || 'http://127.0.0.1:8899'
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
/** The coins asked for per page, and how many pages at most (a pad with more coins than this lists the newest). */
const PAGE = 100
const MAX_PAGES = 10

interface TokenAccount { mint: string; amount: string }
type ParsedInfo = { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }

/** Every coin the pad has not hidden, with the last price the engine read: one request, no chain read on the engine's side (GET /coins/index, audit S5-07). */
export async function padCoins(): Promise<IndexCoin[]> {
  return (await api.coinIndex()).coins
}

/** The wallet's Token-2022 accounts, mint and amount each. Rejects when the connection cannot answer. */
async function tokenAccountsOf(address: string): Promise<TokenAccount[]> {
  const conn = new Connection(RPC, 'confirmed')
  const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(address), { programId: TOKEN_2022_PROGRAM })
  return r.value.flatMap((a): TokenAccount[] => {
    const info = (a.account.data as ParsedInfo).parsed?.info
    return info?.mint && info.tokenAmount?.amount !== undefined ? [{ mint: info.mint, amount: info.tokenAmount.amount }] : []
  })
}

/** Mock only: any wallet holds the first two coins of the pad, 250,000 and 1,200,000 of them, so the tab and its rows can be seen. */
const mockAccounts = (coins: IndexCoin[]): TokenAccount[] =>
  coins.slice(0, 2).map((c, i) => ({ mint: c.mint, amount: String((i === 0 ? 250_000n : 1_200_000n) * 1_000_000n) }))

/** The pad's coins the wallet holds, largest value first. Rejects when the coin list or the wallet's token accounts cannot be read. */
export async function readHoldings(address: string): Promise<Holding[]> {
  const [coins, accounts] = await Promise.all([padCoins(), USE_REAL ? tokenAccountsOf(address) : Promise.resolve(null)])
  return holdingsOf(accounts ?? mockAccounts(coins), coins)
}
