<script lang="ts">
  import { api, ApiError, onMode } from '../lib/api'
  import type { Coin, Epoch, PadMode, PadPot, Stats, Treasury } from '../lib/types'
  import type { CoinQuery } from '../lib/coins'
  import { filterCoins, sortCoins } from '../lib/coins'
  import { zec, usdOfZats } from '../lib/format'
  import type { FeedState } from '../lib/tape'
  import { zecUsd } from '../lib/usd.svelte'
  import { poll } from '../lib/poll'
  import { reducedMotion } from '../lib/motion'
  import { wallet } from '../lib/wallet.svelte'
  import { readHoldings } from '../lib/holdings'
  import type { Holding } from '../lib/profile'
  import FillBar from '../components/FillBar.svelte'
  import Lamp from '../components/room/Lamp.svelte'
  import Odometer from '../components/room/Odometer.svelte'
  import Spindle from '../components/room/Spindle.svelte'
  import PulseBoard from '../components/PulseBoard.svelte'
  import NextPayout from '../components/NextPayout.svelte'
  import TradesTape from '../components/TradesTape.svelte'

  // The Pad: the door, one screen. The till, the pot and the clock on the money rail; the market as
  // shelves; the proof pile and the live tape. The catalog is its own page now (#/coins); the door
  // sends people there. Everything refreshes every 10 s while the tab is visible.
  const POLL_MS = 10_000
  const TAPE_ROWS = 8 // eight 44px rows sit level with the three lanes beside them at 1440
  // the pulse board's three lanes: newest first, nearest graduation first, biggest graduated first
  const LANE_N = 3
  const FRESH: CoinQuery = { sort: 'new', limit: LANE_N, offset: 0 }
  const FILLING: CoinQuery = { sort: 'progress', stage: 'curve', limit: LANE_N, offset: 0 }
  const GRADUATED: CoinQuery = { sort: 'mcap', stage: 'graduated', limit: LANE_N, offset: 0 }
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))
  let tapeState = $state<FeedState>('loading')

  let laneFresh = $state<Coin[] | null>(null)
  let laneFilling = $state<Coin[] | null>(null)
  let laneGraduated = $state<Coin[] | null>(null)
  let stats = $state<Stats | null>(null)
  let treasury = $state<Treasury | null>(null)
  let epochs = $state<Epoch[] | null>(null)
  let padPot = $state<PadPot | null>(null) // GET /pot (v2.10): what every listed coin has accrued for the next round; null = not known, shown as a dash
  let err = $state<string | null>(null)
  let pollErr = $state(false)
  let now = $state(Date.now())
  let reqId = 0

  /** A v2.4 engine returns every coin unsliced; the lanes slice here. */
  function laneOf(r: { coins: Coin[]; total?: number }, query: CoinQuery): Coin[] {
    if (r.total !== undefined) return r.coins
    const all = sortCoins(filterCoins(r.coins, query), query.sort ?? 'mcap')
    return all.slice(0, query.limit ?? all.length)
  }
  async function load() {
    const id = ++reqId
    try {
      const [f, n, g] = await Promise.all([api.coins(FRESH), api.coins(FILLING), api.coins(GRADUATED)])
      if (id !== reqId) return // a newer request is in flight
      laneFresh = laneOf(f, FRESH)
      laneFilling = laneOf(n, FILLING)
      laneGraduated = laneOf(g, GRADUATED)
      err = null; pollErr = false
    } catch (e) {
      if (id !== reqId) return
      if (laneFresh) pollErr = true
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

  const failed = $derived(!!err && laneFresh === null)
  const nCoins = $derived(stats?.coins ?? null)
  const nGrad = $derived(stats?.graduated ?? null)
  const vol = $derived(stats?.volume24hZats !== undefined ? zec(stats.volume24hZats, 2) : null)
  const paidSol = $derived(stats?.paidSolanaZats !== undefined ? BigInt(stats.paidSolanaZats) : epochs ? epochs.reduce((a, e) => a + BigInt(e.solanaPayouts.totalZats), 0n) : null)
  const paidShd = $derived(stats?.paidShieldedZats !== undefined ? BigInt(stats.paidShieldedZats) : epochs ? epochs.reduce((a, e) => a + BigInt(e.shielded.totalZats), 0n) : null)
  const paidAll = $derived(paidSol !== null && paidShd !== null ? paidSol + paidShd : null)
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
  // Payout as an event: a round landing while the page is open drops its slip onto the spindle (the
  // slip's own entrance), and the connected wallet is checked against the new round's payouts. The
  // "you were paid" line appears only when the engine lists this wallet in that round: never a guess.
  let seenRound: string | null = null
  let youWerePaid = $state<string | null>(null)
  $effect(() => {
    const id = lastPaid?.id ?? null
    if (id === null) return
    if (seenRound === null) { seenRound = id; return }
    if (id === seenRound) return
    seenRound = id
    youWerePaid = null
    const w = wallet.address
    if (!w) return
    api.rewards(w).then((r) => {
      const mine = r.solana.payouts.find((p) => p.epochId === id)
      if (mine && lastPaid?.id === id) youWerePaid = `You were paid ${zec(mine.zats, 6)} ZEC this round.`
    }, () => {})
  })
  // The scene's entrance plays once per session: the first arrival gets the drop and the till roll,
  // every later visit (navigating back, theme flips) finds the door already settled. "It replays
  // for no reason" is the bug this kills.
  const firstScene: boolean = (() => {
    try {
      if (sessionStorage.getItem('snarks-scene') === '1') return false
      sessionStorage.setItem('snarks-scene', '1')
      return true
    } catch { return true }
  })()
  // the return hook: a connected wallet sees its own bag above the market, read in the browser like the Holdings tab
  let bag = $state<Holding[] | null>(null)
  $effect(() => {
    const w = wallet.address
    bag = null
    if (!w) return
    readHoldings(w).then((r) => { if (wallet.address === w) bag = r }, () => {})
  })
  // the tape tags a row "dev" when its wallet created that coin; the creators are read off the lanes the door holds
  const creators = $derived(Object.fromEntries([...(laneFresh ?? []), ...(laneFilling ?? []), ...(laneGraduated ?? [])].map((c) => [c.mint, c.creator])))
</script>

<!-- The fridge door, drawn as a thing: one enamel panel the whole first screen is pinned to. The theme
     changes the room (the door, the light), never the paper: every slip and note inside .onpaper keeps
     its daylight ink, lit by the one lamp whose warmth is the real payout clock. On it: the headline in
     the house hand, the till rolled up on a taped note, the pile of real round receipts, and the pot
     note filling toward the next round. -->
<!-- SNARKS 2: the door is the workstation. One enamel panel fills the first screen; everything the
     pad does is pinned to it and working. Left, the money rail: the till note, the pot filling, the
     clock. Center, the market as shelves. Right, the proof pile and the live tape. The theme changes
     the room, never the paper (.onpaper); the catalog with its controls scrolls below the door. -->
<section class="wrap doorwrap">
  <div class="door">
    <Lamp lastAt={treasury?.lastEpochAt ?? null} nextAt={treasury?.nextEpochAt ?? null} {now} />
    <header class="d-head">
      <h1 class="display">Coins on Meteora that pay holders in ZEC, <em>shielded</em> if you opt in.</h1>
      <p class="lede">Every trade pays its fee in ZEC; holders are paid from it each round, to their wallet or their Zcash shield.</p>
    </header>

    <aside class="d-money">
      {#if paidAll !== null && paidAll > 0n}
        <a class="meter note onpaper" href="#/treasury">
          <span class="tape nt1" aria-hidden="true"></span>
          <span class="label">Paid to holders so far</span>
          <span class="m-big"><Odometer text={zec(paidAll)} delay={450} roll={firstScene} /><span class="m-unit">ZEC</span></span>
          <span class="m-sub">
            {#if usdOfZats(paidAll, zecUsd.rate)}<span class="mono">{usdOfZats(paidAll, zecUsd.rate)}</span><span class="dot" aria-hidden="true">&middot;</span>{/if}
            {#if nPayments !== null}<span><span class="mono">{nPayments.toLocaleString('en-US')}</span> payments</span>{/if}
          </span>
          <span class="m-sub m-shd"><span class="key hatch" aria-hidden="true"></span><span class="mono">{zec(paidShd ?? 0n)} ZEC</span>&nbsp;of it shielded</span>
        </a>
      {:else if paidAll === 0n}
        <p class="muted onpaper note">No round has paid yet. The first payout lands after the first round closes.</p>
      {/if}
      {#if stripClock}
        <div class="pot note onpaper">
          <span class="tape nt2" aria-hidden="true"></span>
          <p class="label">In the pot for the next round</p>
          <p class="pot-line"><span class="mono pot-big">{padPot ? `${zec(padPot.accruedZats)} ZEC` : '–'}</span>{#if padPot && usdOfZats(padPot.accruedZats, zecUsd.rate)}<span class="pot-usd">{usdOfZats(padPot.accruedZats, zecUsd.rate)}</span>{/if}</p>
          <FillBar fromIso={treasury?.lastEpochAt ?? null} toIso={treasury?.nextEpochAt ?? null} {now} />
          <p class="pot-clock">{#if treasury}<NextPayout at={treasury.nextEpochAt} {now} everyMs={treasury.cadence?.roundEveryMs ?? null} />{:else}<span class="mono">–</span>{/if}</p>
        </div>
      {/if}
      <div class="actions">
        <a class="btn primary" href="#/coins">See every coin</a>
        <a class="btn shd" href="#/shielded"><span class="key hatch" aria-hidden="true"></span>Get my rewards shielded</a>
      </div>
      <!-- the pad's day, the rail's third note; the catalog below no longer repeats it -->
      {#if nCoins !== null || vol !== null}
        <dl class="today note onpaper" aria-label="The pad today">
          <span class="tape nt1" aria-hidden="true"></span>
          <div><dt class="label">Coins</dt><dd class="mono">{nCoins ?? '–'}</dd></div>
          <div><dt class="label">Graduated</dt><dd class="mono">{nGrad ?? '–'}</dd></div>
          <div><dt class="label">24h volume</dt><dd class="mono">{vol === null ? '–' : `${vol} ZEC`}</dd></div>
        </dl>
      {/if}
    </aside>

    <div class="d-shelves">
      <h2 class="d-shelf-h" id="pulse-h">On the pad right now</h2>
      {#if pollErr}<p class="live error" role="alert">Lost the connection to the pad. Trying again every {POLL_MS / 1000}s.</p>{/if}
      {#if failed && laneFresh === null}
        <p class="muted">Not loaded.</p>
      {:else}
        <PulseBoard fresh={laneFresh} filling={laneFilling} graduated={laneGraduated} {now} />
      {/if}
    </div>

    <aside class="d-proof">
      <div class="art onpaper"><Spindle {epochs} {now} {newSince} paidLine={youWerePaid} animate={firstScene} /></div>
      <section class="d-tape" aria-labelledby="tape-h" hidden={tapeState === 'absent'}>
        <h2 class="d-shelf-h" id="tape-h">Live trades</h2>
        <TradesTape compact limit={TAPE_ROWS} everyMs={POLL_MS} {creators} {mode} {now} onstate={(s) => (tapeState = s)} />
      </section>
    </aside>
  </div>
</section>

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

<!-- the pulse shelves and the live tape live on the door above; the catalog starts here -->

<!-- the catalog lives at #/coins; the door stays one screen -->

<style>
  /* ---- the door: one enamel panel, the workstation the first screen is pinned to ---- */
  .doorwrap { padding-top: var(--s-4); }
  /* the surface comes from app.css .door; this page lays its workstation grid on it */
  .door {
    display: grid; gap: var(--s-5) var(--s-6);
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr) minmax(320px, 400px);
    grid-template-areas: 'head head proof' 'money shelves proof';
    grid-template-rows: auto 1fr;
    align-items: start;
    min-height: min(78vh, 860px);
    padding: clamp(20px, 3vw, 44px);
  }
  .d-head { grid-area: head; display: grid; gap: var(--s-2); max-width: 70ch; }
  .d-head .display { font-size: clamp(26px, 2.4vw, 36px); }
  .lede { font-size: var(--t-16); line-height: 1.45; color: var(--ink-2); max-width: 60ch; }
  .d-money { grid-area: money; display: grid; gap: var(--s-5); align-content: start; }
  .d-shelves { grid-area: shelves; display: grid; gap: var(--s-3); align-content: start; min-width: 0; }
  .d-proof { grid-area: proof; display: grid; gap: var(--s-5); align-content: start; min-width: 0; }
  .d-shelf-h { font-family: var(--f-display); font-size: var(--t-20); }
  .d-tape[hidden] { display: none; }
  .d-tape { display: grid; gap: var(--s-2); }
  .live { font-size: var(--t-14); }
  .actions { display: flex; gap: var(--s-3); flex-wrap: wrap; }
  .shd { white-space: nowrap; }
  /* room above the pile for the whole of the mascot's head */
  .art { display: grid; justify-items: center; padding-top: 84px; }
  .key { display: inline-block; width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }

  /* the till and the pot wear the shared .note (app.css); only their tilts live here */
  .meter { transform: rotate(-.8deg); }
  .pot { transform: rotate(.6deg); width: 100%; }
  .m-big { display: flex; align-items: baseline; gap: 0.16em; font-size: clamp(40px, 3.4vw, 58px); font-weight: 500; line-height: 1; letter-spacing: -0.01em; }
  .m-unit { font-family: var(--f-mono); font-size: 0.42em; color: var(--ink-2); }
  .m-sub { display: flex; align-items: baseline; gap: var(--s-2); flex-wrap: wrap; font-size: var(--t-14); color: var(--ink-2); }
  .m-sub .mono { color: var(--ink); }
  .m-sub .dot { color: var(--ink-3); }
  .m-shd { display: inline-flex; align-items: center; gap: var(--s-1); }
  @media (hover: hover) { .meter:hover .m-big { color: var(--pink); transition: color var(--d-fn) var(--ease); } }
  .pot-line { display: flex; align-items: baseline; gap: var(--s-2); flex-wrap: wrap; }
  .pot-big { font-size: clamp(24px, 2vw, 30px); font-weight: 500; line-height: 1.1; }
  .pot-usd { font-size: var(--t-14); color: var(--ink-3); }
  .pot-clock { font-size: var(--t-16); font-weight: 700; }
  .pot-clock :global(.mono) { font-size: var(--t-20); font-weight: 500; }
  .r-go { margin-left: auto; font-weight: 700; font-size: var(--t-14); }
  .r-go::after { content: ' \2192'; }
  .bagline {
    display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-6); align-items: baseline;
    margin-top: var(--s-4); padding: var(--s-3) var(--s-5);
    text-decoration: none; color: inherit;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .bagline:hover { transform: translateY(-2px); box-shadow: var(--sh-3); } }
  /* the rail's third note: the pad's day in three figures */
  .today { display: flex; gap: var(--s-2) var(--s-5); flex-wrap: wrap; margin: 0; transform: rotate(-.4deg); width: 100%; }
  .today div { display: grid; gap: 2px; }
  .today dd { margin: 0; font-size: var(--t-20); font-weight: 500; }

  /* the door folds in two steps: the proof column drops under the shelves first, then everything stacks */
  @media (max-width: 1240px) {
    .door { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); grid-template-areas: 'head head' 'money shelves' 'money proof'; min-height: 0; }
    .d-proof { grid-template-columns: minmax(0, 420px) minmax(0, 1fr); display: grid; gap: var(--s-5); align-items: start; }
  }
  @media (max-width: 900px) {
    /* one column, the proof on the first screen: the head, the till, the pile, then the pot, the
       actions, the day note, the shelves and the tape. The rails dissolve so their pieces can order. */
    .door { display: flex; flex-direction: column; gap: var(--s-5); }
    .d-money, .d-proof { display: contents; }
    .d-head { order: 0; }
    .meter { order: 1; }
    .art { order: 2; }
    .pot { order: 3; }
    .actions { order: 4; }
    .today { order: 5; }
    .d-shelves { order: 6; }
    .d-tape { order: 7; }
    .art { justify-items: stretch; }
    .art :global(.pile) { width: 100%; }
  }
  @media (max-width: 640px) {
    .door { padding: var(--s-4); border-radius: 12px; }
    .d-head .display { font-size: 26px; }
    .lede { font-size: var(--t-16); line-height: 1.4; }
    .actions .btn { flex: 1 1 auto; }
    .m-big { font-size: clamp(38px, 11.5vw, 52px); }
    .meter { width: 100%; }
    .r-go { margin-left: 0; flex: 1 1 100%; }
    .today dd { font-size: var(--t-16); }
  }
</style>
