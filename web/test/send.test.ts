// lib/send.ts: a send is watched over plain HTTP and ends in confirmed, failed, expired or unknown. The connection here is a
// fake with a fake clock, so every outcome is reached without waiting.
import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type SignatureStatus } from '@solana/web3.js'
import { refusedBeforeSend, sendAndWatch, type SendConn, type WatchTiming } from '../src/lib/send'
import nacl from 'tweetnacl'

function signedTx(extra?: Keypair): { tx: VersionedTransaction; payer: Keypair } {
  const payer = Keypair.generate()
  const keys = extra ? [{ pubkey: extra.publicKey, isSigner: true, isWritable: false }] : []
  const ix = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys, data: Buffer.from('t') })
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(Keypair.generate().publicKey.toBytes()), instructions: [ix] }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([payer])
  return { tx, payer }
}

interface Script {
  /** The status answered on the n-th poll (0-based); past the end, the last entry. */
  statuses: (SignatureStatus | null)[]
  blockhashValid?: (calls: number) => boolean
  firstSendThrows?: string
  firstSendNetworkError?: boolean
  /** Status reads that fail (throw) on these 0-based calls. */
  failingReads?: number[]
}

function fakeConn(s: Script): SendConn & { sends: number; polls: number } {
  let polls = 0, bh = 0
  const conn = {
    sends: 0,
    get polls() { return polls },
    async sendRawTransaction() {
      conn.sends++
      if (conn.sends === 1 && s.firstSendThrows) throw new Error(s.firstSendThrows)
      if (conn.sends === 1 && s.firstSendNetworkError) throw new TypeError('Failed to fetch')
      return 'SIG'
    },
    async getSignatureStatuses() {
      if (s.failingReads?.includes(polls)) { polls++; throw new Error('429 Too Many Requests') }
      const st = s.statuses[Math.min(polls, s.statuses.length - 1)] ?? null
      polls++
      return { context: { slot: 1 }, value: [st] }
    },
    async isBlockhashValid() { return { context: { slot: 1 }, value: s.blockhashValid ? s.blockhashValid(bh++) : true } },
  }
  return conn as unknown as SendConn & { sends: number; polls: number }
}

function fakeClock(): Partial<WatchTiming> {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

const seen = (confirmationStatus: SignatureStatus['confirmationStatus'], err: unknown = null): SignatureStatus => ({ slot: 1, confirmations: 1, err: err as SignatureStatus['err'], confirmationStatus })

describe('sendAndWatch', () => {
  test('confirmed: answers as soon as the signature is confirmed, without resending', async () => {
    const conn = fakeConn({ statuses: [null, seen('confirmed')] })
    const { tx } = signedTx()
    expect(await sendAndWatch(tx, conn, fakeClock())).toEqual({ status: 'confirmed', sig: bs58.encode(tx.signatures[0]!) })
    expect(conn.sends).toBe(1)
  })

  test('failed: an error on chain is reported with the error, not as a timeout', async () => {
    const err = { InstructionError: [0, { Custom: 6002 }] }
    const { tx } = signedTx()
    const r = await sendAndWatch(tx, fakeConn({ statuses: [seen('processed', err)] }), fakeClock())
    expect(r).toEqual({ status: 'failed', sig: bs58.encode(tx.signatures[0]!), err })
  })

  test('unseen: the same bytes are sent again every few seconds', async () => {
    const conn = fakeConn({ statuses: [null, null, null, null, null, null, null, seen('finalized')] })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('confirmed')
    expect(conn.sends).toBeGreaterThanOrEqual(3)
  })

  test('seen but not yet confirmed: keeps polling and does not resend', async () => {
    const conn = fakeConn({ statuses: [seen('processed'), seen('processed'), seen('processed'), seen('processed'), seen('confirmed')] })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('confirmed')
    expect(conn.sends).toBe(1)
  })

  test('expired: never seen and its blockhash can no longer land it', async () => {
    const conn = fakeConn({ statuses: [null], blockhashValid: () => false })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('expired')
  })

  test('unknown: never seen while the blockhash still works when watching stops (it may still land)', async () => {
    const conn = fakeConn({ statuses: [null], blockhashValid: () => true })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('unknown')
  })

  test('a status read that fails at the end is "unknown", never "expired" (S5-03)', async () => {
    const conn = fakeConn({ statuses: [null], blockhashValid: () => false, failingReads: Array.from({ length: 200 }, (_, i) => i).filter((i) => i >= 6) })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('unknown')
  })

  test('a lagging node: seen on the last look after the blockhash died is still confirmed (S5-03)', async () => {
    const conn = fakeConn({ statuses: [...Array(7).fill(null), seen('confirmed')], blockhashValid: () => false })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('confirmed')
  })

  test('a network failure on the first send keeps watching and sends again, it does not throw (S5-04)', async () => {
    const conn = fakeConn({ statuses: [null, null, null, null, seen('confirmed')], firstSendNetworkError: true })
    expect((await sendAndWatch(signedTx().tx, conn, fakeClock())).status).toBe('confirmed')
    expect(conn.sends).toBeGreaterThanOrEqual(2)
  })

  test('a send the RPC refuses before sending throws, so the page can say nothing was charged', async () => {
    const conn = fakeConn({ statuses: [null], firstSendThrows: 'Simulation failed. Message: Transaction simulation failed: Blockhash not found.' })
    await expect(sendAndWatch(signedTx().tx, conn, fakeClock())).rejects.toThrow('Blockhash not found')
    expect(conn.polls).toBe(0)
  })
})

describe('refusedBeforeSend', () => {
  test('the rehearsal launch error (2026-10-06) reads as expired', () => {
    expect(refusedBeforeSend('Simulation failed. Message: Transaction simulation failed: Blockhash not found. Logs: []')).toBe('expired')
  })
  test('no SOL and no tokens are told apart', () => {
    expect(refusedBeforeSend('Attempt to debit an account but found no record of a prior credit.')).toBe('needs_sol')
    expect(refusedBeforeSend('Transfer: insufficient lamports 5000, need 10000')).toBe('needs_sol')
    expect(refusedBeforeSend('Program log: Error: insufficient funds')).toBe('short_of_token')
    expect(refusedBeforeSend('something else')).toBeNull()
  })
})

/** Every required signature checks out over the message (what the cluster and the web mock's mockSend check). */
function allSigned(tx: VersionedTransaction): boolean {
  const msg = tx.message.serialize()
  return Array.from({ length: tx.message.header.numRequiredSignatures }, (_, i) => i)
    .every((i) => nacl.sign.detached.verify(msg, tx.signatures[i]!, tx.message.staticAccountKeys[i]!.toBytes()))
}

describe('signing order (research/PHANTOM-WARNINGS.md): the wallet signs, then the coin key', () => {
  test('a launch transaction needs both signatures; the coin key signs after the wallet, over the same message', () => {
    const coin = Keypair.generate()
    const { tx } = signedTx(coin) // the wallet (payer) signed first
    expect(allSigned(tx)).toBe(false) // the coin key has not signed yet
    tx.sign([coin])
    expect(allSigned(tx)).toBe(true) // the wallet's signature still holds: both signed the same message
  })
})
