<script lang="ts">
  import { apiUrl } from '../lib/api'
  import { short } from '../lib/format'
  // "Check this round yourself": the visitor's own browser fetches the round's holder-list file and recomputes
  // its SHA-256 with WebCrypto, then holds the result against the hash the pad published. A match is proof made
  // on the visitor's machine; the pad is never asked to vouch for itself. compact drops the explainer line for
  // the rounds list, where the row around it already says what the file is.
  let { sha256, url, compact = false }: { sha256: string; url: string; compact?: boolean } = $props()
  type St = 'idle' | 'working' | 'match' | 'mismatch' | 'failed'
  let st = $state<St>('idle')
  let got = $state<string | null>(null)
  let at = $state<string | null>(null)

  async function run() {
    st = 'working'; got = null
    try {
      const r = await fetch(apiUrl(url), { cache: 'no-store' })
      if (!r.ok) throw new Error(String(r.status))
      const buf = await r.arrayBuffer()
      const d = await crypto.subtle.digest('SHA-256', buf)
      const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
      got = hex
      at = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      st = hex.toLowerCase() === sha256.toLowerCase() ? 'match' : 'mismatch'
    } catch { st = 'failed' }
  }
</script>

<div class="vr" class:compact>
  {#if st === 'idle'}
    <button class="btn ghost go" type="button" onclick={run}>Check this file in your browser</button>
    {#if !compact}<p class="muted why">Your browser downloads the holder file and recomputes its hash. No word of ours is involved.</p>{/if}
  {:else if st === 'working'}
    <p class="muted run" role="status">Fetching the file and hashing it here&hellip;</p>
  {:else if st === 'match'}
    <p class="stamped" role="status"><span class="seal" aria-hidden="true">&#10003;</span> <strong>Hash matches.</strong> Your browser computed <span class="mono">{short(got ?? '', 8, 6)}</span>{at ? ` at ${at}` : ''}, the same hash the pad published.</p>
  {:else if st === 'mismatch'}
    <p class="error" role="alert">The hash your browser computed (<span class="mono">{short(got ?? '', 8, 6)}</span>) does not match the published one. The file changed after it was published. Keep both hashes and ask the operator.</p>
  {:else}
    <p class="failed"><span class="error">Could not fetch the file.</span> <button class="btn ghost" type="button" onclick={run}>Try again</button></p>
  {/if}
</div>

<style>
  .vr { display: grid; gap: var(--s-2); justify-items: start; }
  .why { font-size: var(--t-14); max-width: 52ch; }
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
