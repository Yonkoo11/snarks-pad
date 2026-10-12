// One client for the engine API docs/API.md v2.9. VITE_API=real talks to the engine;
// anything else uses the in-browser mock, which implements the same contract.
import type {
  Coin, CoinDetail, CreatorFees, Epoch, FeedTrade, Fixed, Holders, LaunchInput, MemoCheck, OptinError, OptinStatus, PadMode, PadPot, Pot, PricePoint, Quote, Rewards, Stats,
  Tier, Treasury, TradeQuote, UploadedImage, WalletProfile,
  IndexCoin,
} from './types'
import type { CoinQuery } from './coins'
import { mock } from './mock'

export const USE_REAL = import.meta.env.VITE_API === 'real'
const BASE: string = import.meta.env.VITE_API_BASE || 'http://localhost:8787/api'

/** An absolute URL for a path the engine returned (such as a snapshot url "/api/epochs/..."), on the same origin as the API. */
export function apiUrl(path: string): string {
  return new URL(BASE, location.href).origin + path
}

import { EXPIRED_TEXT, refusedBeforeSend } from './send'

export class ApiError extends Error {
  // `field` names what the engine refused (a request field, or `socials.x` for one link), when it says
  constructor(public status: number, public code: string, public field?: string) { super(code) }
}
/** An engine before this route existed answers 404 not_found: the UI hides that block instead of showing an error. */
export const routeAbsent = (e: unknown): boolean => e instanceof ApiError && e.status === 404 && e.code === 'not_found'

type ModeListener = (m: PadMode) => void
const listeners = new Set<ModeListener>()
// Mock only: open the app with ?devnet=1 to see the devnet banner and its faucet button (the mock's ?faucet=dry and ?faucet=race show a faucet without test money).
let lastMode: PadMode | null = USE_REAL ? null : /[?&]devnet=1/.test(location.href) ? 'devnet' : 'local'
export function onMode(fn: ModeListener): () => void {
  listeners.add(fn)
  if (lastMode) fn(lastMode)
  return () => listeners.delete(fn)
}
function setMode(m: string | null) {
  if (m !== 'local' && m !== 'devnet' && m !== 'mainnet') return
  if (m === lastMode) return
  lastMode = m
  listeners.forEach((fn) => fn(m))
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'unreachable')
  }
  setMode(res.headers.get('x-pad-mode'))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw refusal(res.status, data)
  return data as T
}

/** The error for a non-2xx answer: the engine's own `{ error, field? }` when it sent one. */
function refusal(status: number, data: unknown): ApiError {
  const d = (data ?? {}) as { error?: string; field?: string }
  return new ApiError(status, d.error || `http_${status}`, d.field)
}

/** POST /uploads (v2.7): one multipart field `file`. Not through http(): the browser must set the content type, with its boundary. */
async function postUpload(file: File): Promise<UploadedImage> {
  const body = new FormData()
  body.append('file', file)
  let res: Response
  try {
    res = await fetch(BASE + '/uploads', { method: 'POST', body })
  } catch {
    throw new ApiError(0, 'unreachable')
  }
  setMode(res.headers.get('x-pad-mode'))
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw refusal(res.status, data)
  return data as UploadedImage
}

export interface Api {
  // v2.5 takes sort, stage, q, limit and offset and answers with `total`; a v2.4 engine ignores the query and returns every coin with no total.
  coins(q?: CoinQuery): Promise<{ coins: Coin[]; total?: number }>
  coinIndex(): Promise<{ coins: IndexCoin[] }>
  // v2.5, pad-wide numbers; a v2.4 engine answers 404 not_found and the page computes what it can from /coins and /epochs.
  stats(): Promise<Stats>
  padPot(): Promise<PadPot>
  coin(mint: string): Promise<CoinDetail>
  priceHistory(mint: string): Promise<{ points: PricePoint[] }>
  // v2.7 adds `quoteMint` (the token the pad's coins are paired with on this network, so the launch page can read the wallet's balance of it) and, on every tier, the graduation threshold and the locked-liquidity shares
  tiers(): Promise<{ tiers: Tier[]; quoteMint?: string }>
  creatorFees(mint: string): Promise<CreatorFees>
  // An unsigned claim for the coin's creator to sign and send; the pad signs nothing and holds nothing here. 403 not_creator for any other wallet.
  creatorClaimTx(mint: string, wallet: string, kind?: 'curve' | 'pool'): Promise<{ tx: string; kind: 'curve' | 'pool'; claimableZats: string }>
  // v2.7: the coin's picture from the creator's device. Answers where the engine stored it; that address is what launchTx takes as imageUrl.
  upload(file: File): Promise<UploadedImage>
  launchTx(input: LaunchInput): Promise<{ tx: string; mint: string }>
  // v2.9.1: the creator's wallet signed the launch; the engine checks it and adds the coin's signature
  launchCosign(mint: string, tx: string): Promise<{ tx: string }>
  confirmLaunch(sig: string, mint: string): Promise<{ ok: boolean }>
  tradeConfirm(mint: string, sig: string): Promise<{ ok: boolean }>
  tradeTx(mint: string, body: { wallet: string; side: 'buy' | 'sell'; amount: string; slippageBps: number; referrer?: string }): Promise<{ tx: string; quote: TradeQuote }>
  optinNonce(wallet: string): Promise<{ nonce: string; message: string }>
  optin(body: { wallet: string; zcashAddress: string; nonce: string; signature: string }): Promise<{ ok: true; registeredAt: string }>
  optout(body: { wallet: string; nonce: string; signature: string }): Promise<{ ok: true }>
  // v2.9 (signed reads): the wallet's own shielded delivery, only against its fresh signature over shieldedViewMessage (a nonce from optinNonce, used once). There is no unsigned read: 400 invalid_signature or stale_nonce when it is refused.
  optinStatus(body: { wallet: string; nonce: string; signature: string }): Promise<OptinStatus>
  // v2.9: the profile page's data about one wallet, from the engine's database alone: the coins it launched or is paid creator fees of, its recorded trades, when it first appeared.
  wallet(wallet: string): Promise<WalletProfile>
  treasury(): Promise<Treasury>
  epochs(): Promise<{ epochs: Epoch[] }>
  // devnet only: the engine answers 404 anywhere else
  faucet(wallet: string): Promise<{ ok: true; sol: number; zecZats: string }>
  // v2.6 docs/API.md "Trader panel, live trades, rewards and ledgers"): read-only views. A v2.5 engine answers 404 not_found and
  // the UI hides the block (routeAbsent); a chain that cannot be read is 503 chain_unavailable.
  quote(mint: string, q: { side: 'buy' | 'sell'; amount: string; slippageBps: number }): Promise<Quote>
  holders(mint: string, q?: { limit?: number; offset?: number }): Promise<Holders>
  pot(mint: string): Promise<Pot>
  fixed(mint: string): Promise<Fixed>
  // the newest recorded trades: the board's (GET /trades) or one coin's (GET /coins/:mint/trades)
  trades(q: { limit?: number; mint?: string }): Promise<{ trades: FeedTrade[] }>
  // the SSE stream's URL (GET /events/trades, `event: trade`, data = one FeedTrade); null where there is no stream (the mock), so the caller polls
  tradeStreamUrl(mint?: string): string | null
  rewards(wallet: string, q?: { limit?: number; offset?: number }): Promise<Rewards>
  // the memo of a shielded note, with an optional txid and an optional signed proof of wallet ownership (receiptMessage)
  verifyMemo(body: { memo: string; txid?: string; wallet?: string; nonce?: string; signature?: string }): Promise<MemoCheck>
  // the address of the one-row-per-round CSV, or null when this engine has none
  epochsCsv(): Promise<string | null>
}

// The public list shows the server's featured coins; open the site with ?all=1 (before or after the #) to list every launched coin.
const wantsAll = (): boolean => /[?&]all=1(&|$)/.test(location.search) || /[?&]all=1(&|$)/.test(location.hash)
function coinsPath(q?: CoinQuery): string {
  const p = new URLSearchParams()
  if (wantsAll() || q?.all) p.set('all', '1')
  if (q?.sort) p.set('sort', q.sort)
  if (q?.stage) p.set('stage', q.stage)
  if (q?.q) p.set('q', q.q)
  if (q?.limit !== undefined) p.set('limit', String(q.limit))
  if (q?.offset) p.set('offset', String(q.offset))
  const s = p.toString()
  return s ? `/coins?${s}` : '/coins'
}

function pageQuery(q?: { limit?: number; offset?: number }): string {
  const p = new URLSearchParams()
  if (q?.limit !== undefined) p.set('limit', String(q.limit))
  if (q?.offset) p.set('offset', String(q.offset))
  const s = p.toString()
  return s ? `?${s}` : ''
}

const real: Api = {
  coins: (q) => http('GET', coinsPath(q)),
  coinIndex: () => http('GET', '/coins/index'),
  stats: () => http('GET', '/stats'),
  padPot: () => http('GET', '/pot'),
  coin: (mint) => http('GET', `/coins/${encodeURIComponent(mint)}`),
  priceHistory: (mint) => http('GET', `/coins/${encodeURIComponent(mint)}/price-history`),
  tiers: () => http('GET', '/tiers'),
  creatorFees: (mint) => http('GET', `/coins/${encodeURIComponent(mint)}/creator-fees`),
  creatorClaimTx: (mint, wallet, kind) => http('POST', `/coins/${encodeURIComponent(mint)}/creator-claim-tx`, { wallet, ...(kind ? { kind } : {}) }),
  upload: (file) => postUpload(file),
  launchTx: (input) => http('POST', '/coins/launch-tx', input),
  launchCosign: (mint, tx) => http('POST', '/coins/launch-cosign', { mint, tx }),
  confirmLaunch: (sig, mint) => http('POST', '/coins/confirm', { sig, mint }),
  tradeConfirm: (mint, sig) => http('POST', `/coins/${encodeURIComponent(mint)}/trade-confirm`, { sig }),
  tradeTx: (mint, body) => http('POST', `/coins/${encodeURIComponent(mint)}/trade-tx`, body),
  optinNonce: (wallet) => http('GET', `/optin/nonce?wallet=${encodeURIComponent(wallet)}`),
  optin: (body) => http('POST', '/optin', body),
  optout: (body) => http('DELETE', '/optin', body),
  optinStatus: (body) => http('POST', '/optin/status', body),
  wallet: (wallet) => http('GET', `/wallets/${encodeURIComponent(wallet)}`),
  treasury: () => http('GET', '/treasury'),
  epochs: () => http('GET', '/epochs'),
  faucet: (wallet) => http('POST', '/faucet', { wallet }),
  quote: (mint, q) => http('GET', `/coins/${encodeURIComponent(mint)}/quote?side=${q.side}&amount=${encodeURIComponent(q.amount)}&slippageBps=${q.slippageBps}`),
  holders: (mint, q) => http('GET', `/coins/${encodeURIComponent(mint)}/holders${pageQuery(q)}`),
  pot: (mint) => http('GET', `/coins/${encodeURIComponent(mint)}/pot`),
  fixed: (mint) => http('GET', `/coins/${encodeURIComponent(mint)}/fixed`),
  trades: (q) => {
    const limit = q.limit !== undefined ? `?limit=${q.limit}` : ''
    return http('GET', q.mint ? `/coins/${encodeURIComponent(q.mint)}/trades${limit}` : `/trades${limit}`)
  },
  tradeStreamUrl: (mint) => `${BASE}/events/trades${mint ? `?mint=${encodeURIComponent(mint)}` : ''}`,
  rewards: (wallet, q) => http('GET', `/rewards/${encodeURIComponent(wallet)}${pageQuery(q)}`),
  verifyMemo: (body) => http('POST', '/rewards/verify-memo', body),
  // a GET, not a HEAD: the engine's router answers HEAD on this route with 404 while GET is 200 (seen live 2026-10-04). The file is
  // one short row per round, so the probe costs little; the body is not read.
  async epochsCsv() {
    try {
      const r = await fetch(`${BASE}/epochs.csv`, { cache: 'no-store' })
      if (r.body) r.body.cancel().catch(() => {})
      return r.ok ? `${BASE}/epochs.csv` : null
    } catch { return null }
  },
}

export const api: Api = USE_REAL ? real : mock

// Exact message text from the contract. The client builds it so the user can read what they sign.
export function optinMessage(wallet: string, zcash: string, nonce: string): string {
  return `SNARKS pad: deliver my rewards shielded\nwallet: ${wallet}\nzcash: ${zcash}\nnonce: ${nonce}`
}
// Contract: "same signed-message scheme, first line `SNARKS pad: stop shielded delivery`".
// The API never returns the full address, so the stop message carries no zcash line.
export function optoutMessage(wallet: string, nonce: string): string {
  return `SNARKS pad: stop shielded delivery\nwallet: ${wallet}\nnonce: ${nonce}`
}
// Contract v2.9: POST /optin/status shows a wallet's shielded delivery (on or off, the masked address, what is pending, the shielded rounds) only against a signature over this text.
// It is the signature's purpose: it is not the opt-in or opt-out text, so it can never opt anyone in or out, and the nonce works once.
export function shieldedViewMessage(wallet: string, nonce: string): string {
  return `SNARKS pad: show my shielded delivery settings and rewards\nwallet: ${wallet}\nnonce: ${nonce}`
}
// Contract (v2.2 receipt, v2.6 verify-memo): the signed proof that opens the caller's own rows of one round.
export function receiptMessage(wallet: string, epochId: string, nonce: string): string {
  return `SNARKS pad: open my epoch receipt\nwallet: ${wallet}\nepoch: ${epochId}\nnonce: ${nonce}`
}

/** Plain words for what a trade can hit: the engine's codes, and what a wallet or the chain says when a send fails. */
export function tradeErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'bad_amount') return 'That is more than the curve can fill right now. Try a smaller amount.'
    if (e.code === 'unreachable') return 'The pad server did not answer. Check your connection and try again.'
    if (e.code === 'bad_wallet') return 'The pad did not recognise this wallet address. Reconnect your wallet and try again.'
    if (e.code === 'chain_unavailable') return 'The pool could not be read right now. Try again in a moment.'
    if (e.status >= 500) return 'The pad could not build this trade. Try again in a moment.'
    return `The pad refused this trade (${e.code}).`
  }
  const m = e instanceof Error ? e.message : String(e)
  if (/reject|denied|cancel/i.test(m)) return 'You closed the wallet prompt. Nothing was signed.'
  if (refusedBeforeSend(m) === 'expired') return EXPIRED_TEXT
  if (/insufficient|0x1\b|not enough/i.test(m)) return 'Your wallet does not hold enough for this trade (the amount plus a little SOL for the network fee).'
  // ExceededSlippage is error 6002 (0x1772) in both the DBC and the DAMM v2 program (their IDLs)
  if (/slippage|0x1772|\b6002\b/i.test(m)) return 'The price moved more than your slippage allows. Raise the slippage or try again.'
  if (/timeout|timed out/i.test(m)) return 'The network did not answer in time. Check your wallet before trying again: the trade may have gone through.'
  return m
}
/** True when a failed send reads as "not enough money", so the page can offer the way to get ZEC. */
export const isShortOfFunds = (e: unknown): boolean => e instanceof Error && /insufficient|0x1\b|not enough/i.test(e.message)

export const OPTIN_ERRORS: Record<OptinError | string, string> = {
  invalid_signature: 'The signature did not match this wallet. Sign again with the same wallet you connected.',
  no_orchard_receiver: 'That address cannot receive shielded payouts (it is a transparent or older-style address). Paste a unified address that starts with u1 from a wallet updated for the Zcash Ironwood upgrade (Zodl 3.8.0 or newer).',
  bad_address: 'That is not a Zcash unified address. It should start with u1.',
  stale_nonce: 'That request expired. Sign again; a fresh one is ready.',
  bad_wallet: 'The pad did not recognise that Solana wallet address. Reconnect your wallet and try again.',
  bad_request: 'The pad could not read that request. Reload the page and try again.',
  unreachable: 'The pad server did not answer. Is the engine running on port 8787?',
}

/** A trade (or a claim) that reached Solana and failed there, from the transaction's error. Nothing moved except the network fee. */
export function failedOnChainText(err: unknown, what: 'trade' | 'claim'): string {
  const e = JSON.stringify(err ?? '')
  if (/"Custom":6002\b/.test(e)) return 'The price moved more than your slippage allows, so the trade did not go through. Only the network fee was spent. Raise the slippage or try again.'
  if (/"Custom":1\b|InsufficientFunds/.test(e)) return `Your wallet did not hold enough, so the ${what} did not go through. Only the network fee was spent.`
  return `Solana refused the ${what}, so nothing moved. Only the network fee was spent (under a cent).`
}
