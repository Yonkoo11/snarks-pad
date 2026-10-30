<script lang="ts">
  import { api, ApiError } from '../lib/api'
  import type { Coin, PadMode, Stats } from '../lib/types'
  import type { CoinQuery, CoinSort, CoinStage } from '../lib/coins'
  import { filterCoins, sortCoins, pinFirst, serverSort, FEATURED } from '../lib/coins'
  import { zec } from '../lib/format'
  import { zecUsd } from '../lib/usd.svelte'
  import { poll } from '../lib/poll'
  import { onMode } from '../lib/api'
  import { reducedMotion, dataTween } from '../lib/motion'
  import { flip } from 'svelte/animate'
  import CoinCard from '../components/CoinCard.svelte'
  import CoinImage from '../components/CoinImage.svelte'
  import Pager from '../components/Pager.svelte'

  // The catalog is its own page: one job (pick a coin), every coin, real pages. Launching is the one
  // act here, so it is the button in the header, not a nav destination. The Pad door stays one screen
  // and sends people here.
  const PAGE = 24
  const POLL_MS = 10_000
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))
  type Tab = 'new' | 'rising' | 'graduated' | 'all'
  const TABS: { id: Tab; label: string }[] = [{ id: 'new', label: 'New' }, { id: 'rising', label: 'Rising' }, { id: 'graduated', label: 'Graduated' }, { id: 'all', label: 'All' }]
  const SORTS: { id: CoinSort; label: string }[] = [{ id: 'featured', label: 'Featured' }, { id: 'mcap', label: 'Market cap' }, { id: 'volume', label: '24h volume' }, { id: 'new', label: 'Newest' }, { id: 'progress', label: 'Curve progress' }]

  let sort = $state<CoinSort>('featured')
  let stage = $state<CoinStage | ''>('')
  let search = $state('')
  let q = $state('')
  let view = $state<'grid' | 'list'>('grid')
  // the one filter chip the product earns: coins whose holders have actually been paid shielded ZEC.
  // The engine has no such filter, so the chip reads the whole list once (up to 1000) and pages here.
  let shieldedOnly = $state(false)
  let allForChip = $state<Coin[] | null>(null)
  $effect(() => {
    if (!shieldedOnly || allForChip) return
    api.coins({ all: true, limit: 1000 }).then((r) => (allForChip = r.coins), () => (shieldedOnly = false))
  })
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
    history.replaceState(null, '', '#/coins')
  }
  function pickSort(e: Event) { sort = (e.currentTarget as HTMLSelectElement).value as CoinSort; page = 1; history.replaceState(null, '', '#/coins') }
  function showAll() { stage = ''; sort = 'featured'; search = ''; q = ''; page = 1; history.replaceState(null, '', '#/coins') }
  $effect(() => {
    const s = search.trim()
    const t = setTimeout(() => { if (s !== q) { q = s; page = 1 } }, 200)
    return () => clearTimeout(t)
  })

  let spot = $state<Coin | null>(null) // the biggest market cap on the pad, the page's one big face
  let coins = $state<Coin[] | null>(null)
  let total = $state(0)
  let fullList = $state<Coin[] | null>(null)
  let stats = $state<Stats | null>(null)
  let err = $state<string | null>(null)
  let pollErr = $state(false)
  let now = $state(Date.now())
  let reqId = 0

  // the page lives in the address (#/coins?page=2), the house list standard
  let page = $state(Math.max(1, Number(new URLSearchParams(location.hash.split('?')[1] || '').get('page')) || 1))
  function goPage(p: number) {
    page = Math.min(Math.max(1, p), pages)
    history.replaceState(null, '', page > 1 ? `#/coins?page=${page}` : '#/coins')
    document.getElementById('coins-h')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })
  }

  /** A v2.5 engine answers with `total` and has already filtered, sorted and sliced; a v2.4 engine returns every coin and the page does it here. */
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
      const l = await api.coins(query)
      if (id !== reqId) return
      const pg = pageOf(l, query, pin)
      coins = pg.coins; total = pg.total; fullList = pg.full
      err = null; pollErr = false
    } catch (e) {
      if (id !== reqId) return
      if (coins) pollErr = true
      else err = e instanceof ApiError && e.code === 'unreachable' ? 'Could not reach the pad. Check your connection and try again.' : 'Could not load the coins from the pad.'
    }
  }
  async function loadSpot() {
    try { const r = await api.coins({ sort: 'mcap', limit: 1 }); spot = r.coins[0] ?? null } catch { /* the strip just stays away */ }
  }
  let statsGone = false
  async function loadStats() {
    if (statsGone) return
    stats = await api.stats().catch((e) => { if (e instanceof ApiError && e.status === 404) statsGone = true; return null })
  }
  $effect(() => { zecUsd.refresh() })
  $effect(() => poll(load, POLL_MS))
  $effect(() => poll(loadStats, POLL_MS))
  $effect(() => poll(loadSpot, POLL_MS))
  $effect(() => { const t = setInterval(() => (now = Date.now()), 1000); return () => clearInterval(t) })

  const shieldedList = $derived(allForChip ? allForChip.filter((c) => BigInt(c.rewards.paidShieldedZec || '0') > 0n) : null)
  const shownCoins = $derived(shieldedOnly ? (shieldedList ? shieldedList.slice((page - 1) * PAGE, page * PAGE) : null) : coins)
  const shownTotal = $derived(shieldedOnly ? (shieldedList?.length ?? 0) : total)
  const pages = $derived(Math.max(1, Math.ceil(shownTotal / PAGE)))
  const failed = $derived(!!err && !coins)
  const filtering = $derived(!!q || stage !== '')
  const nCoins = $derived(stats?.coins ?? fullList?.length ?? null)
  const nGrad = $derived(stats?.graduated ?? (fullList ? fullList.filter((c) => c.stage === 'graduated').length : null))
  const vol = $derived.by(() => {
    if (stats?.volume24hZats !== undefined) return zec(stats.volume24hZats, 2)
    if (fullList && fullList.length > 0 && fullList.every((c) => c.volume24hZats !== undefined)) return zec(fullList.reduce((a, c) => a + BigInt(c.volume24hZats ?? '0'), 0n), 2)
    return null
  })
  const offerLaunch = $derived(!!coins && coins.length > 0 && coins.length < 4 && !filtering && page === 1)
</script>

<section class="wrap pad" aria-labelledby="coins-h">
  <header class="head">
    <div class="title">
      <h1 class="display" id="coins-h">Every coin on the pad.</h1>
      <p class="lede muted">Each one pays its holders 0.1% of every trade, in ZEC.</p>
    </div>
    <dl class="day" aria-label="The pad today">
      <div><dt class="label">Coins</dt><dd class="mono">{nCoins ?? '–'}</dd></div>
      <div><dt class="label">Graduated</dt><dd class="mono">{nGrad ?? '–'}</dd></div>
      <div><dt class="label">24h volume</dt><dd class="mono">{vol === null ? '–' : `${vol} ZEC`}</dd></div>
    </dl>
    <a class="btn primary" href="#/launch">Launch a coin</a>
  </header>

  {#if spot}
    <!-- the pad's one big face: the largest market cap, letscash's LARGEST translated to paper -->
    <a class="spot panel" href="#/coin/{spot.mint}">
      <CoinImage src={spot.imageUrl} symbol={spot.symbol} size={96} />
      <span class="s-t"><span class="label">The biggest on the pad</span><strong class="s-name">{spot.name}</strong><span class="mono s-sym">${spot.symbol}</span></span>
      <dl class="s-nums">
        <div><dt class="label">Market cap</dt><dd class="mono">{spot.marketCapZec === undefined ? '–' : `${zec(spot.marketCapZec, 2)} ZEC`}</dd></div>
        <div><dt class="label">24h volume</dt><dd class="mono">{spot.volume24hZats === undefined ? '–' : `${zec(spot.volume24hZats, 2)} ZEC`}</dd></div>
        <div><dt class="label">Holders</dt><dd class="mono">{spot.holders == null ? '–' : spot.holders.toLocaleString('en-US')}</dd></div>
      </dl>
      <span class="s-go" aria-hidden="true">&rarr;</span>
    </a>
  {/if}

  <div class="controls">
    <div class="seg tabs" role="group" aria-label="Coin lists">
      {#each TABS as t (t.id)}<button type="button" aria-pressed={tab === t.id} onclick={() => pickTab(t.id)}>{t.label}</button>{/each}
    </div>
    <label class="ctl"><span class="label">Sort</span><select class="input sel" value={sort} onchange={pickSort}>{#each SORTS as s (s.id)}<option value={s.id}>{s.label}</option>{/each}</select></label>
    <div class="seg view" role="group" aria-label="View">
      <button type="button" aria-pressed={view === 'grid'} onclick={() => (view = 'grid')}>Grid</button>
      <button type="button" aria-pressed={view === 'list'} onclick={() => (view = 'list')}>List</button>
    </div>
    <input class="input search" type="search" placeholder="Search coins" aria-label="Search coins by name or ticker" autocomplete="off" bind:value={search} />
    <button class="chipbtn" type="button" aria-pressed={shieldedOnly} onclick={() => { shieldedOnly = !shieldedOnly; page = 1; history.replaceState(null, '', '#/coins') }}>
      <span class="key hatch" aria-hidden="true"></span>Shielded delivery
    </button>
  </div>
  {#if pollErr}<p class="live error" role="alert">Lost the connection to the pad. Trying again every {POLL_MS / 1000}s.</p>{/if}

  {#if shownCoins === null}
    {#if failed}
      <div class="fail"><p class="error" role="alert">{err}</p><button class="btn" type="button" onclick={load}>Try again</button></div>
    {:else}
      <div class="grid" aria-busy="true" aria-label="Loading the coins">{#each [0, 1, 2, 3, 4, 5, 6, 7] as i (i)}<div class="skel card-sk"></div>{/each}</div>
    {/if}
  {:else if shownCoins.length === 0}
    {#if shieldedOnly}
      <div class="none"><p class="muted">No coin's holders have been paid shielded ZEC yet.</p><button class="btn ghost" type="button" onclick={() => (shieldedOnly = false)}>Show all coins</button></div>
    {:else if filtering}
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
      {#each shownCoins as c (c.mint)}<CoinCard coin={c} view="list" rate={zecUsd.rate} {now} />{/each}
    </div>
  {:else}
    <div class="grid">
      {#each shownCoins as c (c.mint)}<div class="cardcell" animate:flip={dataTween()}><CoinCard coin={c} rate={zecUsd.rate} {now} gallery={tab === 'graduated'} /></div>{/each}
      {#if offerLaunch}
        <a class="card launch panel" href="#/launch">
          <span class="h3">Your coin here.</span>
          <span class="muted">A name, a ticker, a drawing. It pays its holders in ZEC from its first trade.</span>
          <span class="btn primary">Launch a coin</span>
        </a>
      {/if}
    </div>
  {/if}

  <Pager {page} {pages} total={shownTotal} per={PAGE} label="Catalog pages" unit="Coins" onpage={goPage} />
</section>

<style>
  .pad { padding-top: var(--s-6); display: grid; gap: var(--s-4); }
  .head { display: flex; flex-wrap: wrap; gap: var(--s-4) var(--s-7); align-items: end; padding-bottom: var(--s-2); }
  .title { display: grid; gap: var(--s-1); margin-right: auto; }
  .display { font-size: clamp(30px, 2.6vw, 36px); }
  .lede { font-size: var(--t-16); }
  .day { display: flex; gap: var(--s-2) var(--s-5); flex-wrap: wrap; margin: 0; }
  .day div { display: grid; gap: 2px; }
  .day dd { margin: 0; font-size: var(--t-20); font-weight: 500; }
  .spot { display: flex; gap: var(--s-5); align-items: center; padding: var(--s-4) var(--s-5); text-decoration: none; color: inherit; flex-wrap: wrap;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease); }
  @media (hover: hover) { .spot:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  .s-t { display: grid; gap: 2px; min-width: 0; }
  .s-name { font-family: var(--f-display); font-size: clamp(24px, 2.2vw, 32px); line-height: 1.05; }
  .s-sym { color: var(--ink-2); font-size: var(--t-14); }
  .s-nums { display: flex; gap: var(--s-2) var(--s-6); flex-wrap: wrap; margin: 0 0 0 auto; }
  .s-nums div { display: grid; gap: 2px; }
  .s-nums dd { margin: 0; font-size: var(--t-20); font-weight: 500; }
  .s-go { font-size: var(--t-20); font-weight: 700; }
  .chipbtn { display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; padding: 0 var(--s-4); border: 0; border-radius: var(--r-full);
    background: var(--paper-3); color: var(--ink-2); font: inherit; font-weight: 700; font-size: var(--t-14); cursor: pointer;
    transition: background-color var(--d-fn) var(--ease), color var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease); }
  .chipbtn[aria-pressed='true'] { background: var(--paper-2); color: var(--ink); box-shadow: var(--sh-2); }
  @media (hover: hover) { .chipbtn:hover:not([aria-pressed='true']) { background: var(--hover); color: var(--ink); } }
  .key { display: inline-block; width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }
  .controls { display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center; }
  .ctl { display: flex; align-items: center; gap: var(--s-2); position: relative; }
  .sel {
    width: 180px; min-height: 44px; padding: 0 var(--s-6) 0 var(--s-3);
    appearance: none; border: 0; background: var(--paper-3); border-radius: var(--r-md); font-weight: 700; cursor: pointer;
  }
  .ctl::after { content: '\25BE'; position: absolute; right: var(--s-3); pointer-events: none; color: var(--ink-2); }
  .search { width: 220px; min-height: 44px; order: 3; }
  .view { margin-left: auto; order: 4; }
  .live { font-size: var(--t-14); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(225px, 1fr)); gap: var(--s-4); }
  .grid > .cardcell { min-width: 0; display: grid; }
  .grid :global(.card) { max-width: 440px; width: 100%; }
  .launch { display: grid; gap: var(--s-3); align-content: center; justify-items: start; text-decoration: none; color: inherit; box-shadow: inset 0 0 0 2px var(--line); background: transparent; min-height: 220px; padding: var(--s-5); border-radius: var(--r-md); transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease); }
  @media (hover: hover) { .launch:hover { transform: translateY(-2px); box-shadow: inset 0 0 0 2px var(--ink-3); } .launch:hover :global(.btn) { transform: none; box-shadow: var(--sh-2); } }
  .launch:active { transform: translateY(1px); transition-duration: var(--d-press); }
  .card-sk { height: 360px; border-radius: var(--r-md); }
  .list { display: grid; }
  .lhead { display: grid; grid-template-columns: minmax(0, 2.2fr) 1.1fr 1fr .7fr .7fr 1.3fr .6fr .7fr; gap: var(--s-4); padding: 0 var(--s-3) var(--s-2); }
  .num { text-align: right; }
  .fail, .none { display: grid; gap: var(--s-3); justify-items: start; padding: var(--s-4) 0; }
  .empty { display: grid; gap: var(--s-4); justify-items: center; align-content: center; min-height: 160px; text-align: center; font-size: var(--t-20); font-weight: 700; }
  @media (max-width: 800px) {
    .lhead { grid-template-columns: minmax(0, 2fr) 1fr 1.2fr; }
    .hide-md { display: none; }
  }
  @media (max-width: 640px) {
    .tabs { width: 100%; display: grid; grid-template-columns: repeat(4, 1fr); }
    .tabs button { padding: 0 var(--s-2); }
    .ctl { flex: 1 1 auto; }
    .sel { flex: 1; width: auto; }
    .view { margin-left: 0; order: 2; }
    .search { flex: 1 1 100%; width: auto; }
    .day dd { font-size: var(--t-16); }
    .grid { grid-template-columns: 1fr; gap: var(--s-3); }
    .grid :global(.card) { max-width: none; }
    .launch { min-height: 0; padding: var(--s-4); }
    .card-sk { height: 196px; }
  }
</style>
