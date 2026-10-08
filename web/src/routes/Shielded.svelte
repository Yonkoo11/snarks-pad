<script lang="ts">
  import { api, ApiError, optinMessage, optoutMessage, OPTIN_ERRORS } from '../lib/api'
  import { zec, short } from '../lib/format'
  import { wallet, friendly } from '../lib/wallet.svelte'
  import { shieldedView } from '../lib/shielded.svelte'
  import WalletButton from '../components/WalletButton.svelte'
  import HiddenList from '../components/HiddenList.svelte'
  import Taped from '../components/Taped.svelte'
  import MyRewards from '../components/MyRewards.svelte'

  let zaddr = $state('')
  let message = $state<string | null>(null)
  let busy = $state<string | null>(null)
  let err = $state<string | null>(null)
  let justDone = $state(false)

  // What this page knows about the wallet's shielded delivery. A page load learns nothing: since v2.9 the engine shows whether a wallet opted in, its masked address and
  // what is pending only against the wallet's own signature, so the page asks for one signature when the user wants to see their settings (`status`, shared with the
  // profile's tabs and My rewards). After an opt-in or a stop it already knows the answer without asking: `known`, and the masked address of what was just registered.
  const status = $derived(shieldedView.of(wallet.address))
  let known = $state<'on' | 'off' | null>(null)
  let maskedNow = $state<string | null>(null)
  const isOn = $derived(status ? status.optedIn : known === 'on')
  const isOff = $derived(status ? !status.optedIn : known === 'off')

  async function reveal() {
    if (!wallet.address) return
    err = null
    if (await shieldedView.read(wallet.address)) { known = null; justDone = false }
  }
  $effect(() => {
    void wallet.address
    err = null; justDone = false; message = null; known = null; maskedNow = null
  })

  const addr = $derived(zaddr.trim())
  const looksUnified = $derived(/^(u|utest|uregtest)1/.test(addr))
  const hint = $derived(
    addr === '' ? null
    : /^(t1|t3|tm|zs1|ztestsapling)/.test(addr) ? OPTIN_ERRORS.no_orchard_receiver
    : !looksUnified ? OPTIN_ERRORS.bad_address : null
  )

  async function register() {
    if (!wallet.address || !addr) return
    err = null
    const w = wallet.address
    try {
      busy = 'Getting a fresh request…'
      const { nonce } = await api.optinNonce(w)
      const msg = optinMessage(w, addr, nonce)
      message = msg
      busy = 'Sign the message in your wallet…'
      const signature = await wallet.signMessage(msg)
      busy = 'Checking the signature…'
      await api.optin({ wallet: w, zcashAddress: addr, nonce, signature })
      if (wallet.address !== w) return // the wallet was changed while the request ran: what happened is not what this page shows for the new one
      maskedNow = short(addr, 4, 4) // the same first and last four characters the engine would show
      shieldedView.forget(); known = 'on'
      zaddr = ''; message = null; justDone = true
    } catch (e) {
      err = e instanceof ApiError ? OPTIN_ERRORS[e.code] ?? `The pad refused this (${e.code}).` : friendly(e)
    } finally { busy = null }
  }

  async function stop() {
    if (!wallet.address) return
    err = null
    const w = wallet.address
    try {
      busy = 'Getting a fresh request…'
      const { nonce } = await api.optinNonce(w)
      busy = 'Sign the message in your wallet…'
      const signature = await wallet.signMessage(optoutMessage(w, nonce))
      await api.optout({ wallet: w, nonce, signature })
      if (wallet.address !== w) return // as in register(): the answer belongs to the wallet that signed, not to the one connected now
      shieldedView.forget(); known = 'off'; maskedNow = null
      justDone = false
    } catch (e) {
      err = e instanceof ApiError ? OPTIN_ERRORS[e.code] ?? e.code : friendly(e)
    } finally { busy = null }
  }
</script>

<section class="wrap pad">
  <div class="top">
    <div class="intro">
      <h1 class="display">Get your rewards <em>shielded.</em></h1>
      <p class="lede measure muted">By default your rewards arrive as Solana ZEC. Add your Zcash address and they arrive as native ZEC in your own shielded wallet instead, once a week.</p>
    </div>
    <div class="draw"><Taped size="sm" /></div>
  </div>

  <div class="grid">
    <div class="steps panel">
      <span class="band hatch" aria-hidden="true"></span>
      {#if isOn}
        <div class="on">
          <p class="label">Shielded delivery is on</p>
          <p class="h3">{justDone ? 'Done. ' : ''}Rewards for <span class="mono">{short(wallet.address ?? '')}</span> now go to <span class="mono">{status?.zcashAddressMasked ?? maskedNow}</span>.</p>
          {#if status}
            <p class="muted">Waiting for the next weekly batch: <span class="mono">{zec(status.pendingZats, 6)} ZEC</span>. The pad never shows your full address again, not even to you.</p>
          {:else}
            <p class="muted">What is waiting for the next weekly batch is private too: the pad shows it only to you, after you sign.</p>
            <button class="btn" type="button" onclick={reveal} disabled={shieldedView.busy}>{shieldedView.busy ? 'Waiting for your wallet…' : 'Show my settings'}</button>
            <p class="small muted">One signature, no transaction, no fee. Your wallet shows the exact text first.</p>
          {/if}
          <button class="btn ghost" type="button" onclick={stop} disabled={!!busy}>{busy ?? 'Stop shielded delivery'}</button>
          <p class="small muted">Stopping sends your future rewards back to your Solana wallet as Solana ZEC.</p>
        </div>
      {:else}
        {#if wallet.address}
          <div class="peek">
            {#if isOff}
              <p class="muted">Shielded delivery is off for this wallet. Your rewards arrive as Solana ZEC until you set it up below.</p>
            {:else}
              <p class="muted">Already opted in with this wallet? Whether it did is private: the pad shows it only to you, after you sign.</p>
              <button class="btn" type="button" onclick={reveal} disabled={shieldedView.busy}>{shieldedView.busy ? 'Waiting for your wallet…' : 'Show my settings'}</button>
              <p class="small muted">One signature, no transaction, no fee. Your wallet shows the exact text first.</p>
            {/if}
          </div>
        {/if}
        <ol>
          <li class:done={!!wallet.address}>
            <span class="n" aria-hidden="true">1</span>
            <div class="body">
              <p class="h3">Connect the Solana wallet that holds your coins</p>
              {#if wallet.address}
                <p class="muted">Connected: <span class="mono">{short(wallet.address, 6, 6)}</span></p>
              {:else}
                <WalletButton primary />
              {/if}
            </div>
          </li>
          <li>
            <span class="n" aria-hidden="true">2</span>
            <div class="body">
              <label class="field">
                <span class="h3">Paste your Zcash unified address</span>
                <textarea class="input mono addr" rows="3" spellcheck="false" autocomplete="off" placeholder="u1…" bind:value={zaddr} aria-invalid={!!hint} aria-describedby="addr-help"></textarea>
                <small id="addr-help">Starts with u1. Your wallet's Receive screen shows it. Transparent (t) and older Sapling-only addresses are not accepted.</small>
              </label>
              {#if hint}<p class="error">{hint}</p>{/if}
            </div>
          </li>
          <li>
            <span class="n" aria-hidden="true">3</span>
            <div class="body">
              <p class="h3">Sign a message. No transaction, no fee.</p>
              {#if message}
                <pre class="msg mono" aria-label="Message you are signing">{message}</pre>
              {:else}
                <p class="muted">Your wallet shows the exact text before you sign: this wallet, this Zcash address, and a one-time code.</p>
              {/if}
              <button class="btn" class:primary={!!wallet.address} onclick={register} disabled={!wallet.address || !addr || !!hint || !!busy}>{busy ?? 'Sign and get my rewards shielded'}</button>
            </div>
          </li>
        </ol>
      {/if}
      {#if err || shieldedView.error}<p class="error">{err ?? shieldedView.error}</p>{/if}
    </div>

    <div class="limits" id="hidden-list">
      <HiddenList />
      <section class="covers panel" aria-labelledby="covers-h">
        <h2 class="h3" id="covers-h">What this covers</h2>
        <ul>
          <li><strong>Only coins launched on SNARKS pad.</strong></li>
          <li><strong>Paid once a week</strong> in one shielded Zcash transaction. Your share goes out once it reaches <span class="mono">0.001 ZEC</span>; nothing is lost while it waits. Every payout is on the <a href="#/treasury">Payouts page</a>.</li>
          <li><strong>Tested with Zodl 3.8.0 or newer.</strong> Other Zcash wallets should work if they show a unified address starting <span class="mono">u1</span>.</li>
          <li><strong>Stop any time</strong> with one more signature on this page. Your rewards then go back to your Solana wallet.</li>
        </ul>
      </section>
      <section class="move" aria-labelledby="move-h">
        <h2 class="h3" id="move-h">Moving ZEC between Solana and Zcash</h2>
        <p class="small"><strong>ZEC on Solana to your Zcash wallet:</strong> <a href="https://zechub.wiki/using-zcash/solana-zec-to-shielded" target="_blank" rel="noopener noreferrer">ZecHub's step-by-step guide</a>.</p>
        <p class="small"><strong>Bring ZEC from your Zcash wallet:</strong> <a href="https://near.com" target="_blank" rel="noopener noreferrer">near.com</a> swaps native ZEC to Solana ZEC. We have not tested that direction, so try a small amount first and check you receive the token ending <span class="mono">QXaS</span>.</p>
      </section>
    </div>
  </div>

  <div class="mine-wrap"><MyRewards wallet={wallet.address} /></div>
</section>

<style>
  .pad { padding-top: var(--s-6); display: grid; gap: var(--s-5); }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s-5); }
  .intro { display: grid; gap: var(--s-5); }
  .draw { flex: none; padding-top: var(--s-3); }
  .lede { font-size: var(--t-20); line-height: 1.45; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: var(--s-7); align-items: start; margin-top: var(--s-4); }
  .steps { position: relative; overflow: hidden; padding: var(--s-6); display: grid; gap: var(--s-4); }
  .band { position: absolute; inset: 0 0 auto 0; height: 6px; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-6); }
  li { display: grid; grid-template-columns: 40px 1fr; gap: var(--s-4); }
  .n {
    width: 36px; height: 36px; display: grid; place-items: center; font-family: var(--f-mono); font-weight: 500; font-size: var(--t-16);
    background: var(--paper-3); border-radius: var(--r-full);
  }
  li.done .n { background: var(--ink); color: var(--paper); }
  .body { display: grid; gap: var(--s-3); justify-items: start; min-width: 0; }
  .body .field { width: 100%; }
  .body .field > span.h3 { font-size: var(--t-20); }
  .addr { font-size: var(--t-16); word-break: break-all; }
  .msg { margin: 0; padding: var(--s-3) var(--s-4); background: var(--paper-3); border-radius: var(--r-sm); font-size: var(--t-12); white-space: pre-wrap; word-break: break-all; width: 100%; }
  .on { display: grid; gap: var(--s-3); justify-items: start; }
  .peek { display: grid; gap: var(--s-2); justify-items: start; }
  .small { font-size: var(--t-14); }
  .covers { padding: var(--s-5); display: grid; gap: var(--s-3); }
  .covers li { display: block; }
  .covers ul { margin: 0; padding-left: var(--s-5); display: grid; gap: var(--s-2); font-size: var(--t-14); }
  .move { display: grid; gap: var(--s-3); }
  .move a, .covers a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .limits { display: grid; gap: var(--s-5); padding-top: var(--s-4); }
  .limits :global(.hl) { grid-template-columns: 1fr; gap: var(--s-5); }
  .mine-wrap { display: grid; gap: var(--s-5); margin-top: var(--s-4); }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; gap: var(--s-6); }
    .steps { padding: var(--s-5); }
    .lede { font-size: var(--t-16); }
  }
  @media (max-width: 640px) {
    .draw :global(.taped) { width: 84px; padding: 4px; }
    li { grid-template-columns: 32px 1fr; gap: var(--s-3); }
    .n { width: 30px; height: 30px; font-size: var(--t-14); }
  }
</style>
