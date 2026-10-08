// Explorer links for the network the pad is on. null where no public explorer shows the chain (a local validator, Zcash
// regtest and testnet), so the caller shows the id with its Copy button and no link.
import type { PadMode } from './types'

const LOCAL = encodeURIComponent('http://127.0.0.1:8899')

function cluster(mode: PadMode | null): string | null {
  if (mode === 'mainnet') return ''
  if (mode === 'devnet') return '?cluster=devnet'
  if (mode === 'local') return `?cluster=custom&customUrl=${LOCAL}`
  return null
}

export function solanaTxUrl(sig: string, mode: PadMode | null): string | null {
  const c = cluster(mode)
  return c === null ? null : `https://explorer.solana.com/tx/${sig}${c}`
}

export function solanaAccountUrl(address: string, mode: PadMode | null): string | null {
  const c = cluster(mode)
  return c === null ? null : `https://explorer.solana.com/address/${address}${c}`
}

/**
 * A wallet on Solscan, on the network the pad is on: the plain address on mainnet, `?cluster=devnet` on devnet, the local validator as a custom cluster on a local
 * stack. null while the network is not known yet (a link to the wrong network shows an empty account), so the caller leaves the link out.
 */
export function solscanAccountUrl(address: string, mode: PadMode | null): string | null {
  if (mode === 'mainnet') return `https://solscan.io/account/${address}`
  if (mode === 'devnet') return `https://solscan.io/account/${address}?cluster=devnet`
  if (mode === 'local') return `https://solscan.io/account/${address}?cluster=custom&customUrl=${LOCAL}`
  return null
}

/** A coin's token page on Solscan, on the pad's network; null while the network is not known (same rule as solscanAccountUrl). */
export function solscanTokenUrl(mint: string, mode: PadMode | null): string | null {
  if (mode === 'mainnet') return `https://solscan.io/token/${mint}`
  if (mode === 'devnet') return `https://solscan.io/token/${mint}?cluster=devnet`
  if (mode === 'local') return `https://solscan.io/token/${mint}?cluster=custom&customUrl=${LOCAL}`
  return null
}

export function zcashTxUrl(txid: string, network: 'regtest' | 'test' | 'main' | null): string | null {
  return network === 'main' ? `https://mainnet.zcashexplorer.app/transactions/${txid}` : null
}
