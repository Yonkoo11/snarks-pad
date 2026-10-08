// The "Creator wallet" field of the Launch form: what a person types turned into the one address the launch hands the pool to, or a
// plain reason why it cannot be. After the handover ONLY that wallet can claim the creator's share of the fee and own the creator's locked liquidity, and the launcher never
// can, so a typo strands both for good: the address must be a real wallet (a canonical base58 key on the ed25519 curve, which a program or a token account is not), and the
// form shows it back in full and asks for a tick before it sends it. The engine judges the same value again (engine/src/dbc/creatorWallet.ts) and also refuses the pad's own
// wallets, which only it knows. No network and no browser in this file.
import { PublicKey } from '@solana/web3.js'

export type CreatorWalletCheck =
  /** Nothing typed: the connected wallet stays the creator. */
  | { kind: 'none' }
  /** The connected wallet typed again: there is nothing to hand over. */
  | { kind: 'same' }
  /** A real wallet, different from the connected one: the address to hand the pool to. */
  | { kind: 'ok'; address: string }
  | { kind: 'bad'; error: string }

export const NOT_AN_ADDRESS = 'That is not a wallet address. A Solana address is 32 to 44 letters and digits.'
export const OFF_CURVE = 'That address belongs to a program or a token account, which cannot sign. Use a wallet address.'
export const SAME_WALLET = 'Same as your connected wallet: nothing to hand over.'

/** The key behind `raw` when it is a canonical base58 32-byte address (the form the engine takes: no padding, no other spelling of the same key), else null. */
function canonicalKey(raw: string): PublicKey | null {
  if (raw.length < 32 || raw.length > 44) return null
  try {
    const key = new PublicKey(raw)
    return key.toBase58() === raw ? key : null
  } catch {
    return null
  }
}

/** What the field holds, judged against the wallet that is connected (null while none is). Spaces around a pasted address are dropped, as a browser's paste often brings them. */
export function checkCreatorWallet(raw: string, connected: string | null): CreatorWalletCheck {
  const typed = raw.trim()
  if (typed === '') return { kind: 'none' }
  const key = canonicalKey(typed)
  if (!key) return { kind: 'bad', error: NOT_AN_ADDRESS }
  if (!PublicKey.isOnCurve(key.toBytes())) return { kind: 'bad', error: OFF_CURVE }
  const address = key.toBase58()
  return address === connected ? { kind: 'same' } : { kind: 'ok', address }
}
