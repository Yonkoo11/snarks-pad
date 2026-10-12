<script lang="ts">
  import { api, apiUrl, onMode } from '../lib/api'
  import type { Epoch, PadMode, Treasury } from '../lib/types'
  import { zec, short, ago } from '../lib/format'
  // A cadence in words from its milliseconds: "48 hours", "7 days". Under a day it is said in hours; the drills set odd values and this still reads.
  const every = (ms: number): string => (ms >= 3 * 86_400_000 && ms % 86_400_000 === 0 ? `${ms / 86_400_000} days` : `${Math.max(1, Math.round(ms / 3_600_000))} hours`)
  import { sharesFromPolicy } from '../lib/fees'
  import { poll } from '../lib/poll'
  import FeeSplit from '../components/FeeSplit.svelte'
  import NextPayout from '../components/NextPayout.svelte'
  import Addr from '../components/Addr.svelte'

  let t = $state<Treasury | null>(null)
  let epochs = $state<Epoch[] | null>(null)
  let err = $state<string | null>(null)
  let now = $state(Date.now())
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))
  // one row per round as a file (v2.6 GET /epochs.csv); an engine without it gets no link
  let csvUrl = $state<string | null>(null)
  $effect(() => { api.epochsCsv().then((u) => (csvUrl = u), () => (csvUrl = null)) })

  async function load() {
    try {
      const [a, b] = await Promise.all([api.treasury(), api.epochs()])
      t = a; epochs = b.epochs; err = null
    } catch { err = 'Could not load the treasury.' }
  }
  $effect(() => poll(load, 10_000))
  $effect(() => { const k = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(k) })

  function solUrl(sig: string): string | null {
    if (mode === 'mainnet') return `https://explorer.solana.com/tx/${sig}`
    if (mode === 'devnet') return `https://explorer.solana.com/tx/${sig}?cluster=devnet`
    if (mode === 'local') return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent('http://127.0.0.1:8899')}`
    return null
  }
  function zUrl(txid: string): string | null {
    return t?.zcashNetwork === 'main' ? `https://mainnet.zcashexplorer.app/transactions/${txid}` : null
  }
  const netName = { regtest: 'Zcash regtest (local)', test: 'Zcash testnet', main: 'Zcash mainnet' } as const
  const statusText = { ok: 'paid', partial: 'partly paid', fallback_solana: 'paid as Solana ZEC', needs_attention: 'waiting for the operator' } as const
  let showAll = $state(false)
  // Newest first. The latest round that paid anything shielded leads the page; Solana-only rounds hide behind "show all".
  const latestShielded = $derived(epochs?.find((e) => e.shielded.count > 0 && e.shielded.zcashTxids.length > 0) ?? null)
  // The newest round, when it is newer than the shielded one above: a Solana-only round gets its own line so the page says what just went out.
  const latestSolanaOnly = $derived(epochs && epochs[0] && epochs[0] !== latestShielded && epochs[0].shielded.count === 0 ? epochs[0] : null)
  // The newest round always shows, so the page reads "updated" the hour a round runs (owner report, 2026-10-12: a Solana-only round 1
  // was hidden behind "show all"). A round that did not go to plan (swap fell back, partly paid, parked) always stays visible too;
  // only older, normal Solana-only rounds collapse.
  const withShielded = $derived(epochs ? epochs.filter((e, i) => i === 0 || e.shielded.count > 0 || e.status !== 'ok') : [])
  const shownEpochs = $derived(!epochs ? [] : showAll ? epochs : withShielded)
  const hiddenCount = $derived(epochs ? epochs.length - withShielded.length : 0)
  const numberOf = (id: string): number => (epochs ? epochs.length - epochs.findIndex((e) => e.id === id) : 0)
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  // One load feeds the page: a failure is said once, under the heading, and each block says only that it was not loaded.
  const failed = $derived(!!err && !t)
</script>

<section class="wrap pad">
  <h1 class="display">Payouts.</h1>
  <p class="lede muted">Every payout to holders, with its transactions.</p>
  {#if failed}
    <div class="fail">
      <p class="error">{err}</p>
      <button class="btn" type="button" onclick={load}>Try again</button>
    </div>
  {/if}

  {#if !failed}
  <section class="lead" aria-labelledby="lead-h">
    <h2 class="h2" id="lead-h">Latest shielded payout</h2>
    {#if !epochs}
      <div class="skel" style="height: 176px" aria-busy="true" aria-label="Loading the latest payout"></div>
    {:else if latestShielded}
      <article class="panel latest">
        <span class="band hatch" aria-hidden="true"></span>
        <p class="muted">{when(latestShielded.at)} ({ago(latestShielded.at, now)}), round #{numberOf(latestShielded.id)}, {t ? netName[t.zcashNetwork] : ''}.</p>
        <p><span class="mono big">{zec(latestShielded.shielded.totalZats)} ZEC</span> in one batched shielded transaction to {latestShielded.shielded.count} {latestShielded.shielded.count === 1 ? 'address' : 'addresses'}.</p>
        {#each latestShielded.shielded.zcashTxids as z (z)}
          <p class="txid"><span class="label">Zcash transaction</span> <Addr value={z} head={12} tail={10} href={zUrl(z)} label="Zcash transaction id" /></p>
        {/each}
        {#if latestShielded.shielded.swap.provider === 'simulated'}<p class="muted small">The swap into native ZEC was simulated in this test setup.</p>{/if}
        {#if latestShielded.snapshot}
          <p class="muted small">Holder snapshot <span class="mono">{short(latestShielded.snapshot.sha256, 10, 8)}</span>, <a href={apiUrl(latestShielded.snapshot.url)} target="_blank" rel="noreferrer">open the file</a>{#if latestShielded.snapshot.memoSig}, hash written to Solana in memo <Addr value={latestShielded.snapshot.memoSig} head={6} tail={4} href={solUrl(latestShielded.snapshot.memoSig)} label="memo signature" />{/if}. To check that your own note arrived, look for it in your wallet.</p>
        {/if}
      </article>
    {:else}
      <p class="muted">No shielded payout yet.</p>
    {/if}
  </section>
  {/if}


  {#if !failed}
  <div class="sheet panel">
    {#if t}
      <p class="when">{#if t.lastEpochAt}Last payout {ago(t.lastEpochAt, now)}.{/if}{#if latestSolanaOnly} Round #{numberOf(latestSolanaOnly.id)} paid <span class="mono">{zec(latestSolanaOnly.solanaPayouts.totalZats)} ZEC</span> as Solana ZEC to {latestSolanaOnly.solanaPayouts.count} wallets in {latestSolanaOnly.solanaPayouts.sigs.length} {latestSolanaOnly.solanaPayouts.sigs.length === 1 ? 'transaction' : 'transactions'}. Shares under the payout floor carry to the next round. It is listed below.{/if} {#if t.lastRunFoundNothing && t.lastRunAt}Last round ran {ago(t.lastRunAt, now)} and found nothing to claim yet.{/if} <NextPayout at={t.nextEpochAt} {now} />.</p>
      <p class="muted small">Rounds run every {every(t.cadence.roundEveryMs)} and pay Solana ZEC. The shielded share goes out about every {every(t.cadence.shieldedEveryMs)} in one batch.</p>
    {:else}
      <div class="skel" style="height: 48px" aria-busy="true" aria-label="Loading the payouts"></div>
    {/if}
  </div>

  <section class="policy">
    <FeeSplit split={t ? sharesFromPolicy(t.policy) : undefined} />
    <details class="how">
      <summary>How payouts work</summary>
      <div class="how-body">
        <p>Holders are paid their share as Solana ZEC every round, or as native ZEC once a week if they chose shielded delivery.</p>
        <p>Your share follows the least you held at random checks during the round, so buying just before a payout earns nothing for that round.</p>
        <p>On the curve a coin's fee is fixed at launch. After it graduates, its pool's fee rises by up to a fifth when trading is volatile: 1% rises to about 1.2%.</p>
        <p>Only coins launched on SNARKS pad are paid.</p>
      </div>
    </details>
  </section>

  <section class="ep">
    <div class="ep-head">
      <h2 class="h2">Every payout round</h2>
      <p class="muted measure">Each round claims the pools' trading fees (they are already ZEC) and pays Solana ZEC to holders. Once a week the shielded share is swapped to native ZEC and sent in one batched Zcash transaction. Per-holder shielded amounts are never published. Each round also says what delivering the shielded batch cost and what the team kept after paying it.</p>
      {#if csvUrl && epochs?.length}<a class="btn ghost csv" href={csvUrl} download="snarks-epochs.csv">Download every round as CSV</a>{/if}
    </div>
    {#if !epochs}
      <div class="skel" style="height: 240px" aria-busy="true" aria-label="Loading the payout rounds"></div>
    {:else if epochs.length === 0}
      <p class="muted">No payout rounds yet.</p>
    {:else}
      <div class="rows">
        {#each shownEpochs as e (e.id)}
          <article class="row">
            <div class="r-head">
              <span class="eid mono" title={e.id}>#{numberOf(e.id)}</span>
              <span class="muted">{when(e.at)}</span>
              <span>claimed <span class="mono">{zec(e.harvestedZats)} ZEC</span> from {e.coinMints.length} {e.coinMints.length === 1 ? 'coin' : 'coins'}</span>
              <span class="st caps {e.status}">{statusText[e.status]}</span>
            </div>
            <p class="split muted">
              Holders <span class="mono">{zec(e.split.holdersZats)}</span>, team <span class="mono">{zec(e.split.teamZats)}</span>,
              {#if e.split.deliveryCostZats === null}shielded delivery cost not settled yet{:else}shielded delivery cost <span class="mono">{zec(e.split.deliveryCostZats)}</span> paid from the team share{#if e.split.teamNetZats !== null}, team net <span class="mono">{zec(e.split.teamNetZats)}</span>{/if}{/if}{#if BigInt(e.split.holderShortfallZats) > 0n}; <span class="mono">{zec(e.split.holderShortfallZats)}</span> above the team share was taken pro rata from the shielded holders{/if}.
            </p>
            <div class="legs">
              <div class="leg">
                <p class="label">Solana ZEC leg</p>
                <p><span class="mono">{zec(e.solanaPayouts.totalZats)} ZEC</span> to {e.solanaPayouts.count} wallets</p>
                <p class="links">
                  {#each e.solanaPayouts.sigs as s (s)}
                    <Addr value={s} head={6} tail={4} href={solUrl(s)} label="Solana signature" />
                  {/each}
                </p>
              </div>
              <div class="leg shd">
                <p class="label">Shielded leg</p>
                {#if e.shielded.count === 0}
                  <p class="muted">None this round{e.status === 'fallback_solana' ? '. The swap did not complete, so shielded holders were paid Solana ZEC instead.' : '.'}</p>
                {:else}
                  <p><span class="mono">{zec(e.shielded.totalZats)} ZEC</span> to {e.shielded.count} shielded addresses, network fee <span class="mono">{zec(e.feeZats, 8)}</span></p>
                  <p class="links">
                    <span class="swap">swap {e.shielded.swap.provider === 'simulated' ? '' : 'NEAR 1Click '}<span class="mono">{short(e.shielded.swap.ref, 8, 4)}</span></span>
                    {#if e.shielded.swap.provider === 'simulated'}<span class="chip sim">simulated</span>{/if}
                  </p>
                  <p class="links">
                    {#each e.shielded.zcashTxids as z (z)}
                      <span class="muted">Zcash tx</span>
                      <Addr value={z} head={8} tail={6} href={zUrl(z)} label="Zcash transaction id" />
                    {/each}
                  </p>
                {/if}
              </div>
            </div>
          </article>
        {/each}
      </div>
      {#if hiddenCount > 0}
        <button class="btn ghost more" onclick={() => (showAll = !showAll)} aria-expanded={showAll}>
          {showAll ? 'Hide routine Solana ZEC rounds' : `Show all ${epochs.length} rounds (${hiddenCount} routine Solana ZEC rounds hidden)`}
        </button>
      {/if}
    {/if}
  </section>
  {/if}
</section>

<style>
  .lede { font-size: var(--t-20); line-height: 1.45; max-width: 60ch; }
  .when { font-size: var(--t-16); }
  .pad { padding-top: var(--s-6); display: grid; gap: var(--s-6); }
  .sheet { padding: var(--s-6); display: grid; gap: var(--s-4); }
  .big { font-size: var(--t-20); font-weight: 500; line-height: 1.2; }
  .cov-r { font-size: var(--t-14); font-weight: 400; margin-left: var(--s-2); }
  .meta { font-size: var(--t-14); }
  .fail { display: grid; gap: var(--s-3); justify-items: start; }
  .lead { display: grid; gap: var(--s-3); }
  .latest { position: relative; overflow: hidden; display: grid; gap: var(--s-2); padding: var(--s-5); padding-top: calc(var(--s-5) + 6px); }
  .latest .band { position: absolute; inset: 0 0 auto 0; height: 6px; }
  .txid { display: flex; gap: var(--s-2); align-items: baseline; flex-wrap: wrap; }
  .small { font-size: var(--t-14); }
  .latest a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .rc { display: grid; gap: var(--s-2); padding: var(--s-4); align-content: start; font-size: var(--t-14); }
  .more { justify-self: start; margin-top: var(--s-4); }
  .split { font-size: var(--t-14); }

  .policy { display: grid; gap: var(--s-4); }
  .how summary { cursor: pointer; font-weight: 700; padding: var(--s-3) 0; width: max-content; border-radius: var(--r-sm); }
  .how summary::marker { color: var(--ink-2); }
  .how-body { display: grid; gap: var(--s-3); max-width: 66ch; color: var(--ink-2); padding: var(--s-2) 0 var(--s-3); }

  .ep { display: grid; gap: var(--s-4); padding-top: var(--s-6); }
  .ep-head { display: grid; gap: var(--s-2); justify-items: start; }
  .csv { margin-top: var(--s-2); }
  .rows { border-top: 2px solid var(--ink); }
  .row { padding: var(--s-4) 0; border-bottom: 1px solid var(--line); display: grid; gap: var(--s-3); }
  .r-head { display: flex; gap: var(--s-4); align-items: baseline; flex-wrap: wrap; font-size: var(--t-14); }
  .eid { font-size: var(--t-20); font-weight: 500; }
  .st { margin-left: auto; font-weight: 700; font-size: var(--t-12); letter-spacing: .06em; }
  .st.fallback_solana, .st.partial, .st.needs_attention { color: var(--bad); }
  .legs { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-6); font-size: var(--t-14); }
  .leg { display: grid; gap: var(--s-1); align-content: start; }
  .shd { position: relative; padding-left: calc(var(--s-4) + 8px); }
  /* hatching marks what is shielded (the device) */
  .shd::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 8px; border-radius: var(--r-xs); background: repeating-linear-gradient(-55deg, var(--pink) 0 3px, transparent 3px 6px), var(--pink-soft); }
  .links { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); align-items: center; }
  @media (max-width: 760px) {
    .sheet { padding: var(--s-5); }
    .legs { grid-template-columns: 1fr; gap: var(--s-3); }
  }
</style>
