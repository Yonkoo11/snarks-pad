<script lang="ts">
  import { api, ApiError, onMode } from '../lib/api'
  import type { Coin, Epoch, PadMode, Stats, Treasury } from '../lib/types'
  import type { CoinQuery, CoinSort, CoinStage } from '../lib/coins'
  import { filterCoins, sortCoins, pinFirst, serverSort, FEATURED } from '../lib/coins'
  import { zec, pct, ago } from '../lib/format'
  import type { FeedState } from '../lib/tape'
  import { zecUsd } from '../lib/usd.svelte'
  import { poll } from '../lib/poll'
  import Taped from '../components/Taped.svelte'
  import CurveBar from '../components/CurveBar.svelte'
  import CoinImage from '../components/CoinImage.svelte'
  import CoinCard from '../components/CoinCard.svelte'
  import NextPayout from '../components/NextPayout.svelte'
  import TradesTape from '../components/TradesTape.svelte'

  // Explore: the market itself. A compact banner, then one band with the coins closest to graduation and the live trades
  // tape, then the stats row, the tabs, sort, search and the grid or list of every coin, with pages. Everything refreshes
  // every 10 s while the tab is visible; the tape also takes the engine's stream when it has one.
  const PAGE = 12
  const POLL_MS = 10_000
  const TAPE_ROWS = 5 // five 44px rows sit level with the strip beside them at 1440
  const NEAR: CoinQuery = { sort: 'progress', stage: 'curve', limit: 5, offset: 0 }
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

  let near = $state<Coin[] | null>(null)
  let coins = $state<Coin[] | null>(null)
  let total = $state(0)
  let fullList = $state<Coin[] | null>(null) // every coin, when the engine answered without paging (v2.4); null when it paged for us
  let stats = $state<Stats | null>(null)
  let treasury = $state<Treasury | null>(null)
  let epochs = $state<Epoch[] | null>(null)
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
      const [n, l] = await Promise.all([api.coins(NEAR), api.coins(query)])
      if (id !== reqId) return // a newer request is in flight
      near = pageOf(n, NEAR, false).coins
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
  async function loadSide() {
    const readStats = statsGone ? Promise.resolve(null) : api.stats().catch((e) => { if (e instanceof ApiError && e.status === 404) statsGone = true; return null })
    const [s, t, e] = await Promise.all([readStats, api.treasury().catch(() => null), api.epochs().catch(() => null)])
    stats = s; treasury = t; epochs = e ? e.epochs : null
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
  // the tape tags a row "dev" when its wallet created that coin; the creators are read off the coins the page already holds
  const creators = $derived(Object.fromEntries([...(coins ?? []), ...(near ?? []), ...(fullList ?? [])].map((c) => [c.mint, c.creator])))
  // a board with fewer coins than a row holds offers the next slot to the visitor instead of an empty cell
  const offerLaunch = $derived(!!coins && coins.length > 0 && coins.length < 4 && !filtering && page === 1)
</script>

<!-- the Fridge door hero: the headline with air around it, the taped drawing big on the right, nothing behind it (the owner dropped the hatched shadow, 2026-10-07) -->
<section class="wrap hero">
  <div class="copy">
    <h1 class="display">Coins on Meteora that pay holders in ZEC, <em>shielded</em> if you opt in.</h1>
    <p class="lede">Every trade pays its fee in ZEC, and holders are paid from it each round. Opt in and your share arrives as native ZEC in your own Zcash wallet.</p>
    <div class="actions">
      <a class="btn shd" href="#/shielded"><span class="key hatch" aria-hidden="true"></span>Get my rewards shielded</a>
      <a class="btn ghost" href="#/how">How it works</a>
    </div>
  </div>
  <div class="art"><Taped settle /></div>
</section>

<div class="wrap band" class:with-tape={tapeState !== 'absent'}>
  <section class="strip" aria-labelledby="near-h">
    <div class="sec-head">
      <h2 class="h3" id="near-h">Closest to graduation</h2>
      {#if pollErr}<p class="live error">Lost the connection to the pad. Trying again every {POLL_MS / 1000}s.</p>
      {/if}
    </div>
    {#if near === null}
      {#if failed}<p class="muted">Not loaded.</p>
      {:else}<div class="near" aria-busy="true" aria-label="Loading the coins closest to graduation">{#each [0, 1, 2, 3] as i (i)}<div class="skel near-sk"></div>{/each}</div>{/if}
    {:else if near.length === 0}
      <p class="muted">No coin is on a curve right now.</p>
    {:else}
      <div class="near">
        {#each near as c (c.mint)}
          <a class="ncard panel" href="#/coin/{c.mint}">
            <CoinImage src={c.imageUrl} symbol={c.symbol} size={40} />
            <span class="nt"><strong class="name">{c.name}</strong><span class="mono sym">${c.symbol}</span></span>
            <span class="nb">{#if c.curveProgress === undefined}<span class="mono pc">–</span>{:else}<span class="bar"><CurveBar progress={c.curveProgress} stage={c.stage} compact /></span><span class="mono pc">{pct(c.curveProgress)}</span>{/if}</span>
            <span class="nm">Market cap <span class="mono">{c.marketCapZec === undefined ? '–' : `${zec(c.marketCapZec, 2)} ZEC`}</span></span>
            {#if c.curveRoomZats !== undefined}<span class="nm"><span class="mono">{zec(c.curveRoomZats, 2)} ZEC</span> to go</span>{/if}
          </a>
        {/each}
      </div>
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
      <div><dt class="label">Paid to holders so far</dt><dd class="mono">{paidAll === null ? '–' : paidAll === 0n ? 'None yet' : `${zec(paidAll)} ZEC`}</dd></div>
      {#if paidAll === 0n}
        <div><dt class="label">Next payout</dt><dd class="next">{#if treasury}<NextPayout at={treasury.nextEpochAt} {now} />{:else}<span class="mono">–</span>{/if}</dd></div>
      {:else}
        <div><dt class="label"><span class="key hatch" aria-hidden="true"></span>Of it shielded</dt><dd class="mono">{paidAll === null ? '–' : `${zec(paidShd ?? 0n)} ZEC`}</dd></div>
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

  /* one band: the strip, and beside it at 1100px and above the live tape (320px); the tape drops under the strip below that */
  .band { padding-top: var(--s-7); display: grid; gap: var(--s-5); align-items: start; }
  .band.with-tape { grid-template-columns: minmax(0, 1fr) 320px; }
  .strip { display: grid; gap: var(--s-3); min-width: 0; }
  .tape-sec { display: grid; gap: var(--s-3); min-width: 0; }
  .tape-sec[hidden] { display: none; }
  .sec-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s-4); flex-wrap: wrap; }
  .live { font-size: var(--t-14); }
  /* one to five cards close the row: each cell at least 180px (four across beside the tape), a card at most 320px wide */
  .near { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--s-3); }
  .ncard {
    display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: var(--s-2) var(--s-3); align-items: center; padding: var(--s-3); border-radius: var(--r-md); max-width: 320px;
    text-decoration: none; color: inherit; transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .ncard:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  .ncard:active { transform: translateY(1px); box-shadow: var(--sh-1); transition-duration: var(--d-press); }
  .nt { display: grid; min-width: 0; }
  /* a long name wraps to two lines, never gets cut */
  .name { font-size: var(--t-16); line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .sym { font-size: var(--t-14); color: var(--ink-2); }
  .nb { grid-column: 1 / -1; display: flex; align-items: center; gap: var(--s-3); }
  .nb .bar { flex: 1; min-width: 0; }
  .pc { font-size: var(--t-14); color: var(--ink-2); min-width: 4ch; text-align: right; }
  .nm { grid-column: 1 / -1; font-size: var(--t-14); color: var(--ink-2); }
  .nm .mono { color: var(--ink); }
  .near-sk { height: 112px; border-radius: var(--r-md); max-width: 320px; }

  .market { padding-top: var(--s-8); display: grid; gap: var(--s-4); }
  .controls { display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: center; }
  /* the tabs and the view toggle are the shared .seg control (app.css); only their layout lives here */
  .ctl { display: flex; align-items: center; gap: var(--s-2); }
  .sel { width: 180px; min-height: 44px; padding: 0 var(--s-3); }
  .search { width: 220px; min-height: 44px; order: 3; }
  .view { margin-left: auto; order: 4; }
  /* the stats row: label over number, as many tiles as the row holds */
  .stats { display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); margin: 0; }
  .stats dd { margin: var(--s-1) 0 0; font-size: var(--t-20); font-weight: 500; }
  .stats dd.next { font-size: var(--t-16); font-weight: 400; }
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
    .hero { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'title art' 'lede lede' 'actions actions'; gap: var(--s-4); padding-top: var(--s-4); padding-bottom: var(--s-3); }
    .copy { display: contents; }
    .copy > h1 { grid-area: title; align-self: center; }
    .lede { grid-area: lede; }
    .actions { grid-area: actions; }
    .art { grid-area: art; }
    .art :global(.taped) { width: 124px; padding: 6px; }
    .art :global(.tape) { width: 44px; height: 14px; top: -7px; }
    .band { padding-top: var(--s-6); }
    .market { padding-top: var(--s-7); }
  }
  @media (max-width: 1100px) {
    .band.with-tape { grid-template-columns: 1fr; }
    /* the strip scrolls inside its own box; the page never widens */
    .near { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: var(--s-1); }
    .ncard, .near-sk { flex: 0 0 220px; scroll-snap-align: start; }
  }
  @media (max-width: 800px) {
    .lhead { grid-template-columns: minmax(0, 2fr) 1fr 1.2fr; }
    .hide-md { display: none; }
  }
  @media (max-width: 640px) {
    .hero .display { font-size: 34px; }
    .lede { font-size: var(--t-16); line-height: 1.4; }
    .actions .btn { flex: 1 1 auto; }
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
