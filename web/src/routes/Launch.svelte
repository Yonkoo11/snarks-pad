<script lang="ts">
  import { api, ApiError, onMode } from '../lib/api'
  import { toZats, feeLabel, zec, short } from '../lib/format'
  import { checkX, checkWebsite, checkTelegram, socialsPayload, lookalikeKey } from '../lib/socials'
  import { confirmLineOfTier, feeLineOfTier, maxFirstBuy, zatsText, type FeeSplitOfTier } from '../lib/launch'
  import { checkCreatorWallet, SAME_WALLET } from '../lib/creatorWallet'
  import { readZecBalance } from '../lib/holding'
  import type { PadMode, Tier } from '../lib/types'
  import { wallet, friendly } from '../lib/wallet.svelte'
  import { refusedBeforeSend, type Landing } from '../lib/send'
  import { solanaTxUrl } from '../lib/explorer'
  import { coinLink, xIntentUrl } from '../lib/share'
  import ImageDrop from '../components/ImageDrop.svelte'
  import LaunchPreview from '../components/LaunchPreview.svelte'
  import WalletButton from '../components/WalletButton.svelte'

  let name = $state('')
  let symbol = $state('')
  let description = $state('')
  // The coin's picture comes from the creator's device (components/ImageDrop.svelte): `imageUrl` is where the engine stored its copy and is what the
  // launch carries, `shown` is what to draw now, and `hold` keeps Launch off while the copy travels or until a failed upload is dealt with.
  let imageUrl = $state('')
  let shown = $state('')
  let hold = $state<'sending' | 'failed' | null>(null)
  // The creator's links: typed as a handle or a link, checked here (lib/socials.ts), checked again by the engine, sent as https URLs only.
  let webIn = $state('')
  let xIn = $state('')
  let tgIn = $state('')
  let linksOpen = $state(false)
  const webCheck = $derived(checkWebsite(webIn))
  const xCheck = $derived(checkX(xIn))
  const tgCheck = $derived(checkTelegram(tgIn))
  const socialsOk = $derived(!xCheck.error && !webCheck.error && !tgCheck.error)
  const linkCount = $derived(Object.keys(socialsPayload(xIn, webIn, tgIn) ?? {}).length)
  // a link that does not pass must be seen, so the section opens itself
  $effect(() => { if (!socialsOk) linksOpen = true })
  // a name or ticker already on the pad: the form says so and asks for a tick before it launches a lookalike
  let existing = $state<{ name: string; symbol: string }[]>([])
  $effect(() => { api.coins({ limit: 100 }).then((r) => (existing = r.coins.map((c) => ({ name: c.name, symbol: c.symbol }))), () => (existing = [])) })
  const lookalike = $derived.by(() => {
    const n = lookalikeKey(name), s = lookalikeKey(symbol)
    return existing.find((c) => (n && lookalikeKey(c.name) === n) || (s && lookalikeKey(c.symbol) === s)) ?? null
  })
  let lookalikeOk = $state(false)
  $effect(() => { void lookalike; lookalikeOk = false })
  // The fee is one of the pad's tiers (contract v2.3, GET /tiers): each tier is a permanent Meteora config, so the creator picks it once at
  // launch and it never changes. Without the menu (an older engine, or it did not answer) only the SNARKS tier exists: 1% of every trade, paid in ZEC,
  // of which holders get 60%, the team 20% and Meteora 20%. The one line under the picker (lib/launch.ts feeLineOfTier) says it in the same words for a tier of the menu and for this one.
  const FEE_PCT = 1
  const HOLDER_PCT = 60
  const TEAM_PCT = 20
  const SNARKS_TIER: FeeSplitOfTier = { feeBps: FEE_PCT * 100, creatorShareBps: 0, holderShareBps: HOLDER_PCT * 100, teamShareBps: TEAM_PCT * 100, meteoraShareBps: (100 - HOLDER_PCT - TEAM_PCT) * 100 }
  let tiers = $state<Tier[] | null | undefined>(undefined) // undefined while the menu loads, null when the engine has none
  let quoteMint = $state<string | null>(null) // the token every coin of this pad is paired with, from the same answer (v2.7)
  let feeTier = $state(100)
  let understood = $state(false) // the 10% tier asks for a second confirmation
  $effect(() => { api.tiers().then((r) => { tiers = r.tiers; quoteMint = r.quoteMint ?? null }, () => (tiers = null)) })
  const tier = $derived(tiers?.find((t) => t.feeBps === feeTier) ?? null)
  // only the tiers this network has (research/COPY-AUDIT.md: a list of fee levels marked 'not created on this network yet' read as unfinished); with one, no picker
  const offered = $derived((tiers ?? []).filter((t) => t.available))
  const feeLine = $derived(tier ? feeLineOfTier(tier) : tiers === null ? feeLineOfTier(SNARKS_TIER) : null)
  const CONFIRM_FEE_BPS = 1000
  const tierOk = $derived(tiers === null || (!!tier && tier.available && (feeTier < CONFIRM_FEE_BPS || understood)))
  // The Creator wallet (contract v2.8): the pool is handed to it in the launch transaction, so only it can claim the creator's share of the fee and the launcher never can.
  // It means something only on a tier that has a creator share; on the 1% tier (and on an engine with no menu, which has only that tier) the field is not used and its value is never
  // sent. A real, different wallet is shown back in full and needs a tick, which belongs to the address it was given for and goes when the address changes.
  let walletIn = $state('')
  let walletTick = $state(false)
  const creatorCheck = $derived(checkCreatorWallet(walletIn, wallet.address))
  const noShare = $derived(tiers === null || (!!tier && tier.creatorShareBps === 0))
  const handover = $derived(creatorCheck.kind === 'ok' && !noShare ? creatorCheck.address : null)
  const creatorOk = $derived(noShare || (creatorCheck.kind !== 'bad' && (handover === null || walletTick)))
  $effect(() => { void walletIn; walletTick = false })
  const tierLabel = (t: Tier) => (t.feeBps === 100 ? 'SNARKS tier' : t.postGraduationFeeBps < t.feeBps ? `drops to ${t.postGraduationFeeBps / 100}% after graduation` : 'about the same after graduation')
  // The first buy: Max is what the wallet holds of Solana ZEC, never more than the curve can take (lib/launch.ts). A buy above either would fail on chain, so the form says so and holds Launch.
  let firstBuy = $state('')
  let balance = $state<bigint | null>(null) // null while it loads, and when it cannot be read
  $effect(() => {
    const w = wallet.address
    balance = null
    if (w) readZecBalance(w, quoteMint).catch(() => null).then((b) => { if (wallet.address === w) balance = b })
  })
  let busy = $state<string | null>(null)
  let err = $state<string | null>(null)
  let launched = $state<string | null>(null)
  let launchedTo = $state<string | null>(null) // the Creator wallet the launch handed the pool to, for the done panel
  // A launch Solana took but the pad could not record yet (its engine records it within minutes), or one sent and not yet seen: the done panel says which.
  let launchNote = $state<'recording' | 'sent' | null>(null)
  let launchSig = $state<string | null>(null)
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))
  let touched = $state(false)

  const symOk = $derived(/^[A-Z0-9]{2,10}$/.test(symbol))
  const nameOk = $derived(name.trim().length >= 2 && name.trim().length <= 32)
  const buyZats = $derived(firstBuy.trim() === '' ? 0n : toZats(firstBuy))
  const maxBuy = $derived(maxFirstBuy(balance, tier?.migrationThresholdZats))
  const buyShort = $derived(buyZats !== null && balance !== null && buyZats > balance)
  const buyTooBig = $derived(buyZats !== null && !buyShort && maxBuy !== null && buyZats > maxBuy)
  const buyOk = $derived(buyZats !== null && !buyShort && !buyTooBig)
  const ready = $derived(nameOk && symOk && buyOk && !!wallet.address && tierOk && socialsOk && creatorOk && (!lookalike || lookalikeOk) && hold === null)
  const useMax = () => { if (maxBuy !== null && maxBuy > 0n) firstBuy = zatsText(maxBuy) }

  const EXPIRED = 'Your wallet approval took longer than Solana allows (about a minute), so nothing was sent and nothing was charged. Press Launch to try again.'
  const NEEDS_SOL = 'Your wallet needs a little more SOL to launch. Keep about 0.02 SOL for the network fee and the new coin\'s accounts.'
  const NEEDS_ZEC = 'Your wallet holds less Solana ZEC than the first buy. Lower the first buy, or add ZEC and try again.'

  /** A wallet or network error in plain words: never the raw dump (it goes to the console for us). */
  function sendError(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e)
    const why = refusedBeforeSend(m)
    if (why === 'expired') return EXPIRED
    if (why === 'needs_sol') return NEEDS_SOL
    if (why === 'short_of_token') return NEEDS_ZEC
    if (/reject|denied|cancel/i.test(m)) return friendly(e)
    console.error('[launch]', e)
    return 'Solana refused the launch before it was sent, so nothing was charged. Check your wallet\'s balance and try again.'
  }

  function launchError(e: unknown): string {
    if (!(e instanceof ApiError)) return sendError(e)
    if (e.code === 'needs_sol') return NEEDS_SOL
    if (e.code === 'needs_zec') return NEEDS_ZEC
    if (e.code === 'launch_would_fail') return 'Solana would refuse this launch as it stands, so the pad stopped it before your wallet opened. Nothing was charged. Try again in a moment.'
    if (e.code === 'unknown_launch') return 'The launch waited too long for your wallet, so the pad let it go. Nothing was sent. Press Launch again.'
    if (e.code === 'tx_mismatch' || (e.code === 'bad_request' && e.field === 'tx')) return 'Your wallet returned the launch changed in a way the pad cannot accept, so nothing was sent. Press Launch again; if it happens again, tell us which wallet you use.'
    if (e.code === 'bad_image_url') return 'The pad no longer has that picture. Remove it and pick it again.'
    if (e.code === 'tier_unavailable') return 'That fee level is not available on this network yet. Pick another one.'
    if (e.code === 'bad_creator_wallet') return 'The pad cannot use that wallet as the Creator wallet. Check the address, or leave it blank.'
    if (e.code === 'bad_request' && e.field?.startsWith('socials')) return 'The pad could not accept one of your links. Check the Links section.'
    return `The pad refused this launch (${e.code}).`
  }

  /** Asks the engine to record the launch, a few times: it reads the chain itself and the transaction may take a moment to show there. */
  async function record(sig: string, mint: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      try { await api.confirmLaunch(sig, mint); return true }
      catch (e) {
        if (e instanceof ApiError && e.code === 'tx_failed') return false
        await new Promise((r) => setTimeout(r, 4_000))
      }
    }
    return false
  }

  /** What the page does with each outcome of the send (lib/send.ts). A launch Solana took is always shown as live, recorded or not. */
  async function afterSend(landing: Landing, mint: string) {
    if (landing.status === 'expired') { err = EXPIRED; return }
    if (landing.status === 'failed') {
      console.error('[launch] failed on chain', landing.sig, landing.err)
      err = 'Solana refused the launch, so no coin was made. Only the network fee was spent (under a cent). Try again.'
      return
    }
    busy = 'Recording the launch…'
    const recorded = await record(landing.sig, mint)
    launchedTo = handover && walletTick ? handover : null
    launchSig = landing.sig
    launchNote = recorded ? null : landing.status === 'confirmed' ? 'recording' : 'sent'
    launched = mint
  }

  let linkCopied = $state(false)
  async function copyLaunchLink() {
    if (!launched) return
    try { await navigator.clipboard.writeText(coinLink(launched, wallet.address)); linkCopied = true; setTimeout(() => (linkCopied = false), 2_000) }
    catch { linkCopied = false }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault(); touched = true; err = null
    if (!ready || !wallet.address) return
    try {
      busy = 'Preparing the launch…'
      const socials = socialsPayload(xIn, webIn, tgIn)
      const { tx, mint } = await api.launchTx({
        creator: wallet.address, name: name.trim(), symbol, description: description.trim(), imageUrl,
        ...(buyZats && buyZats > 0n ? { initialBuyZec: buyZats.toString() } : {}),
        ...(tiers && feeTier !== 100 ? { feeTier } : {}),
        ...(socials ? { socials } : {}),
        ...(handover && walletTick ? { creatorWallet: handover } : {}),
      })
      busy = 'Confirm in your wallet…'
      // The wallet signs first; the engine checks that copy and adds the coin's own signature (engine dbc/cosign.ts); then the page sends it.
      const signed = await wallet.signOnly(tx)
      busy = 'Sending the launch…'
      const { tx: full } = await api.launchCosign(mint, signed)
      await afterSend(await wallet.sendSigned(full), mint)
    } catch (e2) {
      if (e2 instanceof ApiError && e2.field?.startsWith('socials')) linksOpen = true
      err = launchError(e2)
    } finally { busy = null }
  }
</script>

<section class="wrap pad">
  <h1 class="display">Launch a coin that pays in ZEC.</h1>

  {#if launched}
    <div class="panel done">
      {#if launchNote === 'sent'}
      <h2 class="h2">${symbol} was sent to Solana.</h2>
      <p class="muted">Solana has not confirmed it yet. If it lands, the pad records it within a few minutes and its page opens below.{#if launchSig && solanaTxUrl(launchSig, mode)} <a href={solanaTxUrl(launchSig, mode)} target="_blank" rel="noopener noreferrer">Check it on the explorer</a>.{/if}</p>
      {:else}
      <h2 class="h2">${symbol} is live.</h2>
      {#if launchNote === 'recording'}<p class="muted">The pad is still recording it; its page appears within a few minutes.</p>{/if}
      {/if}
      <p class="muted">Holders start earning ZEC from the next payout.{#if tier && tier.creatorShareBps > 0} Claim your share of the fee from the coin page with this wallet.{/if}</p>
      {#if launchedTo}<p class="muted">Creator fees go to <span class="mono" title={launchedTo}>{short(launchedTo, 6, 6)}</span>; only that wallet can claim them.</p>{/if}
      <div class="donebtns">
        <a class="btn primary" href="#/coin/{launched}">Open ${symbol}</a>
        <a class="btn ghost" href={xIntentUrl(symbol, coinLink(launched, wallet.address))} target="_blank" rel="noopener noreferrer">Post on X</a>
        <button type="button" class="btn ghost" onclick={copyLaunchLink}>{linkCopied ? 'Link copied' : 'Copy link'}</button>
      </div>
    </div>
  {:else}
  <div class="grid">
    <form class="form panel" onsubmit={submit} novalidate>
      <div class="two">
        <label class="field">
          <span>Name</span>
          <input class="input" maxlength="32" bind:value={name} placeholder="Release The Snarks" aria-invalid={touched && !nameOk} />
          {#if touched && !nameOk}<small class="error">2 to 32 characters.</small>{/if}
        </label>
        <label class="field">
          <span>Ticker</span>
          <input class="input mono" maxlength="10" value={symbol} oninput={(e) => (symbol = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="SNARKS" aria-invalid={touched && !symOk} />
          {#if touched && !symOk}<small class="error">2 to 10 letters or digits.</small>{/if}
        </label>
      </div>

      {#if lookalike}
        <div class="warn look" role="note">
          <p>A coin called <strong>{lookalike.name}</strong> (<span class="mono">${lookalike.symbol}</span>) already exists on this pad. Yours would look like it, and buyers may mix the two up.</p>
          <label class="confirm"><input type="checkbox" bind:checked={lookalikeOk} /> <span>I know. Launch mine anyway.</span></label>
        </div>
      {/if}

      <label class="field">
        <span>Description</span>
        <textarea class="input" maxlength="280" bind:value={description} placeholder="What is this coin about?"></textarea>
        <small>{description.length}/280</small>
      </label>

      <ImageDrop bind:imageUrl bind:shown bind:hold {symbol} />

      <details class="socials" bind:open={linksOpen}>
        <summary>
          <span class="s-t">Links (optional)</span>
          {#if linkCount > 0 && !linksOpen}<span class="s-c">{linkCount} added</span>{/if}
          <span class="chev" aria-hidden="true"></span>
        </summary>
        <div class="three">
          <label class="field">
            <span>Website</span>
            <input class="input" type="url" autocomplete="off" placeholder="https://…" bind:value={webIn} aria-invalid={!!webCheck.error} />
            {#if webCheck.error}<small class="error">{webCheck.error}</small>{/if}
          </label>
          <label class="field">
            <span>X</span>
            <input class="input" autocomplete="off" placeholder="@handle or x.com/handle" bind:value={xIn} aria-invalid={!!xCheck.error} />
            {#if xCheck.error}<small class="error">{xCheck.error}</small>{/if}
          </label>
          <label class="field">
            <span>Telegram</span>
            <input class="input" autocomplete="off" placeholder="@name or t.me/name" bind:value={tgIn} aria-invalid={!!tgCheck.error} />
            {#if tgCheck.error}<small class="error">{tgCheck.error}</small>{/if}
          </label>
        </div>
        <small class="s-note">Shown on the coin page as links. Only https links are kept.</small>
      </details>

      <div class="field fees">
        {#if tiers && offered.length > 1}
          <fieldset class="tiers">
            <legend>Trading fee on this coin</legend>
            <div class="tier-grid" role="radiogroup" aria-label="Trading fee tier">
              {#each offered as t (t.feeBps)}
                <label class="tier" class:on={feeTier === t.feeBps} class:off={!t.available}>
                  <input type="radio" name="fee-tier" value={t.feeBps} checked={feeTier === t.feeBps} disabled={!t.available} onchange={() => { feeTier = t.feeBps; understood = false }} />
                  <span class="mono t-pct">{feeLabel({ feeBps: t.feeBps, stage: 'curve' })}</span>
                  <span class="t-sub">{tierLabel(t)}</span>
                </label>
              {/each}
            </div>
          </fieldset>
        {:else if tiers === undefined}
          <span>Trading fee on this coin</span>
          <div class="skel tiers-sk" aria-busy="true" aria-label="Loading the fee levels"></div>
        {:else}
          <span>Trading fee</span>
        {/if}
        {#if feeLine}<p class="fee-fixed"><span class="mono">{feeLine.fee}</span>{feeLine.rest}</p>{/if}
        {#if tier && tier.feeBps >= CONFIRM_FEE_BPS}
          <label class="confirm"><input type="checkbox" bind:checked={understood} /> <span>{confirmLineOfTier(tier)}</span></label>
        {/if}
      </div>

      <div class="field">
        <span id="first-buy-l">First buy (optional, ZEC)</span>
        <div class="buy-row">
          <input class="input mono" inputmode="decimal" placeholder="0" bind:value={firstBuy} aria-labelledby="first-buy-l" aria-invalid={!buyOk} />
          <button class="btn ghost max" type="button" onclick={useMax} disabled={maxBuy === null || maxBuy <= 0n}
            title="Spends all the Solana ZEC in your wallet, up to what the curve can take. The trading fee comes out of the amount; nothing is added on top.">Max</button>
        </div>
        {#if buyZats === null}<small class="error">Type a number, like 0.5</small>
        {:else if buyShort}<small class="error"><span>Your wallet holds <span class="mono">{zec(balance ?? 0n)} ZEC</span> on Solana, less than this buy.</span></small>
        {:else if buyTooBig}<small class="error"><span>That is more than the curve can take at launch. <span class="mono">{zec(maxBuy ?? 0n, 2)} ZEC</span> is the most.</span></small>
        {:else if wallet.address}<small>{balance === null ? 'Your Solana ZEC balance could not be read.' : `Your wallet holds ${zec(balance)} ZEC on Solana.`}</small>
        {:else}<small>Connect a wallet to see how much you can spend.</small>{/if}
      </div>

      {#if !noShare}
      <div class="creator">
        <label class="field">
          <span>Creator wallet (optional)</span>
          <input class="input mono" autocomplete="off" spellcheck="false" placeholder="Wallet address" bind:value={walletIn} aria-invalid={creatorCheck.kind === 'bad'} />
          <small>Receives your share of the trading fee. Leave blank to use the connected wallet.</small>
          {#if creatorCheck.kind === 'bad'}<small class="error">{creatorCheck.error}</small>
          {:else if creatorCheck.kind === 'same'}<small>{SAME_WALLET}</small>{/if}
        </label>
        {#if handover}
          <div class="echo">
            <p class="mono shown">{handover}</p>
            <p class="warn" role="note">Only this wallet can claim the creator fee, and the launch cannot be undone. Check every character.</p>
            <label class="confirm"><input type="checkbox" bind:checked={walletTick} /> <span>I checked this address.</span></label>
          </div>
        {/if}
      </div>
      {/if}

      {#if wallet.address}
        <div class="go">
          <button class="btn primary block" type="submit" disabled={!!busy || hold !== null || !tierOk || !socialsOk || !creatorOk || (!!lookalike && !lookalikeOk) || !buyOk}>{busy ?? (hold === 'sending' ? 'Uploading the image…' : `Launch ${symbol ? '$' + symbol : 'coin'}`)}</button>
          {#if hold === 'failed'}<small class="hint">The picture did not upload. Try again or remove it, then launch.</small>{/if}
        </div>
      {:else}
        <div class="connect"><WalletButton primary label="Connect wallet to launch" /></div>
      {/if}
      {#if err}<p class="error">{err}</p>{/if}
    </form>

    <aside class="preview">
      <p class="label">Preview</p>
      <LaunchPreview {name} {symbol} {description} imageSrc={shown} {tier} loading={tiers === undefined} />
    </aside>
  </div>
  {/if}
</section>

<style>
  .pad { padding-top: var(--s-6); display: grid; gap: var(--s-6); }
  .grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--s-7); align-items: start; }
  .form { display: grid; gap: var(--s-5); padding: var(--s-6); }
  .two { display: grid; grid-template-columns: 1.4fr 1fr; gap: var(--s-4); }
  .fee-fixed { margin: 0; color: var(--ink-2); font-size: var(--t-14); }
  .tiers { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: var(--s-2); }
  .tiers-sk { height: 248px; }
  .tiers legend { font-weight: 700; font-size: var(--t-14); padding: 0; margin-bottom: var(--s-2); }
  .tier-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s-2); }
  .tier { position: relative; display: grid; gap: var(--s-1); align-content: start; padding: var(--s-3); border-radius: var(--r-md); background: var(--paper-2); box-shadow: inset 0 0 0 2px var(--line); cursor: pointer; transition: box-shadow var(--d-fn) var(--ease); }
  @media (hover: hover) { .tier:hover:not(.off):not(.on) { box-shadow: inset 0 0 0 2px var(--ink-3); } }
  .tier.on { box-shadow: inset 0 0 0 2px var(--ink); }
  .tier.off { opacity: .55; cursor: not-allowed; }
  .tier input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: inherit; }
  .tier:focus-within { outline: 3px solid var(--pink); outline-offset: 2px; }
  .t-pct { font-size: var(--t-20); font-weight: 500; }
  .t-sub { font-size: var(--t-12); color: var(--ink-2); line-height: 1.3; }
  .warn { margin: 0; padding: var(--s-3) var(--s-4); border-radius: var(--r-md); background: var(--warn-bg); color: var(--warn-ink); font-size: var(--t-14); }
  .confirm { display: flex; gap: var(--s-3); align-items: flex-start; font-size: var(--t-14); font-weight: 700; }
  .confirm input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
  .connect :global(.btn) { width: 100%; }
  .go { display: grid; gap: var(--s-2); }
  .hint { color: var(--ink-2); font-size: var(--t-14); }
  .buy-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-2); }
  .max { min-width: 88px; }
  .preview { display: grid; gap: var(--s-3); position: sticky; top: var(--s-4); }
  /* the links section: a row that opens, so the form shows the three links only to a creator who has any */
  .socials { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); display: grid; gap: var(--s-3); }
  .socials summary { display: flex; align-items: center; gap: var(--s-3); min-height: 48px; cursor: pointer; font-weight: 700; font-size: var(--t-14); list-style: none; }
  .socials summary::-webkit-details-marker { display: none; }
  .socials[open] summary { margin-bottom: calc(-1 * var(--s-1)); }
  .s-c { font-weight: 400; color: var(--ink-2); }
  .chev { margin-left: auto; width: 9px; height: 9px; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2); transform: translateY(-2px) rotate(45deg); transition: transform var(--d-fn) var(--ease); }
  .socials[open] .chev { transform: translateY(2px) rotate(225deg); }
  /* the Creator wallet: the field, and below it, once a different wallet passes, the address in full, the warning and the tick */
  .creator { display: grid; gap: var(--s-4); }
  .creator .input:disabled { opacity: .5; cursor: not-allowed; }
  .echo { display: grid; gap: var(--s-3); }
  .echo .shown { margin: 0; font-size: var(--t-14); overflow-wrap: anywhere; }
  .s-note { color: var(--ink-3); font-size: var(--t-14); padding-bottom: var(--s-4); }
  .three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-4); }
  .look { display: grid; gap: var(--s-3); }
  .look p { font-size: var(--t-16); }
  .look .confirm { color: inherit; }
  .donebtns { display: flex; flex-wrap: wrap; gap: var(--s-2); }
  .done { display: grid; gap: var(--s-4); justify-items: start; padding: var(--s-6); max-width: 640px; }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
    .preview { position: static; }
    .form { padding: var(--s-5); }
  }
  /* the tier skeleton follows the grid: 5 cards in a row, then 3, then 2 (measured 247 / 340 / 499px) */
  @media (max-width: 760px) { .tier-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .tiers-sk { height: 340px; } }
  @media (max-width: 760px) { .three { grid-template-columns: 1fr; } }
  @media (max-width: 520px) { .two { grid-template-columns: 1fr; } .tier-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .tiers-sk { height: 470px; } }
</style>
