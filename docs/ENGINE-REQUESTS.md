# Engine requests from the web revamp

The revamp is built to the data the engine serves today. Each item below is something the UI wants and cannot honestly show yet, so it shows a dash or leaves the feature out. Nothing here is a bug in the engine. Each entry says what to add, what it unlocks on the page, and what the page does until then.

Priority is by how much of the UI it unlocks per unit of engine work.

## 0. Candles and pool trades from the engine (highest priority)

**What the chart does today.** The coin chart (TradingView Lightweight Charts 5.2.1, Apache-2.0, attribution shown) reads candles, pool statistics and the pool's trades straight from GeckoTerminal's free public API in the visitor's browser. Checked 2026-10-31 on mainnet: it answers for a bonding-curve pool and for a graduated pool, prices them in ZEC (the pool's quote token), and allows any origin. The engine's own price history is only the trades browsers confirmed through the pad's buy box (up to 300 points), so it is used only as a labelled fallback.

**Why this should move into the engine.** The free tier allows about 30 reads a minute per address and its commercial-use terms were not confirmed. A company product should not depend on a third party's free tier for its main screen.

**Ask.** Index the pool swap events (the Meteora DBC `EvtSwap2` and the DAMM v2 swap) into the engine, aggregate 1-minute candles with volume in ZEC, derive 5m, 15m, 1h, 4h and 1d from them, and serve:
- `GET /coins/:mint/candles?tf=15m&before=<unix>` returning `[time, open, high, low, close, volumeZec]`, one source across the curve and the graduated pool;
- `GET /coins/:mint/pool-trades` with signature, time, side, wallet, ZEC and tokens;
- `GET /coins/:mint/pool-stats` with price change, volume, buys, sells, distinct buyers and sellers over 5m, 1h, 6h and 24h, liquidity and FDV.

A webhook provider such as Helius (about $49 a month on its developer plan, to be re-checked before budgeting) or a self-run RPC subscription can feed it. Dedupe on signature, expect retries, and backfill history once from the provider. The web client already isolates its source in `web/src/lib/candleSource.ts` and `web/src/lib/pool.ts`, so switching is a one-file change per reader.

## 1. Pot and holder aggregates on the list endpoint

**Ask.** Add to each coin in `GET /api/coins`: `holdersPotZats` (what the next round would pay this coin's holders), and the three holder aggregates `top10Pct`, `devPct`, `poolPct`.

**Unlocks.**
- The ledger's Supply and Next / holder columns without a request per visible row. Today `web/src/lib/desk.ts` makes three reads per row (holders with `limit=1`, pot, trades), four at a time, kept 60 s.
- A default catalog sort by pot over market cap, the yield-shaped sort traders actually want. It cannot be done in the browser without reading every coin's pot.

**Until then.** The ledger fills those cells lazily for the rows on screen and shows an en dash while loading. The default sort stays market cap.

## 2. Trade window metadata on `/trades` and `/coins/:mint/trades`

**Ask.** Return, beside the rows, `oldestRetainedAt` and `totalRetained` (or a `hasMore` flag) so the client knows whether it holds all of a coin's trades or the newest page of them.

**Unlocks.** Exact "covers N min" and "all 8 recorded trades" wording on the decision strip, the peek card and the compare shelf. The client now infers it from `rows.length < limit`.

**Until then.** Labels say "last 40 trades" or "all N recorded trades" from the row count only.

## 3. A cursor on the trades feed

**Ask.** `GET /trades?since=<sig>` returning only trades newer than that signature, plus a count when more than `limit` are newer.

**Unlocks.** The live tape's held-back ribbon can say "12 new" exactly. It now counts the signatures it has not seen among the newest `limit` rows and prints `30+` when the feed is full.

## 4. Per-round, per-coin splits and a receipts index

**Ask.**
- `GET /rounds` (or extend `/epochs`) with a per-coin split: for each round, each coin that paid, its holder total, its holder count and its transaction signatures.
- `GET /wallet/:address/payouts` with one row per payment: round, coin, amount, leg (Solana or shielded), signature. Shielded rows must keep the existing rule that no per-holder shielded amount is published, so this can return only the caller's own rows, proven with a signed message from the wallet the way the receipt claim already is.

**Unlocks.**
- A verified-yield column in the ledger and an income statement (with CSV) on the profile.
- Per-coin round strata and the sediment scrub on a coin's Rewards tab. The Payouts page already draws pad-wide strata from `/epochs`.
- Per-coin payout history and the "paid so far, n=" figure with real rounds behind it instead of the count alone.

**Until then.** Paid ZEC shows the coin's total with `n=` rounds from `rewards.epochs`. The Payouts strata are pad-wide.

## 5. A leaderboard endpoint

**Ask.** `GET /leaderboard?by=rounds_paid` returning wallets by number of rounds paid, with transaction links, for opted-in public wallets only.

**Unlocks.** A race board where every figure links a transaction, which is the part a competitor's board cannot offer.

**Until then.** No leaderboard. A board computed from the browser's own holdings would be noise.

## 6. Time series per coin

**Ask.** `GET /coins/:mint/series?window=24h` with holder count and price at fixed intervals. Today the chart serves up to 300 price points and nothing serves holder history.

**Unlocks.** A real "what changed" scrubber on the coin page, and a since-you-looked figure that can use server history instead of this browser's memory.

**Until then.** The since-you-looked fold and the return-to-row delta are this browser's own record and say so. A scrubber that replayed holders or rewards from 40 trades would be invented history, so it is not built.

## 7. Alerts that run without a tab

**Ask.** A subscription (web push or a webhook) for three events: a coin crossing a curve percentage, a payout inside a window for a held coin, a creator wallet selling.

**Unlocks.** The Bells row, which today fires only while the tab is open and says so.

## 8. Announcements

A dated page of product updates, each with its receipt, in the pad's voice. Content, not engine work: someone has to own writing them.

---

## 9. The keeper's address on the API

The round check reads the memo transaction from the chain, but no endpoint publishes the keeper's address, so the page cannot compare the transaction's signer with it. Until then the page says only that a transaction at the listed signature carries the same hash. Ask: serve `keeperAddress` on `GET /treasury`. The check then also requires the memo transaction's fee payer to equal it, and the wording can say who wrote the memo.

## Behaviour changes worth a reviewer's eye

These touch shared code rather than adding files.

- `web/src/lib/router.svelte.ts`: a hash change that only alters the query (a sheet opening, a page number) no longer scrolls to the top. A different path still does.
- `web/src/components/HoldersTable.svelte` and `web/src/routes/Treasury.svelte`: paging now rewrites only its own query parameter through `lib/query.ts`, so a layer's `?sheet=` survives a page turn.
- `web/src/App.svelte`: the page body sits in one `display: contents` wrapper that is `inert` while a layer is open. The palette and layers sit outside it.
- `web/src/components/room/Palette.svelte`: Escape stops propagating so it does not also close a layer. The palette also reads `snarks holders`, `> compare` and Shift+Enter.
- `web/src/lib/mock/index.ts`: the mock memoizes key derivation. Opening the compare shelf with three coins went from 13.8 s to 0.6 s because `api.coin` derived dozens of key pairs per call.
- `web/src/routes/Coin.svelte`: the stats row wraps by width instead of five fixed columns, and its values no longer break across lines.
- Earlier work on this branch removed duplicated copy from the How page. That text is the owner's, so it needs the owner's yes at review.
- `web/src/components/VerifyRound.svelte` and `web/src/lib/memoCheck.ts`: the round check now also reads the Solana memo from the chain through the site's RPC (`VITE_RPC`) and compares it with `snarks-pad snapshot <epoch> sha256:<hash>`, the text `engine/src/epoch/snapshotFile.ts` writes. Without a mainnet `VITE_RPC` the check reports that the memo could not be read, never a mismatch.
- `web/src/lib/chartSource.ts`: one switch for the third-party pool provider. Building with `VITE_CHART_SOURCE=recorded` keeps visitors' browsers off GeckoTerminal and shows the pad's recorded trades, labelled.
- `web/package.json`: `canvas-confetti` (ISC, about 4 KB, loaded on first use) for the graduation cheer; `lightweight-charts` (Apache-2.0) for the coin chart.
