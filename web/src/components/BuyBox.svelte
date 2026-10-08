<script lang="ts">
  import { api, ApiError, onMode, routeAbsent, tradeErrorText, isShortOfFunds, failedOnChainText } from '../lib/api'
  import { EXPIRED_TEXT } from '../lib/send'
  import type { CoinDetail, PadMode, TradeQuote } from '../lib/types'
  import { zec, tokens, toZats, short } from '../lib/format'
  import { wallet } from '../lib/wallet.svelte'
  import { referrer } from '../lib/referral'
  import { readBalances, type Balances } from '../lib/holding'
  import { solanaTxUrl } from '../lib/explorer'
  import {
    BUY_PRESETS_ZEC, SELL_PRESETS_PCT, SLIPPAGE_PRESETS_BPS, SLIPPAGE_DEFAULT_BPS, SLIPPAGE_WARN_BPS, GET_ZEC_URL, ZEC_MINT_MAINNET,
    parseSlippagePct, slippagePct, priceImpactBps, impactLabel, shareOfHolding, tokenAmountText,
  } from '../lib/trade'
  import { bpsText, waitLabel, windowLineParts } from '../lib/window'
  import CurveBar from './CurveBar.svelte'
  import WalletButton from './WalletButton.svelte'
  import Addr from './Addr.svelte'

  // The trade box of the coin page. A quote appears as soon as an amount is typed, wallet or not (v2.6 GET /coins/:mint/quote;
  // an engine without it falls back to asking for a wallet). With a wallet connected the engine builds the transaction with the
  // same quote, the wallet signs it, and the page reloads. Presets, sell shares, slippage and the price impact follow the field
  // (research/LAUNCHPAD-FIELD-STUDY.md Part 4 rows 1-3); every number comes from the engine's quote or the wallet's own balance.
  // `thresholdZats`: the ZEC the curve must raise to graduate (GET /coins/:mint/fixed migration.thresholdZats), when the page has it
  // `windowLeft`: whole seconds the coin's launch window has left (the page counts them down, lib/window.ts); above 0 the box says so and holds Buy and Sell, because a trade that
  // lands inside the window pays the window's fee (contract v2.8). The engine would build the transaction anyway: this is the site's own UI keeping a person from paying it. `feeNowBps` is the fee now.
  let { coin, mint, thresholdZats = null, windowLeft = 0, feeNowBps = null, ontraded }: { coin: CoinDetail; mint: string; thresholdZats?: string | null; windowLeft?: number; feeNowBps?: number | null; ontraded: () => void } = $props()
  const windowOpen = $derived(windowLeft > 0)

  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))

  let side = $state<'buy' | 'sell'>('buy')
  let amount = $state('')
  let slippageBps = $state(SLIPPAGE_DEFAULT_BPS)
  let customSlip = $state('')
  // the slippage chips are open on a wide screen and folded behind their summary on a phone, so Buy stays in the first screen
  let slipOpen = $state(typeof matchMedia !== 'function' || !matchMedia('(max-width: 640px)').matches)
  let quote = $state<TradeQuote | null>(null)
  let engineImpact = $state<number | null>(null)
  let tx = $state<string | null>(null)
  let quoting = $state(false)
  let quoteGone = $state(false) // the engine has no wallet-less quote route: only a connected wallet gets one
  let sending = $state(false)
  let tradeErr = $state<string | null>(null)
  let shortFunds = $state(false)
  let done = $state<string | null>(null)
  let doneSeen = $state(true) // false: sent, but Solana had not confirmed it when the page stopped watching
  let balances = $state<Balances>({ token: null, zec: null })

  const sym = $derived(coin.symbol)
  const base = $derived.by(() => {
    if (side === 'buy') return toZats(amount)
    const z = toZats(amount) // same parser, then rescale 8dp -> 6dp token units
    return z === null ? null : z / 100n
  })
  const badAmount = $derived(amount !== '' && base === null)
  const customBad = $derived(customSlip !== '' && parseSlippagePct(customSlip) === null)
  const isPreset = $derived((SLIPPAGE_PRESETS_BPS as readonly number[]).includes(slippageBps))
  const impact = $derived(quote ? (engineImpact ?? (coin.priceZec === undefined ? null : priceImpactBps(side, quote, coin.priceZec))) : null)
  // the fee a quote carries when it is above the coin's own: the page's count while the window is open, else what the engine put on the quote
  const windowFee = $derived<number | null>(windowOpen ? feeNowBps : quote?.feeBps != null && quote.feeBps > coin.feeBps ? quote.feeBps : null)
  // Short of money: a buy above the wallet's Solana ZEC, a sell above what it holds of the coin. Only when the balance is known.
  const shortZec = $derived(side === 'buy' && !!wallet.address && balances.zec !== null && base !== null && base > balances.zec)
  const shortToken = $derived(side === 'sell' && !!wallet.address && balances.token !== null && base !== null && base > balances.token)
  const canSend = $derived(!!tx && !sending && !shortZec && !shortToken && !windowOpen)
  // what the curve still needs: the engine's own number when it sends one, else threshold minus what the progress says is raised
  const room = $derived.by(() => {
    if (coin.stage !== 'curve') return null
    if (coin.curveRoomZats !== undefined) return BigInt(coin.curveRoomZats)
    if (thresholdZats === null || coin.curveProgress === undefined) return null // no progress while the engine cannot read the chain (v2.8.1)
    const t = BigInt(thresholdZats)
    const left = t - BigInt(Math.round(coin.curveProgress * Number(t)))
    return left > 0n ? left : 0n
  })

  function pickSide(s: 'buy' | 'sell') { side = s; amount = ''; done = null }
  function pickSlip(bps: number) { slippageBps = bps; customSlip = '' }
  function typeSlip(e: Event) {
    customSlip = (e.currentTarget as HTMLInputElement).value
    const bps = parseSlippagePct(customSlip)
    if (bps !== null) slippageBps = bps
  }
  function sellShare(pct: number) {
    if (balances.token === null) return
    amount = tokenAmountText(shareOfHolding(balances.token, pct))
  }

  // the Solana ZEC balance is read on mainnet, where the mint is known; devnet's stand-in mint is not published, so a short buy there shows on send
  async function loadBalances() {
    const w = wallet.address
    if (!w) { balances = { token: null, zec: null }; return }
    const b = await readBalances(w, mint, mode === 'mainnet' ? ZEC_MINT_MAINNET : null)
    if (wallet.address === w) balances = b
  }
  $effect(() => { void wallet.address; void mode; loadBalances() })

  // The referrer from the link that brought the visitor, if any. The engine refuses an account it cannot pay (no ZEC
  // account, or the trader's own); then the trade goes ahead without a referral instead of failing.
  async function buildWithReferral(w: string, s: 'buy' | 'sell', b: bigint) {
    const ref = referrer()
    const body = { wallet: w, side: s, amount: b.toString(), slippageBps }
    if (!ref || ref === w) return api.tradeTx(mint, body)
    try { return await api.tradeTx(mint, { ...body, referrer: ref }) }
    catch (e) {
      if (e instanceof ApiError && e.code === 'bad_referral') return api.tradeTx(mint, body)
      throw e
    }
  }
  async function fetchQuote(w: string | null, s: 'buy' | 'sell', b: bigint, slip: number) {
    if (w) {
      const r = await buildWithReferral(w, s, b)
      quote = r.quote; tx = r.tx; engineImpact = null
      return
    }
    try {
      const r = await api.quote(mint, { side: s, amount: b.toString(), slippageBps: slip })
      quote = { in: r.in, out: r.out, minOut: r.minOut, feeZec: r.feeZec, feeBps: r.feeBps }; engineImpact = r.priceImpactBps
    } catch (e) {
      if (routeAbsent(e)) { quoteGone = true; return }
      throw e
    }
  }
  $effect(() => {
    const b = base, w = wallet.address, s = side, slip = slippageBps
    void windowOpen // a quote taken inside the window carries its fee: ask again the moment it closes
    quote = null; tx = null; tradeErr = null; shortFunds = false; engineImpact = null
    if (!b || b <= 0n || (quoteGone && !w)) return
    quoting = true
    const t = setTimeout(async () => {
      try { await fetchQuote(w, s, b, slip) }
      catch (e) { tradeErr = tradeErrorText(e) }
      finally { quoting = false }
    }, 300)
    return () => clearTimeout(t)
  })
  // The wallet-less quote's fee is read off the chain's clock, which trails the countdown by up to the engine's quote cache: right after the window closes a fresh quote
  // can still carry the last step, and the "Fee now (launch window)" row would stay until the amount changed. Ask again every second until the quote carries the coin's fee.
  $effect(() => {
    if (windowOpen || quoting || !quote || quote.feeBps == null || quote.feeBps <= coin.feeBps) return
    const b = base, w = wallet.address, s = side, slip = slippageBps
    if (!b || b <= 0n) return
    const t = setTimeout(async () => {
      quoting = true
      try { await fetchQuote(w, s, b, slip) }
      catch (e) { tradeErr = tradeErrorText(e) }
      finally { quoting = false }
    }, 1000)
    return () => clearTimeout(t)
  })

  async function submit() {
    if (!tx) return
    sending = true; tradeErr = null; shortFunds = false; done = null; doneSeen = true
    try {
      const landing = await wallet.signAndSend(tx)
      if (landing.status === 'expired') { tradeErr = EXPIRED_TEXT; return }
      if (landing.status === 'failed') { tradeErr = failedOnChainText(landing.err, 'trade'); return }
      done = landing.sig; amount = ''; doneSeen = landing.status === 'confirmed'
      // The engine reads the trade back from the chain for the trades tape; it waits for it itself, so an unseen one is asked about too.
      try { await api.tradeConfirm(mint, landing.sig) } catch { /* the tape catches up from the chain */ }
      ontraded()
      loadBalances()
    } catch (e) { tradeErr = tradeErrorText(e); shortFunds = isShortOfFunds(e) }
    finally { sending = false }
  }
</script>

<div class="trade panel">
  {#if windowOpen}
    {@const line = windowLineParts(windowLeft, feeNowBps)}
    <p class="window" role="timer">Launch window: <span class="mono">{line.left}</span> left, fee now <span class="mono">{line.fee}</span></p>
  {/if}
  <div class="seg tabs" role="tablist" aria-label="Buy or sell">
    <button role="tab" aria-selected={side === 'buy'} class:on={side === 'buy'} onclick={() => pickSide('buy')}>Buy</button>
    <button role="tab" aria-selected={side === 'sell'} class:on={side === 'sell'} onclick={() => pickSide('sell')}>Sell</button>
  </div>

  <label class="field">
    <span>{side === 'buy' ? 'You pay (ZEC)' : `You sell (${sym})`}</span>
    <input class="input mono" inputmode="decimal" autocomplete="off" placeholder={side === 'buy' ? '0.10' : '1000'} bind:value={amount}
      aria-invalid={badAmount} aria-describedby={badAmount ? 'amount-error' : undefined} />
  </label>
  {#if badAmount}<p class="error" id="amount-error">Type a number, like 0.1</p>{/if}

  {#if side === 'buy'}
    <div class="presets" role="group" aria-label="Quick amounts in ZEC">
      {#each BUY_PRESETS_ZEC as p (p)}<button type="button" class="pre mono" aria-pressed={amount === p} onclick={() => (amount = p)}>{p} ZEC</button>{/each}
    </div>
  {:else}
    <div class="presets" role="group" aria-label="Share of your holding to sell">
      {#each SELL_PRESETS_PCT as pct (pct)}
        <button type="button" class="pre mono" disabled={balances.token === null} aria-pressed={balances.token !== null && amount !== '' && amount === tokenAmountText(shareOfHolding(balances.token, pct))} onclick={() => sellShare(pct)}
          title={!wallet.address ? 'Connect a wallet to size a sell from what it holds' : balances.token === null ? 'Your balance could not be read' : `Sell ${pct}% of your ${sym}`}>{pct}%</button>
      {/each}
    </div>
    {#if wallet.address && balances.token !== null}<p class="hold muted">You hold <span class="mono">{tokens(balances.token)} {sym}</span>.</p>{/if}
  {/if}

  <div class="slip">
    <button type="button" class="slip-l" aria-expanded={slipOpen} aria-controls="slip-row" onclick={() => (slipOpen = !slipOpen)}>Slippage <span class="mono">{slippagePct(slippageBps)}</span><span class="muted chg">{slipOpen ? 'Hide' : 'Change'}</span></button>
    {#if slipOpen}
      <div class="slip-r" id="slip-row" role="group" aria-label="Slippage">
        {#each SLIPPAGE_PRESETS_BPS as bps (bps)}<button type="button" class="pre mono" aria-pressed={isPreset && slippageBps === bps} onclick={() => pickSlip(bps)}>{slippagePct(bps)}</button>{/each}
        <input class="input mono custom" inputmode="decimal" autocomplete="off" placeholder="2.5" aria-label="Custom slippage, percent" value={customSlip} oninput={typeSlip} aria-invalid={customBad} />
      </div>
    {/if}
  </div>
  {#if customBad}<p class="error">Type a percent between 0 and 50, like 1.5</p>
  {:else if slippageBps > SLIPPAGE_WARN_BPS}<p class="warn" role="note">High slippage: this trade may fill at a price up to <span class="mono">{slippagePct(slippageBps)}</span> worse than the quote.</p>{/if}

  <div class="quote" aria-live="polite">
    {#if quoting}
      <p class="muted">Getting a quote…</p>
    {:else if quote}
      <div class="qrow"><span>You get about</span><span class="mono">{side === 'buy' ? `${tokens(quote.out)} ${sym}` : `${zec(quote.out, 6)} ZEC`}</span></div>
      <div class="qrow muted"><span>At least ({slippagePct(slippageBps)} slippage)</span><span class="mono">{side === 'buy' ? `${tokens(quote.minOut)} ${sym}` : `${zec(quote.minOut, 6)} ZEC`}</span></div>
      {#if impact !== null}<div class="qrow muted" class:big={impact > 500}><span>Price impact</span><span class="mono">{impactLabel(impact)}</span></div>{/if}
      <div class="qrow muted"><span>Trading fee (holders get {coin.holderShareBps / 100}%)</span><span class="mono">{zec(quote.feeZec, 6)} ZEC</span></div>
      {#if windowFee !== null}<div class="qrow muted"><span>Fee now (launch window)</span><span class="mono">{bpsText(windowFee)}</span></div>{/if}
      {#if impact !== null && impact > 500}<p class="warn" role="note">Large for this pool: the price moves about <span class="mono">{impactLabel(impact)}</span>. A smaller amount fills closer to the quote.</p>{/if}
    {:else if !wallet.address && quoteGone}
      <p class="muted">Connect a Solana wallet to get a quote.</p>
    {/if}
    {#if shortZec}<p class="error">Your wallet holds <span class="mono">{zec(balances.zec ?? 0n)} ZEC</span> on Solana, less than this buy.</p>{/if}
    {#if shortToken}<p class="error">You hold <span class="mono">{tokens(balances.token ?? 0n)} {sym}</span>, less than this sell.</p>{/if}
    {#if tradeErr}<p class="error">{tradeErr}</p>{/if}
    {#if shortZec || shortFunds}
      {#if mode === 'devnet'}<p class="get muted">Test money: use "Get test SOL and ZEC" in the banner at the top.</p>
      {:else if mode === 'mainnet'}<p class="get"><a href={GET_ZEC_URL} target="_blank" rel="noreferrer">Get ZEC on Solana</a> <span class="muted">(Jupiter swaps SOL into Solana ZEC; a new tab)</span></p>{/if}
    {/if}
  </div>

  {#if wallet.address}
    <button class="btn primary block" disabled={!canSend} onclick={submit}>
      {sending ? 'Confirm in your wallet…' : windowOpen ? waitLabel(windowLeft) : `${side === 'buy' ? 'Buy' : 'Sell'} $${sym}`}
    </button>
  {:else}
    <WalletButton primary label="Connect wallet to buy" />
  {/if}
  {#if done}<p class="ok">{doneSeen ? 'Done.' : 'Sent.'} Signature <Addr value={done} head={6} tail={6} href={solanaTxUrl(done, mode)} label="transaction signature" /></p>{#if !doneSeen}<p class="muted">Solana has not confirmed it yet. Your balances update when it lands.</p>{/if}{/if}

  {#if coin.curveProgress !== undefined}<CurveBar progress={coin.curveProgress} stage={coin.stage} />{/if}
  {#if room !== null}<p class="room muted">{#if room > 0n}<span class="mono">{zec(room, 2)} ZEC</span> more to graduate.{:else}The curve is full: this coin graduates next.{/if}</p>{/if}
</div>

<style>
  .trade { display: grid; gap: var(--s-4); padding: var(--s-5); }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; margin-right: var(--s-5); }
  /* preset chips: 44px tall, tone only; the pressed one is ink on paper */
  .presets, .slip-r { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-top: calc(-1 * var(--s-2)); }
  .pre {
    min-height: 44px; min-width: 44px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-sm); background: var(--paper-3); color: var(--ink);
    font-size: var(--t-14); font-weight: 500; cursor: pointer;
    transition: background-color var(--d-fn) var(--ease), color var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease), transform var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .pre:hover:not(:disabled):not([aria-pressed='true']) { box-shadow: inset 0 0 0 2px var(--ink-3); transform: translateY(-1px); } }
  .pre:active:not(:disabled) { transform: translateY(0); transition-duration: var(--d-press); }
  .pre[aria-pressed='true'] { background: var(--ink); color: var(--paper); }
  .pre:disabled { opacity: .5; cursor: not-allowed; }
  .hold { font-size: var(--t-14); margin-top: calc(-1 * var(--s-2)); }
  .slip { display: grid; gap: var(--s-2); }
  /* the summary is a 44px-tall toggle on one text line; the negative margin keeps the box's rhythm */
  .slip-l { display: inline-flex; align-items: center; gap: var(--s-2); justify-self: start; min-height: 44px; margin: -12px 0; padding: 0; border: 0; background: none; font: inherit; font-size: var(--t-14); font-weight: 700; color: var(--ink); cursor: pointer; border-radius: var(--r-xs); }
  .chg { font-weight: 400; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  @media (hover: hover) { .slip-l:hover .chg { color: var(--ink); } }
  .slip-r { margin-top: 0; align-items: center; }
  .custom { width: 7ch; min-height: 44px; padding: 0 var(--s-2); font-size: var(--t-16); text-align: center; }
  .warn, .window { margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-sm); background: var(--warn-bg); color: var(--warn-ink); font-size: var(--t-14); }
  .quote { display: grid; gap: var(--s-1); min-height: 72px; font-size: var(--t-14); }
  .qrow { display: flex; justify-content: space-between; gap: var(--s-3); }
  .qrow.big { color: var(--ink); font-weight: 700; }
  .get { font-size: var(--t-14); }
  .get a { color: var(--ink); font-weight: 700; text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .ok { font-size: var(--t-14); display: flex; gap: var(--s-1); align-items: center; flex-wrap: wrap; }
  .room { font-size: var(--t-14); margin-top: calc(-1 * var(--s-2)); }
  .room .mono { color: var(--ink); }
  .trade :global(.wb .btn) { width: 100%; }
  @media (max-width: 640px) {
    .trade { padding: var(--s-4); gap: var(--s-3); }
    .quote { min-height: 0; }
  }
</style>
