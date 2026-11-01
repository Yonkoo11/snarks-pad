<script lang="ts">
  import { apiUrl, USE_REAL } from '../lib/api'
  import { memoVerdict, readMemo, type MemoVerdict } from '../lib/memoCheck'
  import { short } from '../lib/format'
  import Witness from './room/Witness.svelte'
  // "Check this round yourself": the visitor's own browser fetches the round's holder-list file and recomputes
  // its SHA-256 with WebCrypto, then holds the result against the hash the pad published. A match is proof made
  // on the visitor's machine; the pad is never asked to vouch for itself. With the epoch id and the memo's signature it also reads
  // the Solana memo from the chain and holds the same hash against that. (The mock's signatures are not on any chain: no read. A match means some transaction at that signature carries the text; the signer is not compared with the keeper, because the API does not publish the keeper's address.) compact drops the explainer line for
  // the rounds list, where the row around it already says what the file is.
  let { sha256, url, epochId, memoSig, compact = false, onverified }: { sha256: string; url: string; epochId?: string; memoSig?: string | null; compact?: boolean; onverified?: () => void } = $props()
  const RPC: string = import.meta.env.VITE_RPC || 'http://127.0.0.1:8899'
  type St = 'idle' | 'working' | 'match' | 'mismatch' | 'failed'
  let st = $state<St>('idle')
  let got = $state<string | null>(null)
  let at = $state<string | null>(null)
  // the step the computation is really on, so the line under the mascot is the trace and not a message
  let step = $state<'fetch' | 'hash' | 'compare' | 'memo'>('fetch')
  let size = $state(0)
  let chain = $state<MemoVerdict | null>(null)

  async function run() {
    st = 'working'; got = null; step = 'fetch'; size = 0; chain = null
    try {
      const r = await fetch(apiUrl(url), { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      const buf = await r.arrayBuffer()
      size = buf.byteLength; step = 'hash'
      const d = await crypto.subtle.digest('SHA-256', buf)
      step = 'compare'
      const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
      got = hex
      at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      const same = hex.toLowerCase() === sha256.toLowerCase()
      if (same && USE_REAL && memoSig && epochId) {
        step = 'memo'
        chain = memoVerdict(await readMemo(RPC, memoSig), epochId, sha256)
      }
      st = same ? 'match' : 'mismatch'
      if (st === 'match' && chain !== 'mismatch') onverified?.()
    } catch { st = 'failed' }
  }
</script>

<div class="vr" class:compact>
  {#if st === 'idle'}
    <button class="btn ghost go" type="button" onclick={run}>Check this file in your browser</button>
    {#if !compact}<p class="muted why">Your browser downloads the holder file and recomputes its hash. No word of ours is involved.</p>{/if}
  {:else if st === 'working'}
    <div class="wrow"><Witness state="working" size={compact ? 40 : 56} /><p class="muted run" role="status">{step === 'fetch' ? 'Fetching the file' : step === 'hash' ? `Hashing ${size.toLocaleString('en-US')} bytes in this browser` : step === 'memo' ? 'Reading the memo on Solana' : 'Comparing with the published hash'}&hellip;</p></div>
  {:else if st === 'match'}
    <div class="wrow"><Witness state={chain === 'mismatch' ? 'mismatch' : 'match'} size={compact ? 40 : 56} /><p class="stamped" role="status"><span class="seal" aria-hidden="true">&#10003;</span> <strong>Hash matches.</strong> Your browser computed <span class="mono">{short(got ?? '', 8, 6)}</span>{at ? ` at ${at}` : ''}, the same hash the pad published.{#if chain === 'match'} A transaction at the listed Solana signature carries the same hash. Who signed it is not checked here.{:else if chain === 'unreadable'} The Solana memo could not be read from here.{:else if chain === 'none'} No memo was found at the signature the pad lists.{/if}</p></div>
    {#if chain === 'mismatch'}<p class="error" role="alert"><span>The Solana memo does not carry this hash. Keep both and ask the operator.</span></p>{/if}
  {:else if st === 'mismatch'}
    <div class="wrow"><Witness state="mismatch" size={compact ? 40 : 56} /><div class="mm"><p class="error" role="alert"><span>The hash your browser computed (<span class="mono">{short(got ?? '', 8, 6)}</span>) does not match the published one (<span class="mono">{short(sha256, 8, 6)}</span>). The file changed after it was published. Keep both hashes and ask the operator.</span></p><button class="btn ghost" type="button" onclick={run}>Check again</button></div></div>
  {:else}
    <p class="failed"><span class="error">Could not fetch the file.</span> <button class="btn ghost" type="button" onclick={run}>Try again</button></p>
  {/if}
</div>

<style>
  .vr { display: grid; gap: var(--s-2); justify-items: start; }
  .why { font-size: var(--t-14); max-width: 52ch; }
  .wrow { display: flex; gap: var(--s-3); align-items: center; }
  .mm { display: grid; gap: var(--s-2); justify-items: start; }
  .run { font-size: var(--t-14); }
  .compact .go { min-height: 36px; padding: 0 var(--s-3); font-size: var(--t-14); }
  /* the verdict wears a stamp: it lands with a small thunk, tilted like the postmark, then sits still.
     Plain text flow inside, so the line wraps like a sentence on a phone instead of breaking into columns. */
  .stamped {
    display: inline-block; margin: 0; max-width: 100%;
    padding: var(--s-2) var(--s-3); border: 2px solid var(--ink); border-radius: var(--r-sm);
    color: var(--ink); font-size: var(--t-14); transform: rotate(-1.2deg);
    animation: thunk 240ms var(--ease) backwards;
  }
  .stamped .mono, .stamped strong { color: inherit; }
  .seal { font-weight: 700; margin-right: var(--s-1); }
  .failed { display: flex; gap: var(--s-3); align-items: center; flex-wrap: wrap; font-size: var(--t-14); }
  .error { font-size: var(--t-14); max-width: 52ch; }
  @keyframes thunk {
    from { transform: rotate(-4deg) scale(1.3); opacity: 0; }
    to { transform: rotate(-1.2deg) scale(1); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .stamped { animation: none; } }
</style>
