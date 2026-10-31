<script lang="ts">
  import { api, ApiError, optinMessage, optoutMessage, OPTIN_ERRORS } from '../lib/api'
  import type { Epoch } from '../lib/types'
  import { zec, short, ago } from '../lib/format'
  import { wallet, friendly } from '../lib/wallet.svelte'
  import { shieldedView } from '../lib/shielded.svelte'
  import WalletButton from '../components/WalletButton.svelte'
  import SealButton from '../components/room/SealButton.svelte'
  import EnvelopeScene from '../components/room/EnvelopeScene.svelte'
  import HiddenList from '../components/HiddenList.svelte'
  import Taped from '../components/Taped.svelte'
  import MyRewards from '../components/MyRewards.svelte'

  // the proof this flow is real: the newest round that sent a shielded batch, read once
  let latestBatch = $state<Epoch | null>(null)
  $effect(() => { api.epochs().then((r) => (latestBatch = r.epochs.find((e) => e.shielded.count > 0 && e.shielded.zcashTxids.length > 0) ?? null), () => (latestBatch = null)) })

  let zaddr = $state('')
  let message = $state<string | null>(null)
  let busy = $state<string | null>(null)
  let err = $state<string | null>(null)
  let justDone = $state(false)
  let holdK = $state(0) // how far the user's own hold on the seal has gone

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
  <div class="door sdoor">
  <div class="top">
    <div class="intro">
      <h1 class="display">Get your rewards <em>shielded.</em></h1>
      <p class="lede measure muted">By default your rewards arrive as Solana ZEC every 48 hours. Add your Zcash address and they arrive as native ZEC in your own shielded wallet instead, in one batch about once a week. Shielded from the public, not from the pad's operator: the lists below say exactly what.</p>
      {#if latestBatch}
        <p class="was muted">This runs: the last batch went out {ago(latestBatch.at)}, <span class="mono">{zec(latestBatch.shielded.totalZats)} ZEC</span> to {latestBatch.shielded.count} shielded {latestBatch.shielded.count === 1 ? 'address' : 'addresses'}. <a href="#/treasury">See it with its transaction.</a></p>
      {/if}
    </div>
    <div class="draw"><Taped size="sm" /></div>
  </div>

  <div class="grid">
    <div class="steps panel onpaper">
      <span class="band hatch" aria-hidden="true"></span>
      <!-- the envelope, with Snarks in it: its pose is the state of this flow (what is connected, pasted, held, pending, confirmed or refused) -->
      <div class="envrow"><EnvelopeScene flow={{ connected: !!wallet.address, ready: !!wallet.address && !!addr && !hint, holdK, busy: !!busy, done: isOn, failed: !!err }} /></div>
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
                <WalletButton primary align="left" />
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
              <SealButton label="Hold to seal: get my rewards shielded" busy={busy} disabled={!wallet.address || !addr || !!hint} onseal={register} onhold={(k) => (holdK = k)} />
              {#if !wallet.address}<p class="small muted">Connect a wallet above first.</p>{:else if !addr || hint}<p class="small muted">Paste a valid Zcash address above first.</p>{/if}
            </div>
          </li>
        </ol>
      {/if}
      {#if err || shieldedView.error}<p class="error">{err ?? shieldedView.error}</p>{/if}
    </div>

    <div class="limits" id="hidden-list">
      <!-- the two ways your reward can travel, as the mail they resemble; the lists below say exactly what each hides -->
      <div class="paths" role="img" aria-label="Without opting in your reward travels like a postcard: wallet, amount and time public on Solana. Opted in it travels like a sealed envelope: address and your share inside, only the batch total showing.">
        <figure class="mail pc" aria-hidden="true">
          <span class="pc-stamp"></span>
          <span class="pc-row">your wallet <span class="pub mono">public</span></span>
          <span class="pc-row">your amount <span class="pub mono">public</span></span>
          <span class="pc-row">the time <span class="pub mono">public</span></span>
          <figcaption>Default: a postcard. Anyone on Solana reads it.</figcaption>
        </figure>
        <figure class="mail env" aria-hidden="true">
          <span class="env-flap"></span>
          <span class="env-seal hatch"></span>
          <span class="pc-row">batch total <span class="pub mono">public</span></span>
          <span class="pc-row">your address <span class="redact hatch"></span></span>
          <span class="pc-row">your share <span class="redact hatch"></span></span>
          <figcaption>Opted in: a sealed envelope. Your address and share stay inside.</figcaption>
        </figure>
      </div>
      <HiddenList />
      <section class="covers panel" aria-labelledby="covers-h">
        <h2 class="h3" id="covers-h">What this covers</h2>
        <ul>
          <li><strong>Only coins launched on SNARKS pad.</strong></li>
          <li><strong>Rounds run every 48 hours; the shielded share goes out about once a week</strong> in one shielded Zcash transaction. Your share goes out once it reaches <span class="mono">0.001 ZEC</span>; nothing is lost while it waits. Every payout is on the <a href="#/treasury">Payouts page</a>.</li>
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
</div>
</section>

<style>
  .pad { padding-top: var(--s-6); display: grid; gap: var(--s-5); }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--s-5); }
  .intro { display: grid; gap: var(--s-5); }
  .draw { flex: none; padding-top: var(--s-3); }
  /* the page name outranks the prose under it */
  .intro .display { font-size: clamp(30px, 2.6vw, 36px); }
  .lede { font-size: var(--t-20); line-height: 1.45; }
  .was { font-size: var(--t-14); }
  .was a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .sdoor { display: grid; gap: var(--s-5); padding: clamp(20px, 3vw, 40px); }
  .grid > :first-child { position: sticky; top: var(--s-4); }
  .grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: var(--s-7); align-items: start; margin-top: var(--s-4); }
  .envrow { display: flex; justify-content: center; padding-block: var(--s-2); }
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
  /* the two pieces of mail: a postcard read by anyone, an envelope sealed with the hatch */
  .paths { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-4); }
  .mail {
    position: relative; margin: 0; display: grid; gap: var(--s-2); align-content: start;
    background: var(--paper-2); border-radius: var(--r-xs); box-shadow: var(--sh-2), inset 0 1px 0 light-dark(transparent, rgba(239, 231, 218, .07));
    padding: var(--s-4); padding-top: var(--s-6); font-size: var(--t-14);
  }
  .pc { transform: rotate(-.6deg); }
  .env { transform: rotate(.6deg); overflow: hidden; }
  .pc-stamp { position: absolute; top: var(--s-2); right: var(--s-2); width: 22px; height: 26px; border-radius: var(--r-xs); background: var(--paper-3); box-shadow: inset 0 0 0 1.5px var(--line); }
  .env-flap { position: absolute; inset: 0 0 auto 0; height: 18px; background: var(--paper-3); clip-path: polygon(0 0, 100% 0, 50% 100%); }
  .env-seal { position: absolute; top: 10px; left: 50%; width: 16px; height: 16px; margin-left: -8px; border-radius: var(--r-full); }
  .pc-row { display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); color: var(--ink-2); }
  .pub { font-size: var(--t-12); color: var(--ink-3); text-transform: uppercase; letter-spacing: .06em; }
  .redact { width: 72px; height: 10px; border-radius: var(--r-xs); }
  .mail figcaption { padding-top: var(--s-2); border-top: 1px solid var(--line); color: var(--ink); font-weight: 700; font-size: var(--t-14); }
  @media (max-width: 720px) { .paths { grid-template-columns: 1fr; } .pc, .env { transform: none; } }
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
