// Minimal injected-provider wallet: Phantom, Backpack, Solflare, plus a local test wallet
// (a real ed25519 key in this tab) that only exists when the app is not on mainnet.
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { Connection, VersionedTransaction } from '@solana/web3.js'
import { USE_REAL } from './api'
import { mockSend } from './mock'
import { sendAndWatch, type Landing } from './send'

interface Injected {
  publicKey?: { toBase58(): string } | null
  connect(): Promise<{ publicKey: { toBase58(): string } } | void>
  disconnect?(): Promise<void>
  signMessage(msg: Uint8Array, enc?: string): Promise<{ signature: Uint8Array } | Uint8Array>
  signTransaction<T>(tx: T): Promise<T>
}
type W = Window & { phantom?: { solana?: Injected & { isPhantom?: boolean } }; backpack?: Injected; solflare?: Injected & { isSolflare?: boolean } }

export interface WalletOption { id: string; name: string; installed: boolean; url?: string }

function injected(id: string): Injected | undefined {
  const w = window as W
  if (id === 'phantom') return w.phantom?.solana
  if (id === 'backpack') return w.backpack
  if (id === 'solflare') return w.solflare
}

export function walletOptions(allowTest: boolean): WalletOption[] {
  const list: WalletOption[] = [
    { id: 'phantom', name: 'Phantom', installed: !!injected('phantom'), url: 'https://phantom.com/download' },
    { id: 'backpack', name: 'Backpack', installed: !!injected('backpack'), url: 'https://backpack.app/download' },
    { id: 'solflare', name: 'Solflare', installed: !!injected('solflare'), url: 'https://solflare.com/download' },
  ]
  if (allowTest) list.push({ id: 'test', name: 'Test wallet (this tab only)', installed: true })
  return list
}

function testKeypair(): nacl.SignKeyPair {
  try {
    const s = sessionStorage.getItem('snarks-test-wallet')
    if (s) return nacl.sign.keyPair.fromSecretKey(bs58.decode(s))
  } catch { /* storage blocked */ }
  const kp = nacl.sign.keyPair()
  try { sessionStorage.setItem('snarks-test-wallet', bs58.encode(kp.secretKey)) } catch { /* ignore */ }
  return kp
}

class Wallet {
  address = $state<string | null>(null)
  kind = $state<string | null>(null)
  busy = $state(false)
  error = $state<string | null>(null)
  #provider: Injected | null = null
  #test: nacl.SignKeyPair | null = null

  async connect(id: string) {
    this.error = null; this.busy = true
    try {
      if (id === 'test') {
        this.#test = testKeypair(); this.#provider = null
        this.address = bs58.encode(this.#test.publicKey)
      } else {
        const p = injected(id)
        if (!p) throw new Error(`${id} is not installed in this browser`)
        const r = await p.connect()
        const pk = (r && r.publicKey) || p.publicKey
        if (!pk) throw new Error('The wallet did not share an address')
        this.#provider = p; this.#test = null
        this.address = pk.toBase58()
      }
      this.kind = id
    } catch (e) {
      this.error = friendly(e)
    } finally { this.busy = false }
  }

  async disconnect() {
    try { await this.#provider?.disconnect?.() } catch { /* ignore */ }
    this.#provider = null; this.#test = null; this.address = null; this.kind = null
  }

  /** utf8 message -> base58 ed25519 signature */
  async signMessage(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    if (this.#test) return bs58.encode(nacl.sign.detached(bytes, this.#test.secretKey))
    if (!this.#provider) throw new Error('Connect a wallet first')
    const r = await this.#provider.signMessage(bytes, 'utf8')
    return bs58.encode(r instanceof Uint8Array ? r : r.signature)
  }

  /** base64 unsigned versioned tx -> signed tx */
  async signTransaction(b64: string): Promise<VersionedTransaction> {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    if (this.#test) {
      tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), this.#test.secretKey)
      return tx
    }
    if (!this.#provider) throw new Error('Connect a wallet first')
    return this.#provider.signTransaction(tx)
  }

  /** Sign, then send and watch over plain HTTP (lib/send.ts): to the Solana cluster in real mode, to the mock's signature check otherwise. One signer: a trade or a claim. */
  async signAndSend(b64: string): Promise<Landing> {
    return this.#send(await this.signTransaction(b64))
  }

  /**
   * A launch (contract v2.9.1): the wallet signs first, as Phantom asks of a transaction with two signers (research/PHANTOM-WARNINGS.md); the page then
   * posts this copy to the engine, which checks it and adds the new coin's signature (engine dbc/cosign.ts), and sends what comes back with sendSigned.
   */
  async signOnly(b64: string): Promise<string> {
    const signed = await this.signTransaction(b64)
    let s = ''
    signed.serialize().forEach((b) => (s += String.fromCharCode(b)))
    return btoa(s)
  }

  /** Sends a transaction every signer has already signed (a launch after the engine's signature), and watches it land. */
  async sendSigned(b64: string): Promise<Landing> {
    return this.#send(VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
  }

  async #send(signed: VersionedTransaction): Promise<Landing> {
    if (!USE_REAL) return { status: 'confirmed', sig: mockSend(signed) }
    const rpc: string = import.meta.env.VITE_RPC || 'http://127.0.0.1:8899'
    return sendAndWatch(signed, new Connection(rpc, 'confirmed'))
  }
}

export function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/reject|denied|cancel/i.test(m)) return 'You closed the wallet prompt. Nothing was signed.'
  return m
}

export const wallet = new Wallet()
