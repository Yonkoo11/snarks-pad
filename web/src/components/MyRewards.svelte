<script lang="ts">
  import { api, ApiError, onMode, receiptMessage, routeAbsent } from '../lib/api'
  import type { Coin, Epoch, MemoCheck, PadMode, Rewards, SolanaPayout } from '../lib/types'
  import { zec, ago, short } from '../lib/format'
  import { solanaTxUrl, zcashTxUrl } from '../lib/explorer'
  import { wallet as walletStore, friendly } from '../lib/wallet.svelte'
  import { shieldedView } from '../lib/shielded.svelte'
  import Addr from './Addr.svelte'

  // "My rewards" (contract v2.6 GET /rewards/:wallet): with a wallet connected, every round that paid it Solana ZEC, with the
  // batch signature and the coins it came from. The shielded rail is the wallet's own business (v2.9): the public answer holds
  // none of it, so a button asks for one signature and then shows it, as counts only, because per-recipient shielded amounts are
  // never published. Under it, unless `verify` is off (the profile's Rewards tab), for anyone, the memo check
  // (POST /rewards/verify-memo): paste the memo of a shielded note, add the transaction id if you like, and the pad says which
  // round wrote it; with a wallet connected, one signature also checks that the round has a row for that wallet. An engine
  // without these routes shows neither block.
  let { wallet, verify = true }: { wallet: string | null; verify?: boolean } = $props()
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))

  let view = $state<Rewards | null | undefined>(undefined)
  let err = $state(false)
  let epochs = $state<Epoch[] | null>(null)
  let coins = $state<Coin[]>([])
  let zNet = $state<'regtest' | 'test' | 'main' | null>(null)
  async function load(w: string) {
    err = false
    try { view = await api.rewards(w) }
    catch (e) { if (routeAbsent(e)) view = null; else err = true }
  }
  $effect(() => { const w = wallet; view = undefined; if (w) load(w) })
  $effect(() => {
    api.epochs().then((r) => (epochs = r.epochs), () => (epochs = null))
    api.coins({ limit: 100 }).then((r) => (coins = r.coins), () => (coins = []))
    if (!verify) return
    api.treasury().then((t) => (zNet = t.zcashNetwork), () => (zNet = null))
    // an engine without the verifier route answers 404 to any memo: ask once with a well-formed memo that names no round (a v2.6 engine
    // answers 200 with matches false, never an error), so the box is not offered where it cannot work
    api.verifyMemo({ memo: 'SNARKS pad reward, epoch none' }).then(() => {}, (e) => { if (routeAbsent(e)) verifierGone = true })
  })
  const numberOf = (id: string): string => { const i = epochs?.findIndex((e) => e.id === id) ?? -1; return i >= 0 && epochs ? `#${epochs.length - i}` : id }
  const symbolOf = (mint: string): string => coins.find((c) => c.mint === mint)?.symbol ?? short(mint)
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  // the shielded part, once the owner has signed (shared with the Shielded page and the profile's tabs: one signature serves them all)
  const details = $derived(shieldedView.of(wallet))
  const lastShielded = $derived(details?.shielded.commitments[0]?.at ?? null)

  // ---- memo check
  let memo = $state('')
  let txid = $state('')
  let checking = $state(false)
  let result = $state<MemoCheck | null>(null)
  let memoErr = $state<string | null>(null)
  let verifierGone = $state(false)
  let proving = $state(false)
  const txidOk = $derived(txid.trim() === '' || /^[0-9a-f]{64}$/.test(txid.trim()))
  async function check(withProof = false) {
    checking = true; memoErr = null
    if (!withProof) result = null
    try {
      const body: { memo: string; txid?: string; wallet?: string; nonce?: string; signature?: string } = { memo: memo.trim() }
      if (txid.trim()) body.txid = txid.trim()
      if (withProof && wallet && result?.epochId) {
        proving = true
        const { nonce } = await api.optinNonce(wallet)
        body.wallet = wallet; body.nonce = nonce
        body.signature = await walletStore.signMessage(receiptMessage(wallet, result.epochId, nonce))
      }
      result = await api.verifyMemo(body)
    } catch (e) {
      if (routeAbsent(e)) verifierGone = true
      else if (e instanceof ApiError && e.code === 'invalid_signature') memoErr = 'The signature did not match this wallet. Sign again with the wallet you connected.'
      else if (e instanceof ApiError && e.code === 'stale_nonce') memoErr = 'That request expired. Try again; a fresh one is ready.'
      else if (e instanceof ApiError && e.code === 'bad_request') memoErr = 'The pad could not read that. A memo is at most 512 characters and a transaction id is 64 hex digits.'
      else if (e instanceof ApiError) memoErr = 'Could not check that memo. Try again in a moment.'
      else memoErr = friendly(e)
    } finally { checking = false; proving = false }
  }
</script>

{#snippet payoutRows(list: SolanaPayout[], label: string)}
  <div class="rows" role="table" aria-label={label}>
    <div class="r head" role="row"><span role="columnheader" class="label">Round</span><span role="columnheader" class="label">Coins</span><span role="columnheader" class="label num">Paid</span><span role="columnheader" class="label sig hide-sm">Signature</span></div>
    {#each list as r (r.epochId + r.sig)}
      <div class="r" role="row">
        <span role="cell"><span class="mono">{numberOf(r.epochId)}</span> <span class="muted small">{when(r.at)}</span></span>
        <span role="cell" class="mono coins">{#each r.coins as c (c.mint)}<span title="{zec(c.shareZats, 6)} ZEC from this coin at planning time">${symbolOf(c.mint)}</span>{/each}</span>
        <span role="cell" class="mono num">{zec(r.zats, 6)} ZEC</span>
        <span role="cell" class="sig"><Addr value={r.sig} head={6} tail={6} href={solanaTxUrl(r.sig, mode)} label="Solana signature" /></span>
      </div>
    {/each}
  </div>
{/snippet}

{#if wallet && view !== null}
  <section class="mine panel" aria-labelledby="mine-h">
    <h2 class="h2" id="mine-h">My rewards</h2>
    {#if err}
      <div class="state"><p class="error">Could not read your rewards from the pad.</p><button class="btn" type="button" onclick={() => wallet && load(wallet)}>Try again</button></div>
    {:else if view === undefined}
      <div class="skel" style="height: 120px" aria-busy="true" aria-label="Loading your rewards"></div>
    {:else}
      <p class="sum">Paid to <span class="mono">{short(wallet)}</span> as Solana ZEC: <span class="mono">{zec(view.solana.totalZats)} ZEC</span> over {view.solana.count} {view.solana.count === 1 ? 'round' : 'rounds'}.</p>
      {#if view.solana.payouts.length === 0}
        <p class="muted">No Solana ZEC payout to this wallet yet. A wallet is paid from the round after it bought, by the least it held at random checks during that round.</p>
      {:else}
        {@render payoutRows(view.solana.payouts, 'Your Solana ZEC payouts')}
        {#if view.solana.count > view.solana.payouts.length}<p class="muted small">Showing the newest {view.solana.payouts.length} of {view.solana.count} rounds.</p>{/if}
      {/if}
      <div class="shd"><span class="key hatch" aria-hidden="true"></span>
        <div class="shd-body">
          {#if details === null}
            <p>Shielded rewards are private: the pad shows them only to you, after you sign.</p>
            <button class="btn ghost" type="button" onclick={() => wallet && shieldedView.read(wallet)} disabled={shieldedView.busy}>{shieldedView.busy ? 'Waiting for your wallet…' : 'Show shielded details'}</button>
            <p class="muted small">One signature, no transaction, no fee. Your wallet shows the exact text first.</p>
            {#if shieldedView.error}<p class="error">{shieldedView.error}</p>{/if}
          {:else if details.shielded.rounds === 0}
            <p>Shielded: {details.optedIn ? 'delivery is on, and no batch has paid this wallet yet.' : 'no batch has paid this wallet.'}</p>
          {:else}
            <p>Shielded: paid in <span class="mono">{details.shielded.rounds}</span> {details.shielded.rounds === 1 ? 'batch' : 'batches'}{#if lastShielded}, the last one {ago(lastShielded)}{/if}. Amounts per recipient are never published, not even to you here: your Zcash wallet shows the note{#if verify}, and the check below ties its memo to the round and, with one signature, to this wallet{/if}.</p>
          {/if}
          {#if details && details.shielded.fallback.count > 0}
            <p>Your shielded share, paid as Solana ZEC instead because the shielded batch could not run: <span class="mono">{zec(details.shielded.fallback.totalZats, 6)} ZEC</span> over {details.shielded.fallback.count} {details.shielded.fallback.count === 1 ? 'round' : 'rounds'}. The pad does not list these in the table above: they would show that you opted in.</p>
            {@render payoutRows(details.shielded.fallback.payouts, 'Your shielded share paid as Solana ZEC')}
          {/if}
        </div>
      </div>
    {/if}
  </section>
{/if}

{#if verify && !verifierGone}
  <section class="verify panel" aria-labelledby="verify-h">
    <h2 class="h2" id="verify-h">Check a shielded note</h2>
    <p class="muted">Paste the memo from a note in your Zcash wallet to see which payout it came from.</p>
    <form class="vform" onsubmit={(e) => { e.preventDefault(); if (memo.trim() && txidOk) check() }}>
      <label class="field grow">
        <span>Paste the memo from your Zodl note</span>
        <input class="input mono" autocomplete="off" spellcheck="false" placeholder="SNARKS pad reward, epoch epoch-1790000000000" bind:value={memo} />
      </label>
      <label class="field txid">
        <span>Transaction id (optional)</span>
        <input class="input mono" autocomplete="off" spellcheck="false" placeholder="64 hex digits" bind:value={txid} aria-invalid={!txidOk} />
      </label>
      <button class="btn" type="submit" disabled={checking || !memo.trim() || !txidOk}>{checking && !proving ? 'Checking…' : 'Verify memo'}</button>
    </form>
    {#if !txidOk}<p class="error">A Zcash transaction id is 64 hex digits, as the wallet shows it.</p>{/if}
    {#if memoErr}<p class="error">{memoErr}</p>{/if}
    {#if result}
      <div class="res" aria-live="polite" class:bad={!result.checks.memo}>
        {#if !result.checks.memo}
          <p><strong>Not a memo this pad wrote.</strong> {result.epochId ? `It names round ${numberOf(result.epochId)}, but that round paid no shielded batch, so no note carries this text.` : 'It is not the pad\'s receipt format, or it names no published round. A note from the pad reads exactly: SNARKS pad reward, epoch <round id>.'}</p>
        {:else if result.round}
          <p><strong>Verified for round <span class="mono">{numberOf(result.epochId ?? '')}</span></strong> ({result.epochId}), paid {when(result.round.at)}: one batched shielded transaction to <span class="mono">{result.round.shielded.count}</span> addresses, <span class="mono">{zec(result.round.shielded.totalZats)} ZEC</span> in all{#if result.coins.length}, for {result.coins.map((c) => `$${c.symbol || short(c.mint)}`).join(', ')}{/if}.</p>
          <p class="muted small">The memo is the same on every note of a round, so it shows which payout a note came from, not that the note is yours or its amount.</p>
          {#if result.checks.txid !== null}<p>{result.checks.txid ? 'The transaction id you gave is one of that round\'s batch.' : 'The transaction id you gave is not in that round\'s batch: the note may be from another round, or the id is mistyped.'}</p>{/if}
          <p class="links">{#each result.round.zcashTxids as z (z)}<span class="muted">Zcash transaction</span> <Addr value={z} head={10} tail={8} href={zcashTxUrl(z, zNet)} label="Zcash transaction id" />{/each}</p>
          {#if result.checks.commitment === null}
            {#if wallet}<button class="btn ghost" type="button" disabled={checking} onclick={() => check(true)}>{proving ? 'Sign in your wallet…' : 'Sign to check this round has a row for my wallet'}</button>
            <p class="muted small">One signature, no transaction. The pad answers yes or no and, on yes, your own rows of that round; nobody else can ask it about your wallet.</p>{/if}
          {:else if result.checks.commitment}
            <p><strong>This round has a row for your wallet.</strong>{#if result.rows?.length} Your share: {result.rows.map((r) => `${zec(r.shareZats, 6)} ZEC from $${symbolOf(r.mint)}`).join(', ')}.{/if}</p>
          {:else}
            <p>This round has no row for your wallet: the note is the pad's, but it was not paid to the wallet you connected.</p>
          {/if}
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .mine, .verify { display: grid; gap: var(--s-3); padding: var(--s-5); }
  .state { display: grid; gap: var(--s-3); justify-items: start; }
  .sum .mono { color: var(--ink); }
  .rows { display: grid; }
  .r { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1.4fr; gap: var(--s-3); align-items: center; padding: var(--s-2) 0; border-bottom: 1px solid var(--line); font-size: var(--t-14); }
  .r.head { padding-bottom: var(--s-1); }
  .coins { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-2); }
  .num { text-align: right; }
  .small { font-size: var(--t-14); }
  .shd { display: flex; gap: var(--s-2); align-items: flex-start; font-size: var(--t-16); max-width: 66ch; }
  .shd-body { display: grid; gap: var(--s-2); justify-items: start; min-width: 0; }
  .key { width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; margin-top: 0.4em; }
  .vform { display: flex; gap: var(--s-3); align-items: end; flex-wrap: wrap; }
  .grow { flex: 1 1 320px; }
  .txid { flex: 1 1 220px; }
  .res { display: grid; gap: var(--s-2); padding: var(--s-3) var(--s-4); background: var(--paper-3); border-radius: var(--r-md); justify-items: start; }
  .res.bad { box-shadow: inset 0 0 0 2px var(--bad); background: transparent; }
  .links { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); align-items: center; font-size: var(--t-14); }
  /* on a phone the signature takes a second line of the same row, so every payout keeps its link */
  @media (max-width: 640px) {
    .mine, .verify { padding: var(--s-4); }
    .r { grid-template-columns: 1.4fr 1fr 1fr; row-gap: var(--s-1); }
    .r .sig { grid-column: 1 / -1; }
    .hide-sm { display: none; }
  }
</style>
