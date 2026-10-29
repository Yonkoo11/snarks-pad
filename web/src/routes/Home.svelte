<script lang="ts">
  import { api, ApiError, onMode } from '../lib/api'
  import type { Coin, Epoch, PadMode, PadPot, Stats, Treasury } from '../lib/types'
  import type { CoinQuery, CoinSort, CoinStage } from '../lib/coins'
  import { filterCoins, sortCoins, pinFirst, serverSort, FEATURED } from '../lib/coins'
  import { zec, pct, ago, usdOfZats } from '../lib/format'
  import type { FeedState } from '../lib/tape'
  import { zecUsd } from '../lib/usd.svelte'
  import { poll } from '../lib/poll'
  import { wallet } from '../lib/wallet.svelte'
  import { readHoldings } from '../lib/holdings'
  import type { Holding } from '../lib/profile'
  import Taped from '../components/Taped.svelte'
  import CountUp from '../components/CountUp.svelte'
  import FillBar from '../components/FillBar.svelte'
  import CoinCard from '../components/CoinCard.svelte'
  import PulseBoard from '../components/PulseBoard.svelte'
  import NextPayout from '../components/NextPayout.svelte'
  import TradesTape from '../components/TradesTape.svelte'

  // Explore: the market itself. A compact banner, then one band with the coins closest to graduation and the live trades
  // tape, then the stats row, the tabs, sort, search and the grid or list of every coin, with pages. Everything refreshes
  // every 10 s while the tab is visible; the tape also takes the engine's stream when it has one.
  const PAGE = 12
  const POLL_MS = 10_000
  const TAPE_ROWS = 8 // eight 44px rows sit level with the three lanes beside them at 1440
  // the pulse board's three lanes: newest first, nearest graduation first, biggest graduated first
  const LANE_N = 4
  const FRESH: CoinQuery = { sort: 'new', limit: LANE_N, offset: 0 }
  const FILLING: CoinQuery = { sort: 'progress', stage: 'curve', limit: LANE_N, offset: 0 }
  const GRADUATED: CoinQuery = { sort: 'mcap', stage: 'graduated', limit: LANE_N, offset: 0 }
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))
  let tapeState = $state<FeedState>('loading')
  type Tab = 'new' | 'rising' | 'graduated' | 'all'
  const TABS: { id: Tab; label: string }[] = [{ id: 'new', label: 'New' }, { id: 'rising', label: 'Rising' }, { id: 'graduated', label: 'Graduated' }, { id: 'all', label: 'All' }]
  // "Featured" is the default: coin #1 first, then market cap; every other order is strict.
  const SORTS: { id: CoinSort; label: string }[] = [{ id: 'featured', label: 'Featured' }, { id: 'mcap', label: 'Market cap' }, { id: 'volume', label: '24h volume' }, { id: 'new', label: 'Newest' }, { id: 'progress', label: 'Curve progress' }]

  // A tab is a preset of stage and sort, and the lit tab is derived from them, so the controls can never contradict each other.
  let sort = $state<CoinSort>('featured')
  let stage = $state<CoinStage | ''>('')
  let search = $state('')
  let q = $state('')
  let page = $state(1)
  let view = $state<'grid' | 'list'>('grid')
  const tab = $derived<Tab>(stage === 'graduated' ? 'graduated' : sort === 'new' ? 'new' : sort === 'volume' ? 'rising' : 'all')
  function pickTab(t: Tab) {
    if (t === 'graduated') stage = 'graduated'
    else {
      stage = ''
      if (t === 'new') sort = 'new'
      else if (t === 'rising') sort = 'volume'
      else if (sort === 'new' || sort === 'volume') sort = 'featured'
    }
    page = 1
  }
  function pickSort(e: Event) { sort = (e.currentTarget as HTMLSelectElement).value as CoinSort; page = 1 }
  function showAll() { stage = ''; sort = 'featured'; search = ''; q = ''; page = 1 }
  // the search box filters 200 ms after the last keystroke
  $effect(() => {
    const s = search.trim()
    const t = setTimeout(() => { if (s !== q) { q = s; page = 1 } }, 200)
    return () => clearTimeout(t)
  })

  let laneFresh = $state<Coin[] | null>(null)
  let laneFilling = $state<Coin[] | null>(null)
  let laneGraduated = $state<Coin[] | null>(null)
  let coins = $state<Coin[] | null>(null)
  let total = $state(0)
  let fullList = $state<Coin[] | null>(null) // every coin, when the engine answered without paging (v2.4); null when it paged for us
  let stats = $state<Stats | null>(null)
  let treasury = $state<Treasury | null>(null)
  let epochs = $state<Epoch[] | null>(null)
  let padPot = $state<PadPot | null>(null) // GET /pot (v2.10): what every listed coin has accrued for the next round; null = not known, shown as a dash
  let err = $state<string | null>(null)
  let pollErr = $state(false)
  let lastRead = $state<number | null>(null)
  let now = $state(Date.now())
  let reqId = 0

  /** A v2.5 engine answers with `total` and has already filtered, sorted and sliced; a v2.4 engine returns every coin and the web does it here. */
  function pageOf(r: { coins: Coin[]; total?: number }, query: CoinQuery, pin: boolean): { coins: Coin[]; total: number; full: Coin[] | null } {
    if (r.total !== undefined) return { coins: pin ? pinFirst(r.coins, FEATURED) : r.coins, total: r.total, full: null }
    const all = sortCoins(filterCoins(r.coins, query), pin ? 'featured' : (query.sort ?? 'mcap'))
    const offset = query.offset ?? 0
    return { coins: all.slice(offset, offset + (query.limit ?? all.length)), total: all.length, full: r.coins }
  }
  async function load() {
    const id = ++reqId
    const query: CoinQuery = { sort: serverSort(sort), stage: stage || undefined, q: q || undefined, limit: PAGE, offset: (page - 1) * PAGE }
    const pin = sort === 'featured'
    try {
      const [f, n, g, l] = await Promise.all([api.coins(FRESH), api.coins(FILLING), api.coins(GRADUATED), api.coins(query)])
      if (id !== reqId) return // a newer request is in flight
      laneFresh = pageOf(f, FRESH, false).coins
      laneFilling = pageOf(n, FILLING, false).coins
      laneGraduated = pageOf(g, GRADUATED, false).coins
      const pg = pageOf(l, query, pin)
      coins = pg.coins; total = pg.total; fullList = pg.full
      err = null; pollErr = false; lastRead = Date.now()
    } catch (e) {
      if (id !== reqId) return
      if (coins) pollErr = true
      else err = e instanceof ApiError && e.code === 'unreachable' ? 'Could not reach the pad. Check your connection and try again.' : 'Could not load the coins from the pad.'
    }
  }
  // The market line's numbers: /stats when the engine has it (v2.5), else what /coins and /epochs allow; a failure here is a dash, never an error.
  // A v2.4 engine answers /stats with 404: it is asked once per page, not every 10 s.
  let statsGone = false
  let padPotGone = false
  async function loadSide() {
    const readStats = statsGone ? Promise.resolve(null) : api.stats().catch((e) => { if (e instanceof ApiError && e.status === 404) statsGone = true; return null })
    const [s, t, e, p] = await Promise.all([readStats, api.treasury().catch(() => null), api.epochs().catch(() => null), padPotGone ? Promise.resolve(null) : api.padPot().catch((e) => { if (e instanceof ApiError && e.status === 404) padPotGone = true; return null })])
    stats = s; treasury = t; epochs = e ? e.epochs : null; padPot = p
  }
  $effect(() => { zecUsd.refresh() })
  // load() reads the controls before its first await, so a tab, sort, search or page change restarts the poll and reads at once.
  $effect(() => poll(load, POLL_MS))
  $effect(() => poll(loadSide, POLL_MS))
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })

  const pages = $derived(Math.max(1, Math.ceil(total / PAGE)))
  const failed = $derived(!!err && !coins)
  const filtering = $derived(!!q || stage !== '')
  const nCoins = $derived(stats?.coins ?? fullList?.length ?? null)
  const nGrad = $derived(stats?.graduated ?? (fullList ? fullList.filter((c) => c.stage === 'graduated').length : null))
  const vol = $derived.by(() => {
    if (stats?.volume24hZats !== undefined) return zec(stats.volume24hZats, 2)
    if (fullList && fullList.length > 0 && fullList.every((c) => c.volume24hZats !== undefined)) return zec(fullList.reduce((a, c) => a + BigInt(c.volume24hZats ?? '0'), 0n), 2)
    return null
  })
  const paidSol = $derived(stats?.paidSolanaZats !== undefined ? BigInt(stats.paidSolanaZats) : epochs ? epochs.reduce((a, e) => a + BigInt(e.solanaPayouts.totalZats), 0n) : null)
  const paidShd = $derived(stats?.paidShieldedZats !== undefined ? BigInt(stats.paidShieldedZats) : epochs ? epochs.reduce((a, e) => a + BigInt(e.shielded.totalZats), 0n) : null)
  const paidAll = $derived(paidSol !== null && paidShd !== null ? paidSol + paidShd : null)
  const sideLoading = $derived(nCoins === null && paidAll === null && !failed && coins === null)
  // the last round that paid anyone, as the Payouts page orders them (newest first); its wallet count is already public there
  const lastPaid = $derived(epochs?.find((e) => e.shielded.count + e.solanaPayouts.count > 0) ?? null)
  // the proof strip's two counts, from the rounds the page already holds; a wallet paid in several rounds counts once per payment, as the Payouts page counts
  const nPayments = $derived(epochs ? epochs.reduce((a, e) => a + e.solanaPayouts.count + e.shielded.count, 0) : null)
  const nRounds = $derived(epochs ? epochs.length : null)
  // the one note a returning visitor gets: this browser's last visit, read once per mount, before the stamp below overwrites it
  const prevVisit: number | null = (() => {
    try {
      const v = localStorage.getItem('snarks-last-visit')
      localStorage.setItem('snarks-last-visit', String(Date.now()))
      return v ? Number(v) : null
    } catch { return null }
  })()
  const newSince = $derived(!!lastPaid && prevVisit !== null && Date.parse(lastPaid.at) > prevVisit)
  // The round strip under the hero carries the pot and the clock, so the stats row near the grid does not repeat them.
  const stripClock = $derived(!!treasury || !!padPot)
  // A round landing while the page is open: the new receipt announces itself once, then sits still.
  let seenRound: string | null = null
  let landed = $state(false)
  $effect(() => {
    const id = lastPaid?.id ?? null
    if (id === null) return
    if (seenRound === null) { seenRound = id; return }
    if (id !== seenRound) {
      seenRound = id; landed = true
      const t = setTimeout(() => (landed = false), 1400)
      return () => clearTimeout(t)
    }
  })
  function toMarket() { document.getElementById('market-h')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  // the return hook: a connected wallet sees its own bag above the market, read in the browser like the Holdings tab
  let bag = $state<Holding[] | null>(null)
  $effect(() => {
    const w = wallet.address
    bag = null
    if (!w) return
    readHoldings(w).then((r) => { if (wallet.address === w) bag = r }, () => {})
  })
  // the tape tags a row "dev" when its wallet created that coin; the creators are read off the coins the page already holds
  const creators = $derived(Object.fromEntries([...(coins ?? []), ...(laneFresh ?? []), ...(laneFilling ?? []), ...(laneGraduated ?? []), ...(fullList ?? [])].map((c) => [c.mint, c.creator])))
  // a board with fewer coins than a row holds offers the next slot to the visitor instead of an empty cell
  const offerLaunch = $derived(!!coins && coins.length > 0 && coins.length < 4 && !filtering && page === 1)
</script>

<!-- the Fridge door hero: the headline with air around it, the taped drawing big on the right, nothing behind it (the owner dropped the hatched shadow, 2026-10-07) -->
<section class="wrap hero">
  <div class="copy">
    <h1 class="display">Coins on Meteora that pay holders in ZEC, <em>shielded</em> if you opt in.</h1>
    <p class="lede">Every trade pays its fee in ZEC, and holders are paid from it each round. Opt in and your share arrives as native ZEC in your own Zcash wallet.</p>
    <!-- the proof, biggest thing after the headline: what this pad has already paid, linked to the rounds that prove it -->
    {#if paidAll !== null && paidAll > 0n}
      <a class="proof" href="#/treasury" aria-label="Every payout round, with its transactions">
        <span class="p-item"><span class="label">Paid to holders</span><span class="p-big"><CountUp value={Number(paidAll)} format={(v) => `${zec(BigInt(Math.round(v)))} ZEC`} /></span>{#if usdOfZats(paidAll, zecUsd.rate)}<span class="p-usd">{usdOfZats(paidAll, zecUsd.rate)}</span>{/if}</span>
        {#if nPayments !== null}<span class="p-item"><span class="label">Payments</span><span class="p-big"><CountUp value={nPayments} ms={700} format={(v) => Math.round(v).toLocaleString('en-US')} /></span></span>{/if}
        {#if nRounds !== null}<span class="p-item"><span class="label">Rounds</span><span class="mono p-big">{nRounds}</span></span>{/if}
        <span class="p-item"><span class="label"><span class="key hatch" aria-hidden="true"></span>Of it shielded</span><span class="mono p-big">{zec(paidShd ?? 0n)} ZEC</span></span>
      </a>
    {:else if paidAll === 0n}
      <p class="muted">No round has paid yet. The first payout lands after the first round closes.</p>
    {/if}
    <div class="actions">
      <button class="btn primary" type="button" onclick={toMarket}>See the coins</button>
      <a class="btn shd" href="#/shielded"><span class="key hatch" aria-hidden="true"></span>Get my rewards shielded</a>
    </div>
  </div>
  <div class="art"><Taped settle /></div>
</section>

<!-- the round strip: the latest receipt beside the pot that is filling for the next one. The pad's heartbeat, pinned under the hero. -->
{#if lastPaid || stripClock}
  <section class="wrap roundstrip" aria-label="The latest payout and the pot for the next">
    {#if lastPaid}
      {@const n = lastPaid.shielded.count + lastPaid.solanaPayouts.count}
      <a class="receipt panel" class:landed href="#/treasury">
        <span class="r-head"><span class="mono r-id" title={lastPaid.id}>Round #{epochs ? epochs.length - epochs.findIndex((e) => e.id === lastPaid.id) : ''}</span><span class="muted">{ago(lastPaid.at, now)}</span>{#if newSince}<span class="chip">New since your last visit</span>{/if}</span>
        <span class="r-line"><span class="label">Claimed</span><span class="mono">{zec(lastPaid.harvestedZats)} ZEC</span></span>
        <span class="r-line"><span class="label">Paid</span><span class="mono">{n.toLocaleString('en-US')} {n === 1 ? 'wallet' : 'wallets'}</span></span>
        {#if lastPaid.shielded.count > 0}<span class="r-line"><span class="label"><span class="key hatch" aria-hidden="true"></span>Shielded leg</span><span class="mono">{zec(lastPaid.shielded.totalZats)} ZEC to {lastPaid.shielded.count}</span></span>{/if}
        <span class="r-go">Every round, with its transactions</span>
      </a>
    {/if}
    {#if stripClock}
      <div class="potcard panel">
        <p class="label">In the pot for the next round</p>
        <p class="pot-line"><span class="mono pot-big">{padPot ? `${zec(padPot.accruedZats)} ZEC` : '–'}</span>{#if padPot && usdOfZats(padPot.accruedZats, zecUsd.rate)}<span class="pot-usd">{usdOfZats(padPot.accruedZats, zecUsd.rate)}</span>{/if}</p>
        {#if padPot}<p class="muted pot-sub">Trading fees accruing across {padPot.coins} {padPot.coins === 1 ? 'coin' : 'coins'}, waiting for the round to claim them.</p>{/if}
        <FillBar fromIso={treasury?.lastEpochAt ?? null} toIso={treasury?.nextEpochAt ?? null} {now} />
        <p class="pot-clock">{#if treasury}<NextPayout at={treasury.nextEpochAt} {now} everyMs={treasury.cadence?.roundEveryMs ?? null} />{:else}<span class="mono">–</span>{/if}</p>
      </div>
    {/if}
  </section>
{/if}

<!-- a connected wallet's own line: what it holds here and when the next payout runs -->
{#if wallet.address && bag && bag.length > 0}
  <section class="wrap" aria-label="Your coins on this pad">
    <a class="bagline panel" href="#/me?tab=holdings">
      <span>You hold <span class="mono">{bag.length}</span> pad {bag.length === 1 ? 'coin' : 'coins'} with this wallet.</span>
      {#if treasury}<span class="muted">Next payout <NextPayout at={treasury.nextEpochAt} now={now} everyMs={treasury.cadence?.roundEveryMs ?? null} bare /></span>{/if}
      <span class="r-go">Your coins and rewards</span>
    </a>
  </section>
{/if}

<div class="wrap band" class:with-tape={tapeState !== 'absent'}>
  <section class="strip" aria-labelledby="pulse-h">
    <div class="sec-head">
      <h2 class="h3" id="pulse-h">On the pad right now</h2>
      {#if pollErr}<p class="live error">Lost the connection to the pad. Trying again every {POLL_MS / 1000}s.</p>
      {/if}
    </div>
    {#if failed && laneFresh === null}
      <p class="muted">Not loaded.</p>
    {:else}
      <PulseBoard fresh={laneFresh} filling={laneFilling} graduated={laneGraduated} {now} />
    {/if}
  </section>
  <!-- the pad-wide tape; an engine without GET /trades (v2.5) answers 404 and the block is not shown -->
  <section class="tape-sec" aria-labelledby="tape-h" hidden={tapeState === 'absent'}>
    <h2 class="h3" id="tape-h">Live trades</h2>
    <TradesTape compact limit={TAPE_ROWS} everyMs={POLL_MS} {creators} {mode} {now} onstate={(s) => (tapeState = s)} />
  </section>
</div>

<section class="wrap market" aria-labelledby="market-h">
  <h2 class="h3" id="market-h">Coins</h2>
  <div class="controls">
    <div class="seg tabs" role="tablist" aria-label="Coin lists">
      {#each TABS as t (t.id)}<button type="button" role="tab" aria-selected={tab === t.id} class:on={tab === t.id} onclick={() => pickTab(t.id)}>{t.label}</button>{/each}
    </div>
    <label class="ctl"><span class="label">Sort</span><select class="input sel" value={sort} onchange={pickSort}>{#each SORTS as s (s.id)}<option value={s.id}>{s.label}</option>{/each}</select></label>
    <div class="seg view" role="group" aria-label="View">
      <button type="button" aria-pressed={view === 'grid'} class:on={view === 'grid'} onclick={() => (view = 'grid')}>Grid</button>
      <button type="button" aria-pressed={view === 'list'} class:on={view === 'list'} onclick={() => (view = 'list')}>List</button>
    </div>
    <input class="input search" type="search" placeholder="Search coins" aria-label="Search coins by name or ticker" autocomplete="off" bind:value={search} />
  </div>

  <!-- the stats row: /stats when the engine has it (v2.5), else what /coins and /epochs allow; a number that is not known is a dash -->
  {#if sideLoading}
    <div class="skel stats-sk" aria-busy="true" aria-label="Loading the market numbers"></div>
  {:else}
    <dl class="stats" aria-label="Market numbers">
      <div><dt class="label">Coins</dt><dd class="mono">{nCoins ?? '–'}</dd></div>
      <div><dt class="label">Graduated</dt><dd class="mono">{nGrad ?? '–'}</dd></div>
      <div><dt class="label">24h volume on this pad</dt><dd class="mono">{vol === null ? '–' : `${vol} ZEC`}</dd></div>
      <!-- the pot and the clock live on the round strip under the hero; they return here only when that strip has nothing to show -->
      {#if !stripClock}
        <div><dt class="label">In the pot now</dt><dd class="mono">–</dd></div>
        <div><dt class="label">Next payout</dt><dd class="mono">–</dd></div>
      {/if}
    </dl>
  {/if}

  {#if coins === null}
    {#if failed}
      <div class="fail"><p class="error">{err}</p><button class="btn" type="button" onclick={load}>Try again</button></div>
    {:else}
      <div class="grid" aria-busy="true" aria-label="Loading the coins">{#each [0, 1, 2, 3, 4, 5, 6, 7] as i (i)}<div class="skel card-sk"></div>{/each}</div>
    {/if}
  {:else if coins.length === 0}
    {#if filtering}
      <div class="none"><p class="muted">No coins match.</p><button class="btn ghost" type="button" onclick={showAll}>Show all coins</button></div>
    {:else}
      <div class="panel empty"><p>No coins yet. Launch the first.</p><a class="btn primary" href="#/launch">Launch a coin</a></div>
    {/if}
  {:else if view === 'list'}
    <div class="list" role="table" aria-label="Coins">
      <div class="lhead" role="row">
        <span role="columnheader" class="label">Coin</span><span role="columnheader" class="label num">Market cap</span>
        <span role="columnheader" class="label num hide-md">24h volume</span><span role="columnheader" class="label num hide-md">24h</span>
        <span role="columnheader" class="label num hide-md">Holders</span><span role="columnheader" class="label">Bonded</span>
        <span role="columnheader" class="label num hide-md">Fee</span><span role="columnheader" class="label num hide-md">Age</span>
      </div>
      {#each coins as c (c.mint)}<CoinCard coin={c} view="list" rate={zecUsd.rate} {now} />{/each}
    </div>
  {:else}
    <div class="grid">
      {#each coins as c (c.mint)}<CoinCard coin={c} rate={zecUsd.rate} {now} />{/each}
      {#if offerLaunch}
        <a class="card launch panel" href="#/launch">
          <span class="h3">Your coin here.</span>
          <span class="muted">A name, a ticker, a drawing. It pays its holders in ZEC from its first trade.</span>
          <span class="btn primary">Launch a coin</span>
        </a>
      {/if}
    </div>
  {/if}

  {#if total > PAGE}
    <nav class="pages" aria-label="Pages">
      <button class="btn" type="button" disabled={page <= 1} onclick={() => (page -= 1)}>Previous</button>
      <p class="mono">Page {page} of {pages}</p>
      <button class="btn" type="button" disabled={page >= pages} onclick={() => (page += 1)}>Next</button>
    </nav>
  {/if}
</section>

<style>
  .hero { display: grid; grid-template-columns: 1.5fr 1fr; gap: var(--s-7); align-items: center; padding-top: var(--s-6); padding-bottom: var(--s-5); }
  .hero .display { font-size: clamp(34px, 3.4vw, 48px); }
  .copy { display: grid; gap: var(--s-5); max-width: 640px; }
  .lede { font-size: var(--t-20); line-height: 1.45; color: var(--ink-2); max-width: 54ch; }
  .actions { display: flex; gap: var(--s-3); flex-wrap: wrap; }
  .shd { white-space: nowrap; }
  .art { display: grid; place-items: center; }
  .key { display: inline-block; width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }

  /* the proof strip: a paper slip, barely tilted, with the paid total as the biggest number on the page */
  .proof {
    display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); align-items: end;
    background: var(--paper-2); border-radius: var(--r-xs);
    box-shadow: var(--sh-2), inset 0 1px 0 light-dark(transparent, rgba(239, 231, 218, .07));
    padding: var(--s-4) var(--s-5); transform: rotate(-.4deg);
    text-decoration: none; color: inherit; max-width: max-content;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .proof:hover { transform: rotate(-.4deg) translateY(-2px); box-shadow: var(--sh-3); } }
  .p-item { display: grid; gap: 2px; }
  .p-item .label { display: flex; align-items: center; gap: var(--s-1); }
  .p-big { font-size: var(--t-20); }
  .p-item:first-child .p-big { font-size: clamp(26px, 2.2vw, 32px); line-height: 1.1; }
  .p-usd { font-size: var(--t-14); color: var(--ink-3); }

  /* the round strip: the receipt takes the width it needs, the pot card holds the clock beside it */
  .roundstrip { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: var(--s-4); align-items: stretch; }
  .roundstrip:not(:has(.receipt)) { grid-template-columns: minmax(0, 560px); }
  .potcard { display: grid; gap: var(--s-2); align-content: start; padding: var(--s-4) var(--s-5); }
  .pot-line { display: flex; align-items: baseline; gap: var(--s-2); flex-wrap: wrap; }
  .pot-big { font-size: var(--t-20); font-weight: 500; }
  .pot-usd { font-size: var(--t-14); color: var(--ink-3); }
  .pot-sub { font-size: var(--t-14); }
  .pot-clock { font-size: var(--t-14); font-weight: 700; }
  /* a round that lands while the page is open: the receipt drops in once, then sits still (entrance-only) */
  .receipt.landed { animation: land 600ms var(--ease) backwards; }
  @keyframes land {
    from { transform: translateY(-10px) rotate(-.8deg); box-shadow: var(--sh-3); opacity: 0; }
    to { transform: none; box-shadow: var(--sh-1); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .receipt.landed { animation: none; } }

  /* the latest round: one receipt row under the hero, every number mono, the shielded leg hatched */
  .receipt {
    display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); align-items: end; justify-content: space-between;
    text-decoration: none; color: inherit; padding: var(--s-4) var(--s-5);
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  .r-head { align-self: center; }
  @media (hover: hover) { .receipt:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  .receipt:active { transform: translateY(1px); box-shadow: var(--sh-1); transition-duration: var(--d-press); }
  .r-head { display: flex; align-items: center; gap: var(--s-3); }
  .r-id { font-weight: 500; font-size: var(--t-20); }
  .r-line { display: grid; gap: 2px; }
  .r-line .label { display: flex; align-items: center; gap: var(--s-1); }
  .r-go { margin-left: auto; font-weight: 700; font-size: var(--t-14); }
  .r-go::after { content: ' \2192'; }
  .bagline {
    display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-6); align-items: baseline;
    margin-top: var(--s-4); padding: var(--s-3) var(--s-5);
    text-decoration: none; color: inherit;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .bagline:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }

  /* one band: the strip, and beside it at 1100px and above the live tape (320px); the tape drops under the strip below that */
  .band { padding-top: var(--s-7); display: grid; gap: var(--s-5); align-items: start; }
  .band.with-tape { grid-template-columns: minmax(0, 1fr) 320px; }
  .strip { display: grid; gap: var(--s-3); min-width: 0; }
  .tape-sec { display: grid; gap: var(--s-3); min-width: 0; }
  .tape-sec[hidden] { display: none; }
  .sec-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s-4); flex-wrap: wrap; }
  .live { font-size: var(--t-14); }
  .market { padding-top: var(--s-8); display: grid; gap: var(--s-4); }
  .controls { display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center; }
  /* the tabs and the view toggle are the shared .seg control (app.css); only their layout lives here */
  .ctl { display: flex; align-items: center; gap: var(--s-2); position: relative; }
  /* the sort menu wears the same clothes as every other control: paper fill, no border, its own drawn chevron */
  .sel {
    width: 180px; min-height: 44px; padding: 0 var(--s-6) 0 var(--s-3);
    appearance: none; border: 0; background: var(--paper-3); border-radius: var(--r-md); font-weight: 700; cursor: pointer;
  }
  .ctl::after { content: '\25BE'; position: absolute; right: var(--s-3); pointer-events: none; color: var(--ink-2); }
  .search { width: 220px; min-height: 44px; order: 3; }
  .view { margin-left: auto; order: 4; }
  /* the stats row: label over number, as many tiles as the row holds */
  .stats { display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); margin: 0; }
  .stats dd { margin: var(--s-1) 0 0; font-size: var(--t-20); font-weight: 500; }
  .stats .label { display: flex; align-items: center; gap: var(--s-1); }
  .stats-sk { height: 52px; max-width: 70ch; }
  /* as many cards as fit at 250px and up; with fewer coins than a row the cards grow to fill it, up to 440px each */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: var(--s-4); }
  .grid > :global(.card) { max-width: 440px; width: 100%; }
  .launch { display: grid; gap: var(--s-3); align-content: center; justify-items: start; text-decoration: none; color: inherit; box-shadow: inset 0 0 0 2px var(--line); background: transparent; min-height: 320px; padding: var(--s-5); border-radius: var(--r-md); transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease); }
  @media (hover: hover) { .launch:hover { transform: translateY(-2px); box-shadow: inset 0 0 0 2px var(--ink-3); } }
  .launch:active { transform: translateY(1px); transition-duration: var(--d-press); }
  .card-sk { height: 490px; border-radius: var(--r-md); }
  .list { display: grid; }
  .lhead { display: grid; grid-template-columns: minmax(0, 2.2fr) 1.1fr 1fr .7fr .7fr 1.3fr .6fr .7fr; gap: var(--s-4); padding: 0 var(--s-3) var(--s-2); }
  .num { text-align: right; }
  .fail, .none { display: grid; gap: var(--s-3); justify-items: start; padding: var(--s-4) 0; }
  .empty { display: grid; gap: var(--s-4); justify-items: center; align-content: center; min-height: 160px; text-align: center; font-size: var(--t-20); font-weight: 700; }
  .pages { display: flex; gap: var(--s-3); justify-content: center; align-items: center; padding-top: var(--s-5); }
  .pages p { font-size: var(--t-14); }

  @media (max-width: 900px) {
    /* the drawing sits small beside the headline, as on the Fridge door phone layout */
    .hero { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'title art' 'lede lede' 'proof proof' 'actions actions'; gap: var(--s-4); padding-top: var(--s-4); padding-bottom: var(--s-3); }
    .copy { display: contents; }
    .copy > h1 { grid-area: title; align-self: center; }
    .lede { grid-area: lede; }
    .proof, .copy > .muted { grid-area: proof; }
    .actions { grid-area: actions; }
    .art { grid-area: art; }
    .art :global(.taped) { width: 124px; padding: 6px; }
    .art :global(.tape) { width: 44px; height: 14px; top: -7px; }
    .band { padding-top: var(--s-6); }
    .market { padding-top: var(--s-7); }
    .roundstrip { grid-template-columns: 1fr; }
  }
  @media (max-width: 1100px) {
    .band.with-tape { grid-template-columns: 1fr; }
  }
  @media (max-width: 800px) {
    .lhead { grid-template-columns: minmax(0, 2fr) 1fr 1.2fr; }
    .hide-md { display: none; }
  }
  @media (max-width: 640px) {
    .hero .display { font-size: 34px; }
    .lede { font-size: var(--t-16); line-height: 1.4; }
    .actions .btn { flex: 1 1 auto; }
    /* the slip sits flat on a phone: the paid total takes the first row whole, the counts share the second */
    .proof { transform: none; max-width: none; display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3) var(--s-4); }
    .proof .p-item:first-child, .proof .p-item:last-child { grid-column: 1 / -1; }
    .receipt { gap: var(--s-3) var(--s-4); }
    .r-go { margin-left: 0; flex: 1 1 100%; }
    /* three rows: the tabs; sort beside Grid or List; the search box */
    .tabs { width: 100%; display: grid; grid-template-columns: repeat(4, 1fr); }
    .tabs button { padding: 0 var(--s-2); }
    .ctl { flex: 1 1 auto; }
    .sel { flex: 1; width: auto; }
    .view { margin-left: 0; order: 2; }
    .search { flex: 1 1 100%; width: auto; }
    .stats { gap: var(--s-3) var(--s-5); }
    .stats dd { font-size: var(--t-16); }
    /* one row-shaped card per line on a phone (CoinCard lays itself out as a row at this width) */
    .grid { grid-template-columns: 1fr; gap: var(--s-3); }
    .grid > :global(.card) { max-width: none; }
    .launch { min-height: 0; padding: var(--s-4); }
    .card-sk { height: 196px; }
  }
</style>
