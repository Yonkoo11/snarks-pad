// Sending a signed transaction and learning whether it landed, over plain HTTP.
// Not web3.js confirmTransaction: that waits on a signatureSubscribe websocket, and the mainnet browser connection (Alchemy) has none
// (tested 2026-10-06: "Method 'signatureSubscribe' not found"). It then reported "not confirmed in 30 seconds" for a launch that had
// landed, and the page never recorded it. Here the first send keeps the RPC's own check (a stale blockhash or a short balance is refused
// before anything is sent), then the signature is polled, the same bytes are sent again every few seconds while nothing is seen, and a
// signature still unseen at the end is "expired" only when its blockhash can no longer land, "unknown" otherwise.
import bs58 from 'bs58'
import type { Connection, SignatureStatus, VersionedTransaction } from '@solana/web3.js'

export type Landing =
  | { status: 'confirmed'; sig: string }
  | { status: 'failed'; sig: string; err: unknown }
  | { status: 'expired'; sig: string }
  | { status: 'unknown'; sig: string }

export type SendConn = Pick<Connection, 'sendRawTransaction' | 'getSignatureStatuses' | 'isBlockhashValid'>

export interface WatchTiming {
  pollMs: number
  resendMs: number
  /** How long to watch before answering; a blockhash lasts about 60 to 90 seconds. */
  watchMs: number
  /** No blockhash check before this: the transaction was just sent with a fresh one. */
  blockhashCheckAfterMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export const DEFAULT_TIMING: WatchTiming = {
  pollMs: 1_500,
  resendMs: 4_000,
  watchMs: 90_000,
  blockhashCheckAfterMs: 10_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}

const landed = (s: SignatureStatus | null | undefined): boolean =>
  !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')

/** The status of one signature, or undefined when the read failed (the next poll asks again). */
async function statusOf(conn: SendConn, sig: string, history: boolean): Promise<SignatureStatus | null | undefined> {
  try {
    return (await conn.getSignatureStatuses([sig], { searchTransactionHistory: history })).value[0]
  } catch {
    return undefined
  }
}

/** Whether the transaction's blockhash can still land it; true when the read fails (nobody can say it expired). */
async function blockhashAlive(conn: SendConn, blockhash: string): Promise<boolean> {
  try {
    return (await conn.isBlockhashValid(blockhash, { commitment: 'confirmed' })).value
  } catch {
    return true
  }
}

function settled(sig: string, s: SignatureStatus | null | undefined): Landing | null {
  if (s?.err) return { status: 'failed', sig, err: s.err }
  return landed(s) ? { status: 'confirmed', sig } : null
}

/**
 * One last look with the full history once watching stops or the blockhash has run out: three reads, a poll apart, because a node that lags can miss a
 * transaction that landed in the last valid block (audit S5-03). "expired" only when every read worked, none saw it, and the blockhash is dead; a read that
 * fails means nobody can say it did not land, so "unknown".
 */
async function finalLook(conn: SendConn, sig: string, blockhash: string, t: WatchTiming): Promise<Landing> {
  let seen = false
  for (let i = 0; i < 3; i++) {
    await t.sleep(t.pollMs)
    const s = await statusOf(conn, sig, true)
    if (s === undefined) return { status: 'unknown', sig }
    const done = settled(sig, s)
    if (done) return done
    if (s) seen = true
  }
  if (seen) return { status: 'unknown', sig } // seen but not yet confirmed: it may still confirm
  return (await blockhashAlive(conn, blockhash)) ? { status: 'unknown', sig } : { status: 'expired', sig }
}

/** Whether a failed first send was the RPC refusing the transaction (nothing was sent) rather than the network (it may have been forwarded). */
export function refusedByRpc(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  return /SendTransactionError|simulation failed|failed to send transaction|blockhash not found|insufficient|custom program error|signature verification/i.test(m)
}

/**
 * Sends a signed transaction and watches it land. Throws only when the RPC refused the first send (nothing was sent, nothing was charged);
 * after that, and after a first send the network lost, it always answers with a Landing.
 */
export async function sendAndWatch(signed: VersionedTransaction, conn: SendConn, timing: Partial<WatchTiming> = {}): Promise<Landing> {
  const t: WatchTiming = { ...DEFAULT_TIMING, ...timing }
  const raw = signed.serialize()
  const blockhash = signed.message.recentBlockhash
  const sig = bs58.encode(signed.signatures[0]!) // a transaction's id is its fee payer's signature, known before it is sent
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
  } catch (e) {
    if (refusedByRpc(e)) throw e
    // the network failed during the send (audit S5-04): it may have been forwarded, so watch it like any other; the loop sends it again
  }
  const start = t.now()
  let lastSend = start
  let lastBlockhashCheck = start
  while (t.now() - start < t.watchMs) {
    await t.sleep(t.pollMs)
    const s = await statusOf(conn, sig, false)
    const done = settled(sig, s)
    if (done) return done
    if (s) continue // seen, not yet confirmed: keep polling, no resend needed
    if (t.now() - lastSend >= t.resendMs) {
      lastSend = t.now()
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined)
    }
    if (t.now() - start >= t.blockhashCheckAfterMs && t.now() - lastBlockhashCheck >= t.resendMs) {
      lastBlockhashCheck = t.now()
      if (!(await blockhashAlive(conn, blockhash))) return finalLook(conn, sig, blockhash, t)
    }
  }
  return finalLook(conn, sig, blockhash, t)
}

/** What a send refused before sending, in plain words; null when the message is not one of these. */
export function refusedBeforeSend(message: string): 'expired' | 'needs_sol' | 'short_of_token' | null {
  if (/blockhash not found|block height exceeded|blockhash.*expired/i.test(message)) return 'expired'
  if (/insufficient lamports|insufficientfundsforfee|insufficientfundsforrent|no record of a prior credit|accountnotfound/i.test(message)) return 'needs_sol'
  if (/insufficient funds|custom program error: 0x1\b/i.test(message)) return 'short_of_token'
  return null
}

export const EXPIRED_TEXT = 'Your wallet approval took longer than Solana allows (about a minute), so nothing was sent and nothing was charged. Try again.'
