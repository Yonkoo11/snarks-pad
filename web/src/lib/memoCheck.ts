// The browser's own read of the Solana memo that carries a round's holder-file hash. The text is the one the engine writes
// (engine/src/epoch/snapshotFile.ts snapshotMemoText); the read is a plain getTransaction against the RPC the site is built with.

export const snapshotMemoText = (epochId: string, sha256: string): string => `snarks-pad snapshot ${epochId} sha256:${sha256}`

export type MemoRead = { kind: 'memo'; text: string } | { kind: 'none' } | { kind: 'unreadable' }
export type MemoVerdict = 'match' | 'mismatch' | 'none' | 'unreadable'

export function memoVerdict(read: MemoRead, epochId: string, sha256: string): MemoVerdict {
  if (read.kind === 'unreadable') return 'unreadable'
  if (read.kind === 'none') return 'none'
  return read.text === snapshotMemoText(epochId, sha256.toLowerCase()) ? 'match' : 'mismatch'
}

type Tx = { meta?: { err: unknown } | null; transaction: { message: { instructions: { program?: string; parsed?: unknown }[] } } } | null

/** `unreadable` when the RPC does not answer; `none` when it answers and the transaction is missing, failed, or carries no memo. */
export async function readMemo(rpc: string, sig: string, f: typeof fetch = fetch): Promise<MemoRead> {
  try {
    const res = await f(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }),
    })
    if (!res.ok) return { kind: 'unreadable' }
    const body = (await res.json()) as { result?: Tx; error?: unknown }
    if (body.error) return { kind: 'unreadable' }
    const tx = body.result
    if (!tx || tx.meta?.err) return { kind: 'none' }
    const ix = tx.transaction.message.instructions.find((i) => i.program === 'spl-memo')
    return typeof ix?.parsed === 'string' ? { kind: 'memo', text: ix.parsed } : { kind: 'none' }
  } catch { return { kind: 'unreadable' } }
}
