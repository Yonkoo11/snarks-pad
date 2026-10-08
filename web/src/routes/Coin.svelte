<script lang="ts">
  import { api, ApiError, onMode, routeAbsent, failedOnChainText } from '../lib/api'
  import { EXPIRED_TEXT } from '../lib/send'
  import { solscanTokenUrl } from '../lib/explorer'
  import { coinLink, xIntentUrl } from '../lib/share'
  import type { CoinDetail, CreatorFees, Epoch, FeedTrade, Fixed, PadMode, Pot, Treasury } from '../lib/types'
  import { pricePerMillion, usdOfZats, zec, short, ago, feeLabel, feeChip } from '../lib/format'
  import { sharesOfCoin } from '../lib/fees'
  import { zecUsd } from '../lib/usd.svelte'
  import { wallet, friendly } from '../lib/wallet.svelte'
  import { referralLink } from '../lib/referral'
  import { profileHref } from '../lib/profile'
  import { hostOf, LINKS_WARNING } from '../lib/socials'
  import { poll } from '../lib/poll'
  import { monoNow, secondsLeft } from '../lib/window'
  import PriceChart from '../components/PriceChart.svelte'
  import CoinImage from '../components/CoinImage.svelte'
  import LiveNumber from '../components/LiveNumber.svelte'
  import WalletButton from '../components/WalletButton.svelte'
  import FeeSplit from '../components/FeeSplit.svelte'
  import Addr from '../components/Addr.svelte'
  import BuyBox from '../components/BuyBox.svelte'
  import TradesTape from '../components/TradesTape.svelte'
  import HoldersTable from '../components/HoldersTable.svelte'
  import CoinRewards from '../components/CoinRewards.svelte'
  import FixedPanel from '../components/FixedPanel.svelte'

  // A trading page: the chart and the buy box first, then the numbers, then four tabs (the live trades, the holders, the
  // rewards and what is fixed), then where the fee goes.
  let { mint }: { mint: string } = $props()
  let coin = $state<CoinDetail | null>(null)
  let err = $state<string | null>(null)
  // Liveness: the page reads the coin every 6 s while the tab is visible. A failed poll keeps the last good page and says so.
  const POLL_MS = 6_000
  // While a launch window is open the coin is read every second: the engine's word that the window has closed is what opens Buy (lib/window.ts), so the page asks often.
  const WINDOW_POLL_MS = 1_000
  const MAX_TRADES = 10
  let now = $state(Date.now())
  let pollErr = $state(false)
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))

  $effect(() => { zecUsd.refresh() })

  // The launch window's countdown runs on the page's own monotonic clock from the moment the engine's answer arrived, never on `endsAt` against the visitor's wall clock.
  let mono = $state(monoNow())
  let receivedAt = $state<number | null>(null)
  let asked = 0
  let applied = 0
  async function load() {
    const mine = ++asked
    try {
      const c = await api.coin(mint)
      if (mine < applied) return // an older answer arriving after a newer one must not undo it: a window that read closed stays closed
      applied = mine
      coin = c; err = null; pollErr = false; receivedAt = monoNow()
    } catch (e) {
      if (coin) pollErr = true
      else err = e instanceof ApiError && e.status === 404 ? 'No coin with that address.' : 'Could not load this coin.'
    }
  }
  const windowLeft = $derived(coin?.launchWindow && coin.windowSecondsLeft !== undefined && receivedAt !== null ? secondsLeft({ secondsLeft: coin.windowSecondsLeft, receivedAtMs: receivedAt }, mono) : 0)
  const pollMs = $derived(windowLeft > 0 ? WINDOW_POLL_MS : POLL_MS)
  $effect(() => poll(load, pollMs))
  $effect(() => { const t = setInterval(() => { now = Date.now(); mono = monoNow() }, 1000); return () => clearInterval(t) })
  // a quarter-second beat while a window is open, so the seconds change on time
  $effect(() => { if (windowLeft === 0) return; const t = setInterval(() => (mono = monoNow()), 250); return () => clearInterval(t) })
  $effect(() => { if (coin) document.title = `${coin.name} ($${coin.symbol}), SNARKS pad` })
  // The coin's own recent trades stand in for the tape on an engine without /coins/:mint/trades (v2.5).
  const fallbackTrades = $derived<FeedTrade[]>(coin ? coin.recentTrades.slice(0, MAX_TRADES).map((t) => ({ ...t, mint, symbol: coin!.symbol, tags: t.wallet === coin!.creator ? ['dev' as const] : [] })) : [])
  const liveNote = $derived(pollErr ? `Lost the connection to the pad. Trying again every ${POLL_MS / 1000}s.` : null)

  // ---- tabs: Trades, Holders, Rewards, What is fixed. A switch animates nothing; a tab's data loads when it is first shown.
  type Tab = 'trades' | 'holders' | 'rewards' | 'fixed'
  let tab = $state<Tab>('trades')
  const TABS: { id: Tab; label: string }[] = [{ id: 'trades', label: 'Trades' }, { id: 'holders', label: 'Holders' }, { id: 'rewards', label: 'Rewards' }, { id: 'fixed', label: 'Token info' }]
  // the rounds, the treasury and the coin's pot feed the Rewards tab; the fixed facts (read once, the engine caches them 30 s) feed
  // the What is fixed tab and the buy box's "ZEC to go". A failure is a dash, never an error on this page; a route this engine lacks is null.
  let epochs = $state<Epoch[] | null>(null)
  let treasury = $state<Treasury | null>(null)
  let pot = $state<Pot | null | undefined>(undefined)
  let fixed = $state<Fixed | null | undefined>(undefined)
  let fixedErr = $state(false)
  async function loadSide() {
    const [e, t, p] = await Promise.all([api.epochs().catch(() => null), api.treasury().catch(() => null), api.pot(mint).then((v) => v, (x) => (routeAbsent(x) ? null : pot ?? null))])
    epochs = e ? e.epochs : null; treasury = t; pot = p
  }
  $effect(() => poll(loadSide, 10_000))
  async function loadFixed() {
    fixedErr = false; fixed = undefined
    try { fixed = await api.fixed(mint) }
    catch (e) { if (routeAbsent(e)) fixed = null; else { fixed = null; fixedErr = true } }
  }
  $effect(() => { loadFixed() })
  // the creator's links (contract v2.7 `socials`), https only: the engine validates them at launch and the page never renders anything else as a link
  const links = $derived(coin?.socials ? (['website', 'x', 'telegram'] as const).map((k) => ({ k, href: coin!.socials![k] })).filter((l): l is { k: 'x' | 'website' | 'telegram'; href: string } => typeof l.href === 'string' && /^https:\/\//.test(l.href)) : [])
  const linkLabel = { website: 'Website', x: 'X', telegram: 'Telegram' } as const

  // ---- referral link
  let copied = $state(false)
  const link = $derived(wallet.address ? referralLink(mint, wallet.address) : null)
  async function copyLink() {
    if (!link) return
    try { await navigator.clipboard.writeText(link); copied = true; setTimeout(() => (copied = false), 2000) }
    catch { copied = false }
  }

  // ---- creator fees (fee tiers above 1%): the creator's own part of the fee, claimed by their own wallet, never held by the pad
  let creatorFees = $state<CreatorFees | null>(null)
  let claiming = $state(false)
  let claimErr = $state<string | null>(null)
  let claimed = $state<string[]>([])
  // the claim belongs to the wallet the chain records as the pool's creator (v2.8 `creatorWallet`): the launcher after a handover can claim nothing
  const isCreator = $derived(!!coin && !!wallet.address && wallet.address === (coin.creatorWallet ?? coin.creator) && coin.creatorShareBps > 0)
  // where the creator's fee goes, said only when it is not the launcher and there is a creator fee at all
  const payTo = $derived(coin && coin.creatorWallet && coin.creatorWallet !== coin.creator && coin.creatorShareBps > 0 ? coin.creatorWallet : null)
  $effect(() => {
    if (!isCreator) { creatorFees = null; return }
    const read = () => api.creatorFees(mint).then((r) => (creatorFees = r), () => (creatorFees = null))
    read()
    const t = setInterval(read, 10_000)
    return () => clearInterval(t)
  })
  const curveOwed = $derived(creatorFees ? BigInt(creatorFees.curveZats) : 0n)
  const poolOwed = $derived(creatorFees ? BigInt(creatorFees.poolZats) : 0n)
  // The wallet that signs is the one the chain records as this pool's creator; any other wallet gets a refusal from the engine.
  async function claimCreatorFees() {
    if (!wallet.address || !creatorFees) return
    claiming = true; claimErr = null; claimed = []
    try {
      for (const kind of (['curve', 'pool'] as const)) {
        if ((kind === 'curve' ? curveOwed : poolOwed) <= 0n) continue
        const r = await api.creatorClaimTx(mint, wallet.address, kind)
        const landing = await wallet.signAndSend(r.tx)
        if (landing.status === 'expired') { claimErr = EXPIRED_TEXT; return }
        if (landing.status === 'failed') { claimErr = failedOnChainText(landing.err, 'claim'); return }
        claimed = [...claimed, landing.sig]
      }
      creatorFees = await api.creatorFees(mint)
    } catch (e) {
      claimErr = e instanceof ApiError
        ? (e.code === 'not_creator' ? 'This wallet is not the creator of this coin on chain, so it cannot claim these fees.' : e.code === 'nothing_to_claim' ? 'Nothing to claim right now.' : `The pad refused this claim (${e.code}).`)
        : friendly(e)
    } finally { claiming = false }
  }

</script>

{#if err}
  <section class="wrap pad"><p class="error">{err}</p><a class="btn" href="#/">Back to coins</a></section>
{:else if !coin}
  <section class="wrap pad grid"><div class="skel" style="height: 360px"></div><div class="skel" style="height: 360px"></div></section>
{:else}
  <section class="wrap pad grid">
    <div class="main">
      <header class="head">
        <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={56} />
        <div class="title">
          <div class="trow">
            <h1 class="display">{coin.name}</h1>
            {#if coin.symbol === 'SNARKS'}<span class="chip">Coin #1</span>{/if}
            <span class="chip">{feeChip(coin)}</span>
            {#if coin.stage === 'graduated'}<span class="chip">Graduated</span>{/if}
          </div>
          <div class="byline">
            <p class="meta muted"><span class="mono">${coin.symbol}</span>, created {ago(coin.createdAt)}, creator <a class="plink mono" href={profileHref(coin.creator)} title={coin.creator}>{short(coin.creator)}</a>, mint <Addr value={coin.mint} label="mint address" href={solscanTokenUrl(coin.mint, mode)} /></p>
            {#if links.length}
              <ul class="links" aria-label="Links the creator gave">
                {#each links as l (l.k)}
                  <li><a class="lk" href={l.href} target="_blank" rel="noopener noreferrer">{linkLabel[l.k]}{#if l.k === 'website'}<span class="mono host">{hostOf(l.href)}</span>{/if}<span aria-hidden="true">↗</span></a></li>
                {/each}
              </ul>
            {/if}
          </div>
          {#if links.length}<p class="lwarn muted">{LINKS_WARNING}</p>{/if}
          {#if coin.hidden}<p class="hiddenwarn">The pad has taken this coin off its lists. It still trades on chain, so take extra care.</p>{/if}
          {#if payTo}<p class="payto muted"><a class="plink" href={profileHref(payTo)}>Creator fees go to <span class="mono" title={payTo}>{short(payTo, 6, 6)}</span></a></p>{/if}
          {#if coin.description}<p class="desc muted measure">{coin.description}</p>{/if}
        </div>
      </header>

      <PriceChart {mint} symbol={coin.symbol} />

      <dl class="stats">
        <!-- price and market cap are absent while the engine cannot read the chain and never has for this coin (contract v2.8.1): a dash, never 0 -->
        <div><dt class="label">Price per 1M {coin.symbol}</dt>{#if coin.priceZec === undefined}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={Number(coin.priceZec)} format={(v) => `${pricePerMillion(String(v))} ZEC`} /></dd>{#if usdOfZats(Number(coin.priceZec) * 1e6, zecUsd.rate)}<dd class="usd mono">{usdOfZats(Number(coin.priceZec) * 1e6, zecUsd.rate)}</dd>{/if}{/if}</div>
        <div><dt class="label">Market cap</dt>{#if coin.marketCapZec === undefined}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={Number(coin.marketCapZec)} format={(v) => `${zec(BigInt(Math.round(v)), 2)} ZEC`} /></dd>{#if usdOfZats(coin.marketCapZec, zecUsd.rate)}<dd class="usd mono">{usdOfZats(coin.marketCapZec, zecUsd.rate)}</dd>{/if}{/if}</div>
        <div><dt class="label">24h volume on this pad</dt><dd class="mono">{coin.volume24hZats === undefined ? '–' : `${zec(coin.volume24hZats, 2)} ZEC`}</dd></div>
        <div><dt class="label">Holders</dt>{#if coin.holders === null}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={coin.holders} format={(v) => Math.round(v).toLocaleString('en-US')} /></dd>{/if}</div>
        <div><dt class="label">Trading fee</dt><dd class="mono">{feeLabel(coin, true)}</dd></div>
      </dl>

      <section class="tabs-sec" aria-label="Trades, holders, rewards and token info">
        <div class="seg ctabs" role="tablist" aria-label="Coin details">
          {#each TABS as t (t.id)}
            <button type="button" role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-controls="panel-{t.id}" class:on={tab === t.id} onclick={() => (tab = t.id)}>
              {#if t.id === 'fixed'}<span class="long">{t.label}</span><span class="short" aria-hidden="true">Info</span>{:else}{t.label}{/if}{#if t.id === 'holders' && coin.holders}<span class="cnt mono">{coin.holders.toLocaleString('en-US')}</span>{/if}
            </button>
          {/each}
        </div>
        <div class="panel-body" role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}">
          {#if tab === 'trades'}
            <TradesTape {mint} creators={{ [mint]: coin.creator }} fallback={fallbackTrades} fallbackNote={liveNote} limit={MAX_TRADES} everyMs={POLL_MS} {mode} {now} />
          {:else if tab === 'holders'}
            <HoldersTable {mint} {coin} {mode} {now} />
          {:else if tab === 'rewards'}
            <CoinRewards {coin} {pot} {epochs} {treasury} {mode} {now} rate={zecUsd.rate} />
          {:else}
            <FixedPanel {fixed} {coin} {mode} err={fixedErr} onretry={loadFixed} />
          {/if}
        </div>
      </section>

      <FeeSplit split={sharesOfCoin(coin)} />
    </div>

    <aside class="side-col">
      <div class="trade-slot"><BuyBox {coin} {mint} thresholdZats={fixed?.migration.thresholdZats ?? null} {windowLeft} feeNowBps={coin.feeNowBps ?? null} ontraded={load} /></div>

      {#if isCreator}
        <div class="creator panel">
          <h2 class="h3">Your creator fees</h2>
          {#if creatorFees}
            <p class="muted">{zec(curveOwed)} ZEC are waiting on the curve{#if creatorFees.graduated}, and {zec(poolOwed)} ZEC in the graduated pool{/if}. Only your wallet can claim them: you sign, and the pad never holds this money.</p>
            <button class="btn block" disabled={claiming || (curveOwed <= 0n && poolOwed <= 0n)} onclick={claimCreatorFees}>{claiming ? 'Confirm in your wallet…' : 'Claim creator fees'}</button>
            {#each claimed as sig (sig)}<p class="ok">Claim sent. Signature <span class="mono">{short(sig, 6, 6)}</span></p>{/each}
          {:else}
            <p class="muted">Reading your fees from the chain…</p>
          {/if}
          {#if claimErr}<p class="error">{claimErr}</p>{/if}
        </div>
      {/if}

      <div class="ref panel">
        <h2 class="h3">Share this coin</h2>
        <p class="muted">Earn part of the fee, in ZEC, on trades made through your link.</p>
        {#if link}
          <div class="ref-row"><input class="input mono" readonly value={link} aria-label="Your referral link" onfocus={(e) => e.currentTarget.select()} /><button class="btn" onclick={copyLink}>{copied ? 'Copied' : 'Copy'}</button></div>
        {:else}
          <WalletButton label="Get my referral link" />
        {/if}
        <a class="btn ghost" href={xIntentUrl(coin.symbol, coinLink(coin.mint, wallet.address))} target="_blank" rel="noopener noreferrer">Post on X</a>
      </div>

      <a class="cta panel" href="#/shielded">
        <span class="band hatch" aria-hidden="true"></span>
        <span class="h3">Get your rewards <em>shielded.</em></span>
        <span class="muted">Your share of the holders' {coin.holderShareBps / 100}% of the trading fee, as native ZEC in your own Zcash wallet. One signature.</span>
        <span class="go">Set it up →</span>
      </a>
    </aside>
  </section>
{/if}

<style>
  .pad { padding-top: var(--s-6); }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: var(--s-7); align-items: start; }
  .main { display: grid; gap: var(--s-6); }
  .head { display: flex; gap: var(--s-4); align-items: flex-start; }
  .title { display: grid; gap: var(--s-2); min-width: 0; }
  .trow { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
  .meta { font-size: var(--t-14); }
  .desc { font-size: var(--t-16); }
  .stats { display: grid; grid-template-columns: repeat(5, auto); justify-content: start; gap: var(--s-6); margin: 0; }
  .stats dd { margin: var(--s-1) 0 0; font-size: var(--t-20); font-weight: 500; }
  .stats dd.usd { margin-top: 0; font-size: var(--t-14); font-weight: 400; color: var(--ink-2); }
  .byline { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); }
  .links { display: flex; flex-wrap: wrap; gap: var(--s-2); margin: 0; padding: 0; list-style: none; }
  .links li { display: flex; }
  /* a chip 32px tall inside a 44px touch target: the link's own box is 44px (its margin gives the 12px back), the pill is drawn inside it */
  .lk {
    position: relative; isolation: isolate; display: inline-flex; align-items: center; gap: var(--s-1); min-height: 44px; margin: -6px 0; padding: 0 var(--s-3);
    color: var(--ink); font-size: var(--t-14); font-weight: 700; text-decoration: none;
  }
  .lk::before {
    content: ''; position: absolute; inset: 6px 0; z-index: -1; border-radius: var(--r-full); background: var(--paper-3);
    transition: box-shadow var(--d-fn) var(--ease);
  }
  .lk .host { font-weight: 500; color: var(--ink-2); }
  @media (hover: hover) { .lk:hover::before { box-shadow: inset 0 0 0 2px var(--ink-3); } }
  .lk:active::before { box-shadow: inset 0 0 0 2px var(--ink-2); transition-duration: var(--d-press); }
  .lwarn { font-size: var(--t-14); max-width: 60ch; text-wrap: pretty; }
  .hiddenwarn { margin: 0; padding: var(--s-3) var(--s-4); border-radius: var(--r-md); background: var(--warn-bg); color: var(--warn-ink); font-size: var(--t-14); max-width: 60ch; }
  .payto { font-size: var(--t-14); overflow-wrap: anywhere; }
  /* the creator's address and the Creator wallet link to their profiles: plain text links, underlined, their hover only thickens the line */
  .plink { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .payto .plink { color: inherit; }
  .tabs-sec { display: grid; gap: var(--s-4); }
  .ctabs { width: max-content; max-width: 100%; }
  .ctabs > button { display: inline-flex; align-items: center; gap: var(--s-2); white-space: nowrap; }
  .cnt { font-size: var(--t-12); font-weight: 500; color: var(--ink-2); }
  .short { display: none; }
  .panel-body { min-height: 160px; }

  .side-col { display: grid; gap: var(--s-5); position: sticky; top: var(--s-4); }

  .creator { display: grid; gap: var(--s-3); padding: var(--s-5); }
  .creator p { font-size: var(--t-14); }
  .ref { display: grid; gap: var(--s-3); padding: var(--s-5); }
  .ref p { font-size: var(--t-14); }
  .ref-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-2); }
  .ref-row .input { font-size: var(--t-16); }
  .cta { position: relative; overflow: hidden; display: grid; gap: var(--s-2); padding: var(--s-5); padding-top: calc(var(--s-5) + 6px); text-decoration: none; transition: transform var(--d-fn) var(--ease); }
  .band { position: absolute; inset: 0 0 auto 0; height: 6px; }
  .cta em { font-style: normal; color: var(--pink); }
  .go { font-weight: 700; margin-top: var(--s-2); }
  @media (hover: hover) { .cta:hover { transform: translateY(-2px); } }
  .cta:active { transform: translateY(1px); transition-duration: var(--d-press); }

  @media (max-width: 960px) {
    /* one column, the buy box right under the title: a holder arriving from a phone link buys before reading the rest */
    .grid { grid-template-columns: 1fr; gap: var(--s-6); }
    .stats { grid-template-columns: repeat(2, auto); gap: var(--s-4) var(--s-6); }
    .stats dd { font-size: var(--t-16); }
    .main, .side-col { display: contents; }
    .head { order: 1; } .trade-slot { order: 2; } .main > :global(.chart) { order: 3; } .stats { order: 4; } .tabs-sec { order: 6; } .main > :global(.fs) { order: 7; } .creator, .ref { order: 8; } .cta { order: 9; }
  }
  @media (max-width: 640px) {
    /* the buy box sits inside the first screen: a tighter top, the description on two lines (the full text sits under the box in the tabs' pages anyway) */
    .pad { padding-top: var(--s-4); }
    .grid { gap: var(--s-4); }
    .head { gap: var(--s-3); }
    .desc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--t-14); }
    /* four tabs across a phone: shorter padding and the short fourth label, so all four sit on one row at 390 */
    .ctabs { width: 100%; }
    .ctabs > button { padding: 0 var(--s-2); font-size: var(--t-14); flex: 1; justify-content: center; gap: var(--s-1); }
    .long { display: none; }
    .short { display: inline; }
  }
</style>
