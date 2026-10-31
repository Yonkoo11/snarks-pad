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
  import { readHoldings } from '../lib/holdings'
  import { referralLink } from '../lib/referral'
  import { profileHref } from '../lib/profile'
  import { hostOf, LINKS_WARNING } from '../lib/socials'
  import { poll } from '../lib/poll'
  import { layers, dossierKey, type DossierTab } from '../lib/layers.svelte'
  import { reducedMotion } from '../lib/motion'
  import { monoNow, secondsLeft } from '../lib/window'
  import PriceChart from '../components/PriceChart.svelte'
  import CoinImage from '../components/CoinImage.svelte'
  import DecisionStrip from '../components/DecisionStrip.svelte'
  import Prov from '../components/Prov.svelte'
  import LiveNumber from '../components/LiveNumber.svelte'
  import WalletButton from '../components/WalletButton.svelte'
  import FeeSplit from '../components/FeeSplit.svelte'
  import Addr from '../components/Addr.svelte'
  import BuyBox from '../components/BuyBox.svelte'
  import TradesTape from '../components/TradesTape.svelte'
  import HoldersTable from '../components/HoldersTable.svelte'
  import CoinRewards from '../components/CoinRewards.svelte'
  import FixedPanel from '../components/FixedPanel.svelte'
  import PotSlip from '../components/PotSlip.svelte'
  import ShareCard from '../components/ShareCard.svelte'
  import Lamp from '../components/room/Lamp.svelte'

  // A trading page: the chart and the buy box first, then the numbers, then four tabs (the live trades, the holders, the
  // rewards and what is fixed), then where the fee goes.
  let { mint }: { mint: string } = $props()
  let coin = $state<CoinDetail | null>(null)
  let err = $state<string | null>(null)
  // Liveness: the page reads the coin every 6 s while the tab is visible. A failed poll keeps the last good page and says so.
  const POLL_MS = 6_000
  // While a launch window is open the coin is read every second: the engine's word that the window has closed is what opens Buy (lib/window.ts), so the page asks often.
  const WINDOW_POLL_MS = 1_000
  const MAX_TRADES = 25 // the engine keeps no older trades to page to; the cap is said under the list
  let now = $state(Date.now())
  let pollErr = $state(false)
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))

  $effect(() => { zecUsd.refresh() })

  // The launch window's countdown runs on the page's own monotonic clock from the moment the engine's answer arrived, never on `endsAt` against the visitor's wall clock.
  let mono = $state(monoNow())
  let receivedAt = $state<number | null>(null)
  let readAt = $state<number | null>(null) // wall-clock moment of the last good read, for the "how we know" lines
  let asked = 0
  let applied = 0
  async function load() {
    const mine = ++asked
    try {
      const c = await api.coin(mint)
      if (mine < applied) return // an older answer arriving after a newer one must not undo it: a window that read closed stays closed
      applied = mine
      coin = c; err = null; pollErr = false; receivedAt = monoNow(); readAt = Date.now()
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
  // the breadcrumb names this page by its ticker, and forgets it when the page goes
  $effect(() => { if (coin) layers.routeLabel = `$${coin.symbol}`; return () => { layers.routeLabel = null } })
  // The coin's own recent trades stand in for the tape on an engine without /coins/:mint/trades (v2.5).
  const fallbackTrades = $derived<FeedTrade[]>(coin ? coin.recentTrades.slice(0, MAX_TRADES).map((t) => ({ ...t, mint, symbol: coin!.symbol, tags: t.wallet === coin!.creator ? ['dev' as const] : [] })) : [])
  const liveNote = $derived(pollErr ? `Lost the connection to the pad. Trying again every ${POLL_MS / 1000}s.` : null)

  // ---- tabs: Trades, Holders, Rewards, What is fixed. A switch animates nothing; a tab's data loads when it is first shown.
  type Tab = 'trades' | 'holders' | 'rewards' | 'fixed'
  let tab = $state<Tab>('trades')
  const TABS: { id: Tab; label: string }[] = [{ id: 'trades', label: 'Trades' }, { id: 'holders', label: 'Holders' }, { id: 'rewards', label: 'Rewards' }, { id: 'fixed', label: 'Token info' }]
  /** Arrow keys, Home and End move between the tabs; the tab list is one tab stop (the Profile page's pattern). */
  function onTabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab)
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
    if (next < 0) return
    e.preventDefault()
    tab = TABS[next].id
    document.getElementById(`tab-${TABS[next].id}`)?.focus()
  }
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
  // ---- your cut: the connected wallet's share of this pot, estimated from its real balance (read in the
  // browser, like the profile's Holdings tab) against the eligible supply (total minus the pool vaults,
  // which are never paid). The payout itself follows the least held at the round's random checks, so the
  // line says "about" and says the condition.
  let myBal = $state<bigint | null>(null)
  let holdSum = $state<{ supply: string; poolPct: number | null } | null>(null)
  $effect(() => {
    const w = wallet.address
    myBal = null
    if (!w) return
    readHoldings(w).then((hs) => { if (wallet.address === w) myBal = hs.find((h) => h.coin.mint === mint)?.amount ?? 0n }, () => {})
  })
  $effect(() => { api.holders(mint, { limit: 1 }).then((h) => (holdSum = { supply: h.supply, poolPct: h.poolPct }), () => (holdSum = null)) })
  const yourCutZats = $derived.by(() => {
    if (myBal === null || myBal <= 0n || !holdSum || !pot) return null
    let supply: bigint
    try { supply = BigInt(holdSum.supply || '0') } catch { return null }
    if (supply <= 0n) return null
    const poolBps = BigInt(Math.max(0, Math.min(10_000, Math.round((holdSum.poolPct ?? 0) * 100))))
    const eligible = (supply * (10_000n - poolBps)) / 10_000n
    if (eligible <= 0n) return null
    return (BigInt(pot.holdersZats) * (myBal > eligible ? eligible : myBal)) / eligible
  })

  // The facts a buyer checks first, counted off the fixed record; the Token info tab holds the full list with a
  // chain link per line. null while the record is still loading or this engine lacks the route: no line, never a guess.
  const fixedWarns = $derived.by(() => {
    if (!fixed || !coin) return null
    const grad = coin.stage === 'graduated'
    let n = 0
    if (fixed.tokenAuthorities.mintAuthority !== null && grad) n++
    if (fixed.tokenAuthorities.freezeAuthority !== null) n++
    if (fixed.tokenAuthorities.updateAuthority !== null) n++
    if (fixed.liquidity.unlockedPct > 0) n++
    return n
  })
  function goFixed() {
    tab = 'fixed'
    document.getElementById('tab-fixed')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' })
  }

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
  <section class="wrap pad"><p class="error" role="alert">{err}</p><div class="errrow"><button class="btn" type="button" onclick={load}>Try again</button><a class="btn ghost" href="#/">Back to coins</a></div></section>
{:else if !coin}
  <section class="wrap pad grid"><div class="skel" style="height: 360px"></div><div class="skel" style="height: 360px"></div></section>
{:else}
  <section class="wrap pad">
  <div class="door tgrid">
    <Lamp lastAt={treasury?.lastEpochAt ?? null} nextAt={treasury?.nextEpochAt ?? null} {now} />
    <div class="main">
      <header class="head">
        <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={88} />
        <div class="title">
          <div class="trow">
            <h1 class="display big-name">{coin.name}</h1>
            {#if coin.symbol === 'SNARKS'}<span class="chip">Coin #1</span>{/if}
            <span class="chip">{feeChip(coin)}</span>
            <!-- the same trade-share figure the Home cards state, never the share-of-fee figure beside it -->
            <span class="chip">Pays holders {String(Math.round(coin.feeBps * coin.holderShareBps / 10_000) / 100)}% in ZEC</span>
            {#if coin.stage === 'graduated'}<span class="chip">Graduated</span><span class="chip">Liquidity locked</span>{/if}
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
        <div><dt class="label">Price per 1M {coin.symbol}<Prov label="price" src="The coin record from the pad API (priceZec, ZEC per whole token)" at={readAt} {now} note="Not a quote: what a trade would actually fill at depends on size and fee." /></dt>{#if coin.priceZec === undefined}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={Number(coin.priceZec)} format={(v) => `${pricePerMillion(String(v))} ZEC`} /></dd>{#if usdOfZats(Number(coin.priceZec) * 1e6, zecUsd.rate)}<dd class="usd mono">{usdOfZats(Number(coin.priceZec) * 1e6, zecUsd.rate)}</dd>{/if}{/if}</div>
        <div><dt class="label">Market cap<Prov label="market cap" src="The coin record from the pad API (marketCapZec)" at={readAt} {now} /></dt>{#if coin.marketCapZec === undefined}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={Number(coin.marketCapZec)} format={(v) => `${zec(BigInt(Math.round(v)), 2)} ZEC`} /></dd>{#if usdOfZats(coin.marketCapZec, zecUsd.rate)}<dd class="usd mono">{usdOfZats(coin.marketCapZec, zecUsd.rate)}</dd>{/if}{/if}</div>
        <div><dt class="label">24h volume on this pad<Prov label="24 hour volume" src="ZEC of the trades this pad recorded in the last 24 hours" n={coin.trades24h ?? null} at={readAt} {now} note="A buy counts what was paid, fee included; a sell what was received. Trades made elsewhere are not counted." /></dt><dd class="mono">{coin.volume24hZats === undefined ? '–' : `${zec(coin.volume24hZats, 2)} ZEC`}</dd></div>
        <div><dt class="label">Holders<Prov label="holders" src="Eligible wallets (pool vaults excluded) from the pad API" at={readAt} {now} /></dt>{#if coin.holders === null}<dd class="mono">–</dd>{:else}<dd><LiveNumber value={coin.holders} format={(v) => Math.round(v).toLocaleString('en-US')} /></dd>{/if}</div>
        <div><dt class="label">Trading fee<Prov label="trading fee" src="Fixed at launch and readable on chain (the Token info tab links each account)" note="After graduation the pool fee can rise by up to a fifth when trading is volatile." /></dt><dd class="mono">{feeLabel(coin, true)}</dd></div>
      </dl>

      <DecisionStrip {coin} {pot} {now} />

      <!-- the one-line answer to "can this rug?": counted off the fixed record, opened in full on the Token info tab -->
      {#if fixedWarns !== null}
        <button class="fixedline" type="button" onclick={goFixed}>
          <span class="fmark mono" class:warn={fixedWarns > 0} aria-hidden="true">{fixedWarns > 0 ? '!' : '✓'}</span>
          {#if fixedWarns === 0}<span class="ftext">The fee, the graduation bar, minting, freezing and the liquidity are fixed on chain. Nobody can change them, the pad included.</span>
          {:else}<span class="ftext">{fixedWarns} of this coin's fixed facts {fixedWarns === 1 ? 'needs' : 'need'} a look before you buy.</span>{/if}
          <span class="fgo">Check each on chain &rarr;</span>
        </button>
      {/if}

      <section class="tabs-sec" aria-label="Trades, holders, rewards and token info">
        <div class="tabrow">
        <div class="seg ctabs" role="tablist" aria-label="Coin details">
          {#each TABS as t (t.id)}
            <button type="button" role="tab" id="tab-{t.id}" aria-selected={tab === t.id} aria-controls="panel-{t.id}" tabindex={tab === t.id ? 0 : -1} class:on={tab === t.id} onclick={() => (tab = t.id)} onkeydown={onTabKey}>
              {#if t.id === 'fixed'}<span class="long">{t.label}</span><span class="short" aria-hidden="true">Info</span>{:else}{t.label}{/if}{#if t.id === 'holders' && coin.holders}<span class="cnt mono">{coin.holders.toLocaleString('en-US')}</span>{/if}
            </button>
          {/each}
        </div>
        {#if tab !== 'fixed'}
          <button class="pull" type="button" onclick={() => layers.open({ kind: 'dossier', key: dossierKey(mint, tab as DossierTab), title: `$${coin!.symbol}` })} title="Open this tab as a sheet over the page; the chart keeps running behind it">Pull out <span aria-hidden="true">&#8599;</span></button>
        {/if}
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

    <aside class="side-col onpaper">
      <div class="trade-slot"><BuyBox {coin} {mint} thresholdZats={fixed?.migration.thresholdZats ?? null} {windowLeft} feeNowBps={coin.feeNowBps ?? null} ontraded={load} /></div>
      <!-- the reason to hold, visible without a click: this coin's own pot, its clock, and the rule -->
      <div class="pot-slot"><PotSlip {coin} {pot} {treasury} {now} rate={zecUsd.rate} yourCut={yourCutZats} /></div>

      {#if isCreator}
        <div class="creator panel">
          <h2 class="h3">Your creator fees</h2>
          {#if creatorFees}
            <p class="muted">{zec(curveOwed)} ZEC are waiting on the curve{#if creatorFees.graduated}, and {zec(poolOwed)} ZEC in the graduated pool{/if}. Only your wallet can claim them: you sign, and the pad never holds this money.</p>
            <button class="btn block" disabled={claiming || (curveOwed <= 0n && poolOwed <= 0n)} onclick={claimCreatorFees}>{claiming ? 'Confirm in your wallet…' : 'Claim creator fees'}</button>
            {#if !claiming && curveOwed <= 0n && poolOwed <= 0n}<p class="muted small-note">Nothing to claim yet; fees appear here as your coin trades.</p>{/if}
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
        <!-- the drawn card folds away: the rail stays short, the card one tap deep -->
        <details class="cardfold">
          <summary>The share card, drawn by the pad</summary>
          <ShareCard {coin} />
          <p class="muted small-note">The post opens with your link; attach the saved card to it.</p>
        </details>
        <a class="btn ghost" href={xIntentUrl(coin.symbol, coinLink(coin.mint, wallet.address))} target="_blank" rel="noopener noreferrer">Post on X</a>
      </div>

      <a class="cta panel" href="#/shielded">
        <span class="band hatch" aria-hidden="true"></span>
        <span class="h3">Get your rewards <em>shielded.</em></span>
        <span class="muted">Your share of the {String(Math.round(coin.feeBps * coin.holderShareBps / 10_000) / 100)}% of every trade that goes to holders, as native ZEC in your own Zcash wallet. One signature.</span>
        <span class="go">Set it up →</span>
      </a>
    </aside>
  </div>
  </section>
{/if}

<style>
  .pad { padding-top: var(--s-6); }
  .errrow { display: flex; gap: var(--s-3); margin-top: var(--s-3); }
  /* the trading room: the whole screen on one door, the buy box and its notes as paper on it */
  .tgrid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: var(--s-7); align-items: start; padding: clamp(20px, 3vw, 40px); }
  .main { display: grid; gap: var(--s-6); }
  .head { display: flex; gap: var(--s-4); align-items: flex-start; }
  /* the coin is the subject: its name is the biggest text on the page */
  .big-name { font-size: clamp(30px, 2.6vw, 40px); }
  .title { display: grid; gap: var(--s-2); min-width: 0; }
  .trow { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
  .meta { font-size: var(--t-14); }
  .desc { font-size: var(--t-16); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(max-content, 1fr)); justify-content: start; gap: var(--s-4) var(--s-6); margin: 0; }
  .stats dd { margin: var(--s-1) 0 0; font-size: var(--t-20); font-weight: 500; white-space: nowrap; }
  .stats dd.usd { margin-top: 0; font-size: var(--t-14); font-weight: 400; color: var(--ink-2); }
  /* the trust line: a plain paper strip, the mark drawn like the Token info tab's own, the whole line a button into that tab */
  .fixedline {
    display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; text-align: left;
    border: 0; background: var(--paper-2); border-radius: var(--r-sm); box-shadow: var(--sh-1);
    padding: var(--s-3) var(--s-4); font: inherit; color: var(--ink); cursor: pointer;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .fixedline:hover { transform: translateY(-2px); box-shadow: var(--sh-2); } }
  .fixedline:active { transform: translateY(1px); transition-duration: var(--d-press); }
  .fmark { width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--r-full); background: var(--ink); color: var(--paper); font-weight: 500; flex: none; }
  .fmark.warn { background: var(--bad); }
  .ftext { font-size: var(--t-14); }
  .fgo { margin-left: auto; font-weight: 700; font-size: var(--t-14); white-space: nowrap; }

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
  @media (hover: hover) { .lk:hover::before { background: var(--hover); } }
  .lk:active::before { box-shadow: inset 0 0 0 2px var(--ink-2); transition-duration: var(--d-press); }
  .lwarn { font-size: var(--t-14); max-width: 60ch; text-wrap: pretty; }
  .hiddenwarn { margin: 0; padding: var(--s-3) var(--s-4); border-radius: var(--r-md); background: var(--warn-bg); color: var(--warn-ink); font-size: var(--t-14); max-width: 60ch; }
  .payto { font-size: var(--t-14); overflow-wrap: anywhere; }
  /* the creator's address and the Creator wallet link to their profiles: plain text links, underlined, their hover only thickens the line */
  .plink { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .payto .plink { color: inherit; }
  .tabs-sec { display: grid; gap: var(--s-4); }
  .tabrow { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; justify-content: space-between; }
  .pull { min-height: 44px; padding: 0 var(--s-3); border: 0; background: transparent; color: var(--ink-2); font: inherit; font-size: var(--t-14); font-weight: 700; cursor: pointer; border-radius: var(--r-md); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 4px; }
  @media (hover: hover) { .pull:hover { color: var(--ink); background: var(--hover); } }
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
  .small-note { margin-top: calc(-1 * var(--s-1)); }
  .cardfold { display: grid; gap: var(--s-3); }
  .cardfold summary { cursor: pointer; font-weight: 700; font-size: var(--t-14); width: max-content; border-radius: var(--r-sm); }
  .cardfold summary::marker { color: var(--ink-2); }
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
    .tgrid { grid-template-columns: 1fr; gap: var(--s-6); }
    .stats { grid-template-columns: repeat(2, auto); gap: var(--s-4) var(--s-6); }
    .stats dd { font-size: var(--t-16); }
    .main, .side-col { display: contents; }
    .head { order: 1; } .trade-slot { order: 2; } .pot-slot { order: 3; } .main > :global(.chart) { order: 3; } .stats { order: 4; } .main > :global(.strip) { order: 4; } .fixedline { order: 5; } .tabs-sec { order: 6; } .main > :global(.fs) { order: 7; } .creator, .ref { order: 8; } .cta { order: 9; }
  }
  @media (max-width: 640px) {
    /* the buy box sits inside the first screen: a tighter top, the description on two lines (the full text sits under the box in the tabs' pages anyway) */
    .pad { padding-top: var(--s-4); }
    .grid { gap: var(--s-4); }
    .head { gap: var(--s-3); }
    .desc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: var(--t-14); }
    /* four tabs across a phone: shorter padding and the short fourth label, so all four sit on one row at 390 */
    .ctabs { width: 100%; }
    .pull { display: none; }
    .ctabs > button { padding: 0 var(--s-2); font-size: var(--t-14); flex: 1; justify-content: center; gap: var(--s-1); }
    .long { display: none; }
    .short { display: inline; }
  }
</style>
