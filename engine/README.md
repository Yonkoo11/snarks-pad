# snarks-engine

The keeper + HTTP API for the snarks-launchpad ZEC launchpad: coins on Meteora's
Dynamic Bonding Curve (DBC) paired with Solana ZEC. The pool's trading fee is
paid in ZEC on every buy and sell; each epoch the keeper claims it (Meteora keeps
20%; the rest is split holders 75% / team 25%, see "Fee split and the team share") and pays holders either as Solana ZEC (default) or as
one batched shielded Zcash payout (opt-in). Implements API contract v2.1.
Every assumption the Meteora port makes, with its source line or the test that
proves it: **`PORT-ASSUMPTIONS.md`** (read it before changing a money path).

## Verified state

- `bun test`: **553** pass, 0 fail, run twice in a row (74 files, 549 s and 553 s, on the chain `bun run e2e` had just
  reset, with `PAD_DB_FILE` set to a private file because another session may share the checkout, and nothing else
  running on the machine). A run made while a web build, a browser check and two secret scanners shared the machine
  had 83 failures, all in suites that send transactions to the local validator (5 s timeouts, expired blockhashes):
  run the suite alone. Live suites run against a local validator that executes the MAINNET Meteora DBC, DAMM v2 and
  Squads v4 binaries; they skip when none is up. On a fresh clone with no chain and no built `zcash-devtool`:
  350 pass, 209 skip, 1 fail (`web/.npmrc` is git-ignored, so `supply-chain.test.ts` cannot read it there).
  `tsc --noEmit` is clean.
  Re-measured after the devnet faucet change (commit `454571d`, 2026-10-04): **593** pass, 0 fail (75 files, 637 s, one run,
  local chain up, private `PAD_DB_FILE`; the Mac was also doing unrelated work, which only made it slower). A fresh clone of
  that commit with no chain and no devtool: **388** pass, 212 skip, 0 fail (35.8 s); the one failure above is gone because
  `web/.npmrc` is tracked now. `web/qa/flow-check.cjs` 27 of 27.
  Re-measured for contract v2.6 (2026-10-04, one run, local chain up, private `PAD_DB_FILE`, nothing else running except one
  `tsc` of a few seconds): **832** pass, **1 fail**, 88 files, 646 s. The one failure is `test/copy.test.ts` (fee split copy):
  it looks for the phrase "holders get {coin.holderShareBps / 100}%" in `web/src/routes/Coin.svelte`, and the web commit
  `fa0b5d4` reworded that line. It is the web side's copy test to follow, and the engine does not touch it.
- `bun run e2e`: **142/142 checks PASS** (2026-10-04, 156 s including the chain restart) on a fresh chain (`E2E-RESULT.txt`): 3 epochs on a keypair-claimed coin (curve
  fees; the keeper migrates the full curve to DAMM v2 and claims; a DAMM v2 trade and the post-migration position fee
  claim), a 4th epoch for a coin whose fee claimer is a Squads vault (the keeper proposes and the run stops, the
  "owner" approves after reading the decoded receiver, the next run executes and pays), a 5th epoch for a coin on the
  4% creator-fee tier launched through the API builder (the pad claims only the partner part; the creator claims their
  own share), then the operations checks (the kill switch stops a run and `/treasury` says so; one keeper tick
  publishes the next due time; the snapshot verify script prints VERIFIED for each epoch). Shielded payouts land as
  Ironwood notes in each opted-in wallet's own regtest wallet. The last 42 checks (`scripts/e2e-trader.ts`) start a real API
  process and ask it every contract v2.6 route about these coins: each answer is compared with numbers read from the chain,
  the Meteora SDKs and the database (a quote equals what `trade-tx` builds on both pools; the pot equals the pool's own fee
  counter after two buys, to the zat; `fixed` equals the config, mint and DAMM v2 accounts and names the Squads multisig, 2 of 3;
  the holders listed are exactly the wallets that hold the coin on chain; a trade recorded by the e2e process reaches an open
  stream of the API process; the memo a holder's own Zcash wallet shows on a real shielded note is matched to its round, and a
  signed proof opens that wallet's own rows; `epochs.csv` equals `GET /epochs` cell by cell).
- Web: `npm run check` 0 errors, 0 warnings (125 files), `npm run build` ok, `web/qa/flow-check.cjs` all 27 checks PASS (against the mock;
  includes the pause banner and the devnet faucet button's three states).
- `scripts/build-devtool.sh` ran once into a scratch directory: built zcash-devtool at `5a26ee854e63...` in 5 min 10 s,
  `--locked`. Its sha256 (`05af3038...`) differs from the binary recorded in the earlier supply-chain review (`be18ec25...`,
  same size): builds are not bit-reproducible here, so pin the checksum of the binary you copy to the keeper.
- **Only the local environment has run.** Devnet and mainnet code paths compile (and the DBC/DAMM/Squads programs are
  the same binaries) but nothing in this build has talked to either network, and `config:create` and `squads:create`
  were run only against the local validator. Rent differs: mainnet and devnet charge 1,488,440 lamports for a token
  account, this local validator 2,039,280.

## Commands

```bash
bun install
bun run typecheck        # tsc --noEmit
bun test                 # unit + live tests (isolated sqlite at data/test.sqlite, wiped first)

bun run local:up         # idempotent: starts ONE solana-test-validator (mainnet DBC + DAMM v2 + Squads
                         # programs, DAMM v2 1% config, real ZEC mint, pool-authority PDA funded 1 SOL)
                         # + zcash regtest. On a fresh chain it also resets data/local.sqlite.
bun run seed             # creates the DBC config, launches SNARKS with a creator first buy, simulates buyers
bun run epoch            # one epoch: migrate if full -> claim fees -> pay (stops and says so if a claim awaits approval or payouts are paused)
bun run keeper           # the scheduler: epochs on their cadence, random holder samples, kill switch (see "The keeper loop" below)
bun run squads:create -- --owner <pubkey> --backup <pubkey>     # DRY RUN by default: the reviewed Squads multisig
bun run config:create -- --multisig <pda>                       # DRY RUN by default: the reviewed, PERMANENT DBC config (with its launch window)
scripts/devnet.sh bun scripts/config-simulate.ts                # asks the devnet DBC PROGRAM, in simulation only, to accept all five tier configs (nothing sent)
# scripts/review-configs.ts re-reads every config from the chain against src/dbc/reviewed.ts (read-only)
scripts/devnet.sh bun scripts/devnet-window-proof.ts   # against the DEPLOYED pad's API: a coin, a buy in the window and one after it, each fee read off the pool
scripts/devnet.sh bun scripts/devnet-window-cliff.ts   # the same API, plus a buy signed before the launch and sent straight behind it, to read the 99% step off devnet (built, not yet run: see FINDINGS D-3)
bash scripts/build-devtool.sh [dir]   # builds the pinned zcash-devtool locked and prints the sha256 to pin
bun run api              # HTTP API on :8787
bun run e2e              # kills the validator, up -> seed -> 4 epochs incl. migration and a Squads-vault claim
bun scripts/qa-local.ts fund <pubkey> | zwallet <name> | zbalance <name> | solbalance <pubkey>
                         # local-only helpers for web/qa/real-flow.cjs (refuses outside PAD_MODE=local)
```

Web against this API: `cd ../web && node qa/real-flow.cjs` (needs `bun run api`
running on a seeded stack); result in `web/qa/REAL-FLOW-RESULT.txt`.

All state lives under `engine/data/` and `engine/keys/` (gitignored). Delete both
to start over. `bun run local:up` is safe to run repeatedly.

### Configuration (env)

| Variable | Meaning |
|---|---|
| `PAD_MODE` | `local` (default) / `devnet` / `mainnet`. Selects RPC, quote mint, Zcash network |
| `DBC_CONFIG_ID` | an already-created DBC config |
| `FEE_CLAIMER_PUBKEY` | the fee claimer a NEW config is created with / verified against; default is the keeper key (custody Option A). Set to the Squads vault for Option B |
| `SQUADS_MULTISIG` | the Squads v4 multisig whose vault 0 is the fee claimer of Option-B configs; the keeper must be a member with Initiate+Vote+Execute and the threshold at least 2 |
| `KEEPER_KEYPAIR_PATH` | keeper key file (only the keeper-side scripts read it; the HTTP API never does) |
| `PAD_CLAIM_COMMITMENT` | `confirmed` locally, `finalized` on devnet/mainnet: how final a claim must be before its ZEC counts as owed |
| `PAD_NEW_ACCOUNT_MIN_ZATS` (30,000) | a Solana-ZEC payout to a wallet with no ZEC account is sent only above this, else carried (rent ~0.0015 SOL on mainnet, 0.0020 locally) |
| `PAD_SHIELDED_MIN_PER_HOLDER_ZATS` (100,000) | an opted-in holder's share is held until it reaches this (Zcash fee 5,000 per output) |
| `PAD_SHIELDED_MIN_SWAP_ZATS` (1,000,000) | the 1Click swap runs only when the sendable shielded total reaches this (withdrawFee 32,000 zats) |
| `PAD_SWAP_MIN_ZATS` (1,000,000) / `PAD_SWAP_MAX_ZATS` (50,000,000) | the swap adapter's own floor and per-swap cap. The planner sends up to the cap (less the team's delivery reserve) pro rata and carries the rest; a swap the adapter still refuses carries every share to the next shielded round (audit S6, product decision 2). Nothing opted in is ever paid on the public rail for a price, a cap or a provider |
| `PAD_SWAP_MAX_LOSS_BPS` (300) | a quote whose `minAmountOut` is below the deposit by more than the withdraw fee (`PAD_1CLICK_WITHDRAW_FEE_ZATS`, 32,000) plus this is refused before signing; the shares then carry. Alerts: `swap_refused` on every refusal or refund, `shielded_carried_rounds` after three carried shielded rounds in a row |
| `PAD_ORPHAN_RELEASE_DAYS` (30) | a coin nobody held through its window is not claimed; fees already held for such a coin (`coin_orphaned_zats`) join the next paying round after this many days, a quarter to the team and the rest pro rata to that round's paid holders, recorded under the coin's mint (audit S6, product decision 1) |
| `LAUNCHPAD_SIGNER_PATH` (engine/keys/launchpad-signer-<mode>.json, made in local mode) | the pad's launch signer: a read-only signer every launch carries so trading terminals attribute it to the pad (ops/keys-setup.sh <instance> signer); absent outside local mode, launches are built without it and the API warns at startup |
| `PAD_API_CHAIN_ROUTE_CEILING_PER_HOUR` (3,000) | the API's chain routes together make at most this many chain reads an hour, then answer 503 (alert `api_chain_ceiling`); database views keep serving (audit S6, product decision 5) |
| `PAD_SWAP_POLL_WINDOW_MS` (150,000) | how long one `status()` call keeps polling 1Click before returning pending (keep well under `EPOCH_LOCK_STALE_MS`) |
| `PAD_SWAP_TREASURY_MIN_CONFS` (10) | Zcash confirmations the delivered note needs before the epoch counts it as settled |
| `PAD_1CLICK_SUBMIT_DEPOSIT` (off) | tell 1Click the deposit hash right after it confirms (optional; its speed effect is not measured) |
| `NEAR1CLICK_API_KEY` (unset) | optional partner key, sent as `X-API-Key`; never logged |
| `TREASURY_ZCASH_ADDRESS`, `TREASURY_WALLET_DIR` | mainnet: the treasury u1 and the zcash-devtool wallet directory that owns it. `scripts/epoch.ts` refuses to start unless the wallet lists that address; the settled amount is read from that wallet |
| `TREASURY_IDENTITY_FILE` | mainnet/devnet: path to the age identity of the wallet in `TREASURY_WALLET_DIR`. The shielded leg pays from that wallet and refuses to send without both (audit S2-05) |
| `DBC_FEE_BPS`, `DBC_INITIAL_MCAP_ZEC`, `DBC_MIGRATION_MCAP_ZEC` | experiments only: with `PAD_MODE=mainnet` the engine **refuses to load** if any is set (a config made with a changed value is permanent; CONFIG-REVIEW S1-L2). The reviewed values live in `src/dbc/reviewed.ts` |
| `PAYOUTS_PAUSED` | `1` = the kill switch: nothing claims, swaps or sends (also the file `engine/data/PAUSED`, or `PAD_PAUSE_FILE`; no restart needed). `GET /treasury` says `paused: true` |
| `PAD_EPOCH_EVERY_HOURS` (48) / `PAD_SHIELDED_EVERY_DAYS` (7) | the keeper's cadence: an epoch (Solana ZEC payouts) every 2 days, the shielded leg only when the last shielded epoch is a week old |
| `PAD_FIRST_EPOCH_AT` (unset) | ISO time the first epoch is due; default is one cadence after the keeper first started |
| `PAD_KEEPER_TICK_MS` (60,000) / `PAD_RESUME_EVERY_MS` (900,000) | how often the loop wakes, and the minimum gap between two runs (so a draft waiting for an approval is not hammered) |
| `PAD_KEEPER_HEALTH_LOG` | where the keeper writes its one-JSON-line-per-event health log (default `engine/data/keeper-health.log`) |
| `PAD_SNAPSHOT_COUNT` (6) | random holder samples per epoch window |
| `PAD_SNAPSHOT_MIN_SAMPLES` (3 on mainnet; 0 locally and on devnet) | a coin is claimed only when its window holds at least this many samples. 0 = with no samples the claim-time sample alone decides (the devnet judge flow: trade, then run an epoch, on test money) |
| `PAD_STUCK_MAX_ATTEMPTS` (24) / `PAD_STUCK_MAX_AGE_MS` (24 h) | an epoch still unfinished after this many runs or this long is parked |
| `PAD_TREASURY_VIEW_MAX_AGE_MS` (30,000) / `PAD_COIN_VIEW_MAX_AGE_MS` (3,000) | how old the treasury balance and the pool state served by `GET /treasury` and `GET /coins*` may be. Payouts never use these numbers |
| `PAD_COIN_STATS_MAX_AGE_MS` (5,000) | how old the 24-hour volume, trade count and price change, the paid totals of `GET /stats` and each coin's `rewards` sums may be (one pass over the database per window, not per request; stress API load, v2.5). Payouts never use these numbers |
| `PAD_QUOTE_MAX_AGE_MS` (2,000) / `PAD_POT_MAX_AGE_MS` (10,000) / `PAD_FIXED_MAX_AGE_MS` (30,000) / `PAD_POOL_VAULT_MAX_AGE_MS` (30,000) | how old the pool snapshot behind `GET /coins/:mint/quote`, the fee counters behind `pot`, the chain facts behind `fixed` and the pool vault balances behind `holders` may be (one chain read per window per coin, shared by every request; contract v2.6). Payouts never use these numbers |
| `PAD_FAUCET_SOL` (0.02) / `PAD_FAUCET_MIN_RESERVE_SOL` (0.01) | devnet faucet, in SOL: what one fill pays out of the faucet key's own balance, and what the key must still hold after it (a token account's rent, three fees, a margin). Plain decimals 0.003..1; anything else stops startup (audit S3-03). `GET /treasury` `faucet` says how many fills are left; the keeper alerts below 10 |
| `PUBLIC_DIR` (`engine/data/public`) / `PUBLIC_BASE_URL` (`http://127.0.0.1:<PAD_API_PORT>`) | where coin pictures (`i/`) and metadata JSON (`m/`) are written, and the origin every file address starts with (an http(s) origin, no path, at most 100 characters). The origin is written on chain in each coin's metadata `uri` for good: **mainnet refuses to start without an https `PUBLIC_BASE_URL`**; devnet starts and warns. On a server `ops/remote-setup.sh` fills both, and Caddy serves the directory as static files (contract v2.7) |
| `PAD_STRESS_SHIELDED_PER_TX` (unset) | local mode only: recipients per Ironwood chunk, for the stress harness (`engine/stress/`); ignored on real networks (350) |
| `ZCASH_DEVTOOL_SHA256` | sha256 of the zcash-devtool binary; when set, every use of the binary first checks it. Outside local mode an unset value only warns |

## What is real vs simulated, per mode

| Piece | local | devnet | mainnet |
|---|---|---|---|
| Meteora DBC + DAMM v2 + Squads | **real mainnet binaries**, cloned into a local validator (`scripts/local-up.ts`) | real devnet programs, stand-in 8-decimal ZEC quote mint | real |
| Fee claims, migration, DAMM v2 position claims | **real** instructions on those binaries | real | real |
| Solana ZEC payouts | **real** SPL transfers on the local validator | real | real |
| Zcash treasury + payouts | **real** zebrad/zainod/zcash-devtool regtest chain, Ironwood pool; genuinely shielded, genuinely batched | not wired (`src/zcash/regtest.ts` is local-only) | not wired |
| NEAR 1Click swap (Solana ZEC -> native ZEC) | **simulated**: burns the Solana ZEC, pays the regtest treasury from a regtest funding wallet (25 bps + 32,000 zats) | not used | **real adapter written and tested against a fake 1Click on the local validator; never yet run with real funds** (`bun run swap:live-check`) |
| Faucet (`POST /faucet`) | not exposed (scripts fund wallets) | devnet only, own test-only key | does not exist |

**The real NEAR 1Click leg** is `src/swap/near1click.ts` (state machine),
`near1click-api.ts` (HTTP client, quote signature, quote checks) and
`near1click-chain.ts` (the Solana deposit). It is tested against the local
validator with a fake 1Click server (`test/near1click-state.test.ts`, a crash
after every durable step, every 1Click status, refusals), and its request shape
and signature check are tested against the real swap of 2026-09-30
(`test/near1click-api.test.ts`). It has NOT yet moved real funds through this
code. One real swap is `bun run swap:live-check -- --amount <zats>` (a dry run
unless given `--i-understand-this-moves-real-money`); every claim the adapter
relies on is in PORT-ASSUMPTIONS.md 6b and 6c.

**Live runs go through nohup and a log file.** An orchestrator's tool call dies after
about 10 minutes and takes the script with it (the P3 run was killed mid-poll that way).
Start it detached and poll the log; a rerun with the same `--key` resumes and never
deposits twice:

```bash
nohup bun scripts/swap-live-check.ts --amount 150000 --i-understand-this-moves-real-money > run.log 2>&1 &
tail -f run.log
```

A killed run can leave the `epoch` lock behind for up to 40 minutes ("another epoch run
holds the lock"). If the holder pid in `locks` is dead and no engine process runs, delete that one row.

## Fee flow and custody

1. A trade on the DBC curve pays a flat 1% fee in ZEC; after migration the DAMM v2 pool
   charges 1% rising to about 1.2% when trading is volatile (CONFIG-REVIEW S1-M1: the dynamic
   fee of DAMM config `Hv8Lmzm...`). Meteora keeps 20%; 80% accrues for the config's `fee_claimer`. The keeper splits what it claims 75% / 25% between holders and the team (below).
2. Each epoch, per coin: if the curve is full the keeper sends the permissionless
   migration (`src/dbc/migrate.ts`), then claims what accrued: the DBC partner
   trading fee, the DAMM v2 position fee, and the partner surplus (only when it
   is above zero; it is ~0 with this curve). The ZEC lands in the keeper's Solana
   ZEC account; **each claim's amount is the change in that account inside the
   claim transaction itself**, never a before/after poll.
3. Holders are snapshotted and the amount split pro rata (`epoch/math.ts`), then paid.

**Who signs a claim is the config's `fee_claimer`, which is permanent per config**
(`src/dbc/claim.ts` `FeeClaimer`):
- **Option A, local keypair:** the keeper key. The claim is signed, persisted, then broadcast.
- **Option B, Squads v4 vault (`src/dbc/squads.ts`):** the keeper proposes a vault
  transaction wrapping the claim and votes; the owner's wallet approves (threshold 2);
  the keeper executes. A run that finds the proposal unapproved stops and says so
  (`epoch waiting`); nothing is finalized, paid or discarded until the claim lands,
  and the next run resumes. The keeper alone can never claim. Before executing, the
  keeper re-reads the stored message and refuses unless it is exactly what it
  proposed; finished proposals are closed so their rent (about 0.0062 SOL) returns to the
  multisig's rent collector, **which should be the keeper** (set at multisig creation).
  The owner reads who gets paid with `describeProposal` / `listActiveProposals`
  (decoded from the STORED message, not the keeper's intention).
- A coin's claimer follows its own config, so coins on an older config keep their old claimer.

## Fee split and the team share

Of each trade's 1% fee Meteora keeps 20%; the pad claims the other 80% and splits **what it claimed**
(`src/epoch/split.ts`, one place, pure integer arithmetic): holders 75% (0.60% of volume), team 25% (0.20%).
`team = floor(claimed x 2500 / 10000)`, holders get the remainder, so holders + team == claimed to the zat
(`test/team-split.test.ts` runs 20,000 random claims, u64 extremes and a split followed by the real pro-rata
rounding). The split is applied per coin when its claim lands (`claimOneCoin`) and stored with the harvest, so a
resume never re-splits. A coin with nobody eligible holds the WHOLE amount, with no team cut taken, until it has holders.

**The delivery-cost rule** (the team share pays for shielded delivery first, up to its size; rule 3 says what happens beyond it):

1. At planning the team **reserves** `min(team share of this epoch, 32,000 withdraw fee + 5,000 x (recipients + transactions) Zcash fee (one change output per Ironwood transaction of at most 350 recipients)
   + 1% of the shielded total)`. The reserve is swapped in the SAME 1Click swap as the holders' shielded total.
2. When the swap settles, shielded holders are paid exactly what was planned if the settled output minus the Zcash fee
   covers it. What is left of the reserve stays in the treasury wallet as the team's native ZEC (`teamNativeZats`).
3. If the cost is bigger than the reserve (the team share was smaller than the cost, or the swap was worse than 1%),
   **the team pays everything it has and the shielded holders bear the excess pro rata** (`holderShortfallZats`).
   The team never goes negative and nothing is carried as a deficit into a later epoch, so one bad swap cannot leave a
   debt that a later epoch's holders silently pay. This is the senior answer over "carry the deficit": it needs no
   cross-epoch state and every epoch's ledger closes by itself.
4. If the swap does not happen (it failed before funds moved, or 1Click refunded it) the reserve was never spent and the
   team's whole share is Solana ZEC.

Ledger, per epoch (`epochs` table, written once, never rewritten): `teamGrossZats`, `deliveryReserveZats`,
`deliveryCostZats` (null until the swap is resolved), `teamNativeZats`, `teamSolanaZats`, `holderShortfallZats`;
per coin: `epoch_coin_harvests.teamZats`. `GET /api/epochs` shows `split` per epoch; `GET /api/treasury` shows the
published policy and the team's running totals.

**Where the team's Solana ZEC goes.** Default: it stays in the keeper and `GET /treasury` says
`heldInKeeperZats`. Set `TEAM_WALLET` (a Solana public key, never hard-coded) and the keeper sends it there, one
payout row of kind `team` per epoch, planned only once the epoch's delivery is resolved (a reserve still inside a swap
is never swept), carrying everything owed and not yet sent (a backlog from before `TEAM_WALLET` was set, or from a
row closed as `carried:`). The row goes through the same sign, persist, broadcast, resume-by-signature path as every
Solana payout (`test/team-ledger.test.ts`: signed but never broadcast resumes once, already landed moves nothing).
Config: `PAD_TEAM_SHARE_BPS` (default 2500, refused above 5000), `TEAM_WALLET`, `PAD_DELIVERY_RESERVE_BPS` (100),
`PAD_1CLICK_WITHDRAW_FEE_ZATS` (32,000).

## Snapshot, memo, referral, chart (2026-10-02)

- **Snapshot** (`src/epoch/snapshotFile.ts`, `snapshotMemo.ts`, `scripts/verify-snapshot.ts`): written with the plan, stored once
  in `epoch_snapshots`, hashed over the exact bytes served at `GET /api/epochs/:id/snapshot`. The keeper puts the hash in a
  Solana memo (sign, persist, broadcast, resume by signature, like every payout; a memo that fails alerts and is retried on
  every run, it never stops a payout). Solana rows are public in full; shielded rows are a count, a total and salted
  commitments (`GET /api/epochs/:id/receipt` opens your own). Tests: `test/snapshot.test.ts` (privacy of the file,
  determinism, a doctored file caught by the verify script's arithmetic, the memo on the real chain, a memo failure that
  does not stop payouts, a crash after signing, receipts).
- **Receipt memo** (`src/zcash/devtool.ts` `buildZip321Uri`, `rewardMemo`): `SNARKS pad reward, epoch <id>` on every output.
  Verified against zip321 0.9.0 source (base64url, no padding, 512 bytes) and on regtest in `test/zcash-memo.test.ts`: a
  recipient wallet shows the text after `wallet enhance` (compact blocks carry no memos; a real wallet does this itself).
- **Referral** (`src/dbc/trade.ts` `referralAccountFor`): `referrer` on trade-tx passes the referrer's ZEC token account to
  Meteora, which pays it 4% of the pool fee from its own 20% (PORT-ASSUMPTIONS D22). Our fee does not move
  (`test/referral-live.test.ts`: identical partner fee with and without, on the curve and on the graduated pool). Refused, not
  passed: no initialized ZEC account, a frozen one, or the trader's own wallet.
- **Price chart data** (`src/dbc/priceHistory.ts`): `GET /api/coins/:mint/price-history`, one fee-adjusted point per recorded
  trade, no chain read.
- **Explore data** (contract v2.5; `src/dbc/marketStats.ts`, `listing.ts`, `holderCount.ts`, `GET /api/stats` in `src/api.ts`):
  every coin carries `volume24hZats`, `trades24h` and `priceChange24hBps` (from the trades table: ONLY the trades the engine
  recorded through `trade-confirm`, so trades made anywhere else are not in them), `holders` and `graduatedAt`. `GET /coins`
  takes `sort`, `stage`, `q`, `limit` and `offset` (validated before any chain read, applied in memory, `{ coins, total }`),
  and `GET /stats` answers the board's coin, graduated and volume numbers plus the pad's paid totals and opt-in count. One
  pass over the last 24 hours of trades serves every coin and every request for `PAD_COIN_STATS_MAX_AGE_MS`. `holders` is the
  keeper's newest holder sample, else an on-chain count read in the background at most once a minute per coin: a list request
  never waits for the chain (the coin page waits only for the very first count). The price change is the first recorded trade
  of the window (fee-adjusted, like the chart) against the pool's price now, so one lone trade shows a small move.
  Tests: `test/market-stats.test.ts`, `holder-count.test.ts`, `coins-listing.test.ts`, `stats.test.ts` (no chain),
  `coins-explore-live.test.ts` (real pools on the local validator).
- **Trader panel data** (contract v2.6; `src/api/traderRoutes.ts` serves it; views in `src/dbc/quote.ts`, `holderBook.ts` + `holdersView.ts`,
  `pot.ts`, `fixed.ts`, `poolVaults.ts`, and `src/tradeFeed.ts`, `rewards.ts`, `epochsCsv.ts`): all read-only. No route signs, claims, pays or
  changes a config, and none loads the keeper key (`test/api-no-keeper.test.ts` starts the API with the keeper key unreadable and calls every
  route, 22 of them now). Every parameter is checked before any database or chain read; a chain that cannot be read is `503 chain_unavailable`.
  - `GET /coins/:mint/quote`: a quote with no wallet. The coin's pool state is read at most once per `PAD_QUOTE_MAX_AGE_MS` and each quote is
    worked out from it in memory with the SDKs' own quote functions, so the numbers are the ones `trade-tx` builds (compared for both pools and both
    sides in `test/trader-live.test.ts` and in the e2e). Price impact is the trade's average price against the pool's price before it, fee left out,
    in integer arithmetic. `getCpAmm()` in `src/solana.ts` builds a new SDK client on every call (about 35 ms of IDL parsing, measured); the
    read-only views share one (`src/dbc/cpAmm.ts`). `trade-tx` still uses the per-call one: it is on the money path and was left alone, so a
    graduated coin's `trade-tx` is slower than its quote.
  - `GET /coins/:mint/holders`: never a chain scan inside a request. The book is the newer of the keeper's newest holder sample and a background
    `getProgramAccounts` read (at most once a minute per coin, four at a time); only the first request for a coin that has neither waits. A sample
    can be hours old: the answer carries `asOf` and `source`. Pool vault balances are read at most every `PAD_POOL_VAULT_MAX_AGE_MS`.
  - `GET /coins/:mint/pot`: the pool's own fee counters (the curve's partner fee plus the graduated pool's locked position), cached
    `PAD_POT_MAX_AGE_MS`; the holders' part is worked out with the epoch's own split. `GET /coins/:mint/fixed`: the config account, the mint, the
    DAMM v2 config and pool, and the Squads multisig, each value with the account it came from, cached `PAD_FIXED_MAX_AGE_MS`. The multisig is found
    through `SQUADS_MULTISIG` in the API's settings; without it a vault claimer is reported as `other`.
  - `GET /trades`, `GET /coins/:mint/trades` (newest block time first, trades of one second by signature, as the price chart orders them) and
    `GET /events/trades` (Server-Sent Events). One hub reads the trades table by arrival number (rowid) at most once a second and only while a
    stream is open, so a trade recorded by another process (the keeper, a script) arrives too; a confirm made in the API process pokes it at once.
    `Last-Event-ID` replays up to 50 missed trades; a comment goes out every 15 s; a stream lives 15 minutes; a client that stops reading is
    dropped; at most 4 streams per client address and 400 in all (`429 rate_limited`). The client address is the last `x-forwarded-for` entry, and
    only when the peer is loopback (Caddy). A slot is freed when the server sees the connection close (a browser closing the tab does that; a
    client that only stops reading holds it until the 15 minutes end).
  - `GET /rewards/:wallet` (public parts: Solana-rail payouts in full, shielded rounds as counts and salted commitments, never an amount, address
    or transaction id), `POST /rewards/verify-memo` (matches the memo a wallet shows on a note to a published round; a signed proof, the receipt's
    scheme, opens the wallet's own rows) and `GET /epochs.csv` (public columns only). Every `Epoch` also carries `deliveryCostZats` and `teamNetZats`.
  Tests: `test/trader-quote.test.ts`, `holders-view.test.ts`, `trade-feed.test.ts`, `rewards.test.ts`, `epochs-csv.test.ts`, `trader-views.test.ts`
  (no chain), `trader-hostile.test.ts` (junk in every route and every method), `trader-live.test.ts` (real pools on the local validator), and
  `scripts/e2e-trader.ts`, which the e2e runs against the real chain and a real server process: every answer is compared with numbers read
  from the chain, the SDKs and the database, not with the engine's own view code.
  Load (`stress/api-load.ts`, now with the v2.6 routes and a stream scenario, against a copy of the seeded database on the local
  validator, on a Mac with a load average of about 5): 0 HTTP 500 and 0 client errors at 50, 100, 200, 300 and 500 requests per
  second, overall p95 40, 23, 31, 37 and 162 ms; every new route's p95 at 200 requests per second between 14 and 40 ms; 21 of 21
  streams opened and heard 10,080 trades written by a second process, event latency p50 525 ms and p95 987 ms (the hub's one-second
  poll), the API's memory and open files back to where they started once the streams closed. Measured on a development laptop, not on the server.

## Coin pictures, metadata and links (contract v2.7)

A coin's picture comes from the creator's device. Before v2.7 the form asked for a link and the engine wrote that link on chain as the token's `uri`: a `uri` that is a picture shows no picture in Phantom or Solscan, which read the JSON behind it.

- **`POST /api/uploads`** (`src/api/uploadRoutes.ts`, pictures in `src/publicFiles/image.ts`, storing in `store.ts`): one multipart `file`, at most 5 MB, read with a byte cap. Only the first bytes decide the type (PNG, JPEG, WEBP, GIF; an SVG, HTML or a PDF named `.png` is `400 bad_image`), and the magic-byte check runs before any image library is called, because `sharp` can read an SVG. PNG, JPEG and WEBP are decoded and written again (EXIF and metadata dropped, orientation applied, fitted inside 1000 x 1000, never enlarged, JPEG quality 90); a GIF is checked block by block and stored byte for byte. The name is the first 24 hex digits of the SHA-256 of the STORED bytes plus the extension, so one picture is one file and a name never changes. Written atomically (temporary file, then rename), files 0640 and directories 0750. 10 uploads per client address per minute (`429 rate_limited`, `retry-after`). The decoding is gated (S4-03, `src/publicFiles/decodeGate.ts`): at most 25 million input pixels (`limitInputPixels`, so a header that claims more is refused before any pixel is decoded), 2 pictures decoded at once and 9 more waiting in order, 11 uploads in flight in all; the 12th is `503 busy` with `retry-after: 5` before its body is read, and a slow sender holds an upload place, never a decoder. `test/decode-gate.test.ts`, and the pixel cases of `uploads.test.ts`.
- **`POST /api/coins/launch-tx`**: `imageUrl` must be exactly one of this pad's own upload addresses that still exists on disk, or empty (the pad's `placeholder.png`, written on start); anything else, any other host and any `data:` URL, is `400 bad_image_url`. New `socials` (`src/socials.ts`, the rules of `web/src/lib/socials.ts`; `test/socials.test.ts` runs both on one table). The engine writes `<PUBLIC_DIR>/m/<mint>.json` with `JSON.stringify` (`src/publicFiles/metadata.ts`) once the transaction is built (v2.8.2: the address in it is worked out from the mint, so a launch that cannot be built leaves no file and no row), removes it if the coin's row cannot be recorded, and makes the token's metadata `uri` that file's address. The route is limited (`src/api/launchLimits.ts`, S4-05): 10 calls per client address per minute (`429 rate_limited`), 20 unconfirmed launches per address (`429`) and 2,000 in all (`503 busy`), each counted from the moment its transaction starts to be built; `test/launch-limits.test.ts` and `test/launch-limits-live.test.ts`. `test/launch-image-live.test.ts` launches on the local validator and reads the `uri` back from the chain: it is the JSON, the JSON names the picture and the links, a name with quotes and Unicode survives.
- **`GET /i/<name>`, `GET /m/<mint>.json`** (`src/publicFiles/serve.ts`): the engine serves exactly those name shapes itself (nothing else under them touches the disk); on a server Caddy serves the same files from `PUBLIC_DIR` with the same headers (picture: immutable for a year, JSON: a minute, both nosniff and readable from any page).
- **Clean-up** (`src/publicFiles/sweep.ts`, on start and hourly, never throws into the API): a launch never confirmed is dropped after one hour, its coin row and its JSON, oldest first, unless the mint exists on chain (a read that fails keeps it); the JSON of a mint with no row goes after 24 hours on the same terms; a picture no coin uses and no remaining JSON names is removed after 24 hours (the database is asked again right before the delete, because the sweep is no longer atomic against the routes); a leftover temporary file after an hour. It reads the folders without blocking and handles the files in batches of 200 with the event loop given a turn between batches; a sweep still running at the next hour is not started again.
- **`GET /api/tiers`** also answers `quoteMint` and, per tier, `migrationThresholdZats` (the reviewed config's number) and `liquidity` (what the tier locks for good in the graduated pool), which the Launch page prints (`test/tiers-view.test.ts`).
- Dependency: `sharp` 0.35.5, exact, with its per-platform `@img/sharp-*` packages in `bun.lock` (the server needs the linux-x64 ones: `bun install --frozen-lockfile` brings them; check with `bun -e "require('sharp')"` as the instance user before restarting the API).
- Tests: `uploads.test.ts` (sniffing, re-encoding, EXIF, naming, limits), `metadata.test.ts`, `public-serve.test.ts`, `public-sweep.test.ts`, `decode-gate.test.ts`, `launch-limits.test.ts`, `socials.test.ts`, `launch-image-live.test.ts`, `ops-public-files.test.ts` (the kit's directories, Caddy and the live switch), and the upload, `imageUrl` and `socials` cases of `api-hostile.test.ts`.

## Holder samples

One snapshot at a predictable moment can be bought just before and sold just
after. So a holder's weight in an epoch is the **minimum balance** it showed
across N random samples inside the epoch's window plus one taken at claim time
(`src/epoch/snapshots.ts`, used by `claimRemainingCoins`):

- The keeper plans N (`PAD_SNAPSHOT_COUNT`, default 6) sample times per window: one
  random millisecond inside each of N equal slices of the window, from the OS CSPRNG
  (`node:crypto` `randomInt`). Stratifying bounds the gap between samples, so a stay
  seen by every sample is nearly the whole window. The plan is stored (a restart does
  not redraw) and is never exposed by the API.
- Each sample stores every launched coin's eligible holders (all rules below applied).
  A wallet missing from any sample, or excluded now, weighs nothing; the rest are paid
  pro rata to the least balance they showed.
- **Why the minimum, not a time-weighted average:** the samples are sparse, so a
  time-weighted figure needs an assumption about what happened between them, and it
  pays a partial share for a short stay. The minimum is the least the holder provably
  held at N instants it could not predict. Cost, stated: a wallet that buys in the
  middle of a window earns nothing for that window (full from the next), and one that
  sells part of its stack is paid on what it kept.
- A coin is claimed only if its window holds at least `PAD_SNAPSHOT_MIN_SAMPLES` samples
  (3 on mainnet); the check is made before the claim, so no ZEC is ever claimed
  without a share to explain it. Without the keeper running, a manual `bun run epoch`
  on mainnet therefore claims nothing and says why: **start the keeper at least one window
  (a few hours is enough for 3 samples) before the first epoch.** Locally and on devnet it is 0
  (test money, the judge flow trades and then runs an epoch), so with no samples the claim-time
  sample alone decides; samples that exist are always used.
- **A sample whose chain reads failed is not a taken sample (S4-02).** A read that fails
  because the chain cannot be reached (an RPC 429, a timeout, the RPC guard's open breaker)
  leaves its instant due for that coin and is thrown to the keeper, which backs off (30 s
  doubling to 5 minutes) and tries again; an instant is spent only for the coins that were
  read, so a pass that read some coins and failed others retries only the others
  (`plan.owed`), and a pass that read nothing stores nothing and leaves the counter where it
  was. Several instants due at once are still one stored observation per coin. A failure
  that belongs to one coin (not the chain) is logged and skipped as before. The retry is
  bounded by the window: once it has ended the keeper no longer waits for samples (the epoch
  must run) and a coin holding fewer samples than `PAD_SNAPSHOT_MIN_SAMPLES` raises the stored
  alert `holder_samples_short` (counted in `openAlerts`, resolved by the coin's next sample);
  the gate above then leaves the coin's fees in the pool for a later window.
- Proof: `test/holder-samples.test.ts` (the rule, the plan, the gate),
  `test/holder-samples-retry.test.ts` (failed reads: 2 of 6 first attempts fail and 6 real
  samples are stored; every attempt fails and nothing is stored or spent; partial passes;
  the window bound and its alert; the keeper's backoff; the gate after an outage) and
  `test/snapshot-attack-live.test.ts` (a real coin: a buyer with five times the honest
  buyer's money, arriving after every window sample, gets 0; the control without samples
  gives it most of the claim).

## Holder snapshot

Every owner that is not an on-curve normal keypair is excluded: Meteora's pool
authorities and vaults, other AMMs' vaults, lockers, Squads vaults. Also excluded
by name: the keeper, every config's fee claimer and every member of the Squads
multisig. The mint's real token program is read from the mint account. **The
coin's creator is paid like any holder** and flagged `creator` in the ledger
(exclusion would be cosmetic: the creator can buy from a second wallet). A custodian
on a normal keypair (an exchange hot wallet) cannot be detected and is paid.

## Payout policy

- Solana ZEC: paid if the wallet's ZEC account exists, or if the share exceeds the
  new-account threshold; else carried. Dust floor 5,000 zats.
- Shielded: each holder's share is held until at least 100,000 zats; the swap and
  batch run only when the sendable total is at least 0.01 ZEC; everything else is
  carried, never dropped.

## Stuck epochs

An unfinished epoch used to block every later claim and payout (`findResumableSentEpoch`
came first). Now (`src/epoch/engine.ts`, `src/epoch/stuck.ts`):

- Every run that ends with an epoch still unfinished counts (`epochs.attempts`; a thrown
  error counts too). Past `PAD_STUCK_MAX_ATTEMPTS` runs or `PAD_STUCK_MAX_AGE_MS` the epoch
  is **parked**: status `needs_attention`, a reason, one alert (`alerts` table, a line
  starting `ALERT` on stderr, `GET /treasury` `epochsNeedingAttention`). Its rows stay unsent
  and counted in `owedZats`.
- A parked epoch is still progressed at the start of every run (a refund, a confirmation or a
  human fix can finish it; then it returns to a normal status and the alert closes). It never
  blocks.
- A **new epoch starts only if the parked money is provably separate** (`isolationProblems`):
  the keeper's Solana ZEC account must hold at least everything owed from it (unsent Solana
  rows, unsent shielded rows whose swap has not left the keeper, and all carry), and, for a
  settled swap whose shielded rows are unsent, the treasury wallet must hold that much
  spendable ZEC and be readable. A swap that is out with 1Click holds its money outside both
  and is attributed by its own delivery txid (a txid already counted for another swap is
  refused). Otherwise the run returns `halted` with the reasons and the keeper stays stopped.
- Tests: `test/stuck-epoch.test.ts` (parks by attempts, by age and by a repeating error;
  rows stay owed; a new epoch pays while the parked one waits; halts when the keeper account
  is short or the treasury is unreadable; the parked epoch finishes after a refund and the
  alert clears).
- Not covered: a draft epoch waiting for a Squads approval still blocks later epochs by design
  (it is not stuck, it is waiting for a person); the keeper retries it every `PAD_RESUME_EVERY_MS`.

## The keeper loop and the kill switch

`bun run keeper` (`src/scheduler.ts`, `scripts/keeper.ts`) decides when things run; every money
step stays in `runEpoch`.

- **Cadence:** an epoch every `PAD_EPOCH_EVERY_HOURS` (48) after the last one (or after the
  keeper first started, or at `PAD_FIRST_EPOCH_AT`); the shielded leg only when the last shielded
  epoch is `PAD_SHIELDED_EVERY_DAYS` (7) old. A Solana-only epoch carries opted-in holders' shares
  (as Solana ZEC in the keeper's account, nothing is swapped) and the next shielded epoch plans
  carry plus share (`planPayouts(..., includeShielded)`, stored per epoch in `epochs.includeShielded`).
  The next due time is published for `GET /treasury` (`nextEpochAt`, was always null).
- **Samples:** due holder samples are taken every tick, also while paused (they only read).
- **Kill switch** (`src/pause.ts`): `PAYOUTS_PAUSED=1` or the file `engine/data/PAUSED`. Checked
  before the lock and again at every point that is about to move money (before each coin's claim,
  before the swap submit and every swap status poll that may rebroadcast, before each Solana batch
  and each resend of a stored batch, before each Zcash chunk). A pause thrown mid-epoch stops at
  the next such point; nothing is half done, and the next run after the switch is off pays the rest,
  each wallet once. Unclaimed fees stay in the pools. `GET /treasury` has `paused: true` and the
  web shows a banner on every page.
- **Graceful shutdown:** SIGINT/SIGTERM set an in-process stop that is the same safe stop (reported as
  `stop requested`, not as a pause); the loop then exits 0. A second signal exits at once.
- **Health log:** one JSON line per event (`started`, `epoch`, `resume`, `paused`, `resumed`, `error`,
  `sample_error`, `faucet_low`, `faucet_error`, `stopping`, `stopped`, a heartbeat every 10 minutes) with the next due time, the
  open alert count and the parked-epoch count. An error in a run never ends the loop.
- **Faucet watch (devnet):** every 5 minutes the loop reads the test-money faucet key's balance (read-only, so also while
  paused) and puts `faucetFillsLeft` on every health line. With fewer than 10 fills left it writes a `faucet_low` line, an
  `ALERT` line on stderr and one stored alert (`faucet_low`) that stays open until the key is refilled; a balance it cannot read
  is a `faucet_error` line. `test/scheduler.test.ts` ("faucet watch") covers each.
- `bun run keeper -- --once` runs one tick (cron or a drill).
- Proof: `test/scheduler.test.ts` (cadence, the 2-day / weekly pattern over 20 days, pause, errors, the
  loop), `test/pause.test.ts` (pause before, pause mid-epoch, a stop request), and
  `test/keeper-kill.test.ts`: real `bun run keeper` processes against the local validator, five
  rounds of new fees then an epoch killed at a random moment (four SIGKILL, one SIGTERM), restarted
  until done; on chain every holder is paid exactly once at the planned amount and the epoch's total
  equals the fees the pool accrued.

## Creating the permanent config (audit S1-H2)

`bun run squads:create` then `bun run config:create` are the only reviewed way to make the mainnet
multisig and DBC config; both are **dry runs unless given their flag** and neither was run for real
on a network. Values come from one module, `src/dbc/reviewed.ts`, which the configuration review cites
and `test/config-create.test.ts` compares with the numbers in that document. Details: CONFIG-REVIEW
section 10. In short: `squads:create` takes the owner and backup addresses (the keeper pays and signs;
their keys are never needed), refuses duplicates, off-curve addresses and a second multisig, reads the
account back and checks it; `config:create` prints every field, refuses unless the multisig is exactly
the reviewed shape (3 members, threshold 2, time lock 0, no config authority, rent collector = keeper)
and no config for the vault exists (recorded, pinned or on chain), sends one transaction, then runs the
full-field read-back and records the config only if it passes. Both record the signed bytes before
broadcasting, so a lost answer never leads to a second creation.

## Creator-fee tiers

A creator picks one of five fee levels at launch (1, 2, 4, 6 or 10% on the curve); each level is its own permanent DBC config, derived
from the SNARKS 1% one by exactly six fields (the fee after the launch window, which fixes the window's reduction per step,
`creator_trading_fee_percentage`, DAMM v2 migration option, partner and creator locked LP). The values are `REVIEWED_TIERS` in `src/dbc/reviewed.ts`; the per-trade arithmetic (with the program's rounding) is
`src/dbc/tiers.ts`. A tier is its curve fee in bps, so the config -> tier map is the `dbc_configs` table (`feeBps`), and `tierOfRow`
reads it.

- `bun run config:create -- --multisig <pda> --tier <bps>`: same dry-run default, same refusals, full-field read-back for THAT tier. One
  config per tier per vault (recorded, or found on chain). A tier also refuses unless the vault is the pad's own fee claimer
  (`FEE_CLAIMER_PUBKEY` or `SQUADS_MULTISIG`), so every tier shares one claim path.
- Launch: `buildLaunchTx({ feeTier })` / `POST /coins/launch-tx { feeTier }`. A fee not on the menu, a tier with no recorded config, or a
  recorded config that fails the chain check or names another fee claimer is refused (API: 400 / 503 `tier_unavailable`).
- Epoch: unchanged. The keeper claims only the partner part; holders 75% and team 25% of that, at every tier. The creator's part is
  never in the pad's vault: `GET /coins/:mint/creator-fees` and `POST /coins/:mint/creator-claim-tx` (an unsigned transaction for the
  pool's creator on chain to sign; the web's "Claim creator fees"). The API never loads the keeper key.
- Not tracked: coins that someone launches on a tier config outside this site (config creation and pool creation are permissionless).
  Their fee stays in the pool; no payout is made for them.
- Tests: `test/tiers.test.ts` (exact per-100 split, rounding, the review's numbers), `test/tiers-live.test.ts` (mainnet DBC binary: configs,
  accrual to the zat, creator claim, hostile claims and configs, graduation of each tier), `test/config-create-cli.test.ts` (`--tier`),
  `scripts/e2e.ts` epoch 5. `bun run local:up` clones the four DAMM v2 configs a tier can graduate into.

## The launch window

Every tier config, the SNARKS 1% one included, carries the DBC base-fee scheduler in linear mode: the fee is 99% in the pool's first
second and falls in five equal 1-second steps to the tier's own fee, which it keeps for good (1%: 99, 79.4, 59.8, 40.2, 20.6, then 1).
The launcher's own first buy, inside the launch transaction, pays the tier fee (`enable_first_swap_with_min_fee`); anyone else's buy in
the window pays the step. The reduction is exact for every tier ((990,000,000 - tier numerator) / 5 = 196M, 194M, 190M, 186M, 178M).
Nothing is refused: `trade-tx` builds inside the window, only the web's pages hold Buy and Sell for the seconds and count them down.

- The numbers live in ONE place, `src/dbc/reviewed.ts` (`REVIEWED_WINDOW`, `windowScheduleOf(tierBps)`, which throws unless the step
  divides). `buildConfigParams` asks the SDK for them and `assertWindowExact` compares what the SDK serialized with them to the unit,
  before anything is created. `verifyConfigState` reads every scheduler field back (cliff, steps, seconds per step, reduction, the fee
  after the last step to the unit, the first-buy flag) and refuses any difference; a flat-fee config (made before the window) passes for
  no tier, so no launch is ever built on one. A config row's `feeBps` is the fee AFTER the window (the tier's id), never the cliff.
- `config:create` prints the window and its exactness proof with the dry run. Its duplicate check asks "does a config that meets TODAY's
  spec already exist" (recorded, pinned or on chain), so an older flat-fee generation does not block the new one and a pinned
  `DBC_CONFIG_ID` that fails the current spec is not a reason to refuse. `scripts/config-simulate.ts` asks the program to accept the five
  configs in simulation; `scripts/review-configs.ts` re-reads created configs read-only against the reviewed spec.
- Read side (`src/dbc/window.ts`, pure and read-only): `launchWindowOf(schedule, activationPoint)` (the fact on `Coin.launchWindow`),
  `feeBpsAt` / `feeNumeratorAt` (the SDK's own `getBaseFeeNumerator` over the config's fields, the chain's current point and the pool's
  activation point, with a clock that reads before the activation counted as second 0), `windowSecondsLeft`. A config account never
  changes, so its scheduler is read once and kept (`configScheduleOf`). Since v2.8.1 launch stores that scheduler on the coin's row
  (`coins.feeSchedule`) and confirm stores the pool's activation point (`coins.activationPoint`, decoded from the account confirm reads); a
  coin from before gets both from its first chain read (`src/dbc/read.ts`). `src/dbc/liveFee.ts` works `feeNowBps` and `windowSecondsLeft`
  out per request for `GET /coins/:mint` from those and the server's clock read one second back (`windowNowByClock`): no chain read, so the
  coin page answers while the chain cannot be read. The quote carries `feeBps` and `windowSecondsLeft` from its own snapshot (up to about
  4 s behind, which can only overstate the fee). Scripts and tests that trade right after a launch and want the
  tier's fee call `waitForCoinWindow(mint)` / `waitForWindowToClose(pool)` (`src/dbc/windowWait.ts`) first.
- Tests: `test/launch-window.test.ts` (the fee of every second of every tier by hand, the window as a fact, a flat config, `/tiers`),
  `test/launch-window-live.test.ts` (mainnet DBC binary: the first buy pays the tier fee, a buy inside the window pays the step of the
  second its block landed in, a stranger's buy signed before the launch (`scripts/lib/blind-buy.ts`, addresses only) and sent straight behind
  it lands in the launch's own second and pays the 99% cliff, after the window every buy pays the tier fee to the unit, and `feeNowBps` / the quote
  say the same),
  `test/dbc-config.test.ts` (every scheduler field refused when it differs, per tier) and `test/config-create*.test.ts`.

## When the chain cannot be read (contract v2.8.1)
- Every Solana RPC call goes through `src/rpcGuard.ts` (handed to web3.js as its `fetch`, web3.js's own retry-on-429 off): one attempt with a
  timeout (2.5 s; a `getProgramAccounts` scan 20 s; a send 10 s), a 429 / 5xx / timeout / network error is a `ChainUnavailableError`, and after 3
  in a row a circuit breaker fails every call at once for 30 s, then lets one probe through. One log line when it opens, one when it closes.
- The coin list and the coin page are built from the database and wait at most 1 s for a pool read (`coinViewWithin`), then answer with the
  last values read or without them. The routes that need the chain answer `503 chain_unavailable` within a 4 s route deadline
  (`CHAIN_ROUTE_DEADLINE_MS`). The keeper backs off 30 s doubling to 5 minutes with a `getSlot` probe (`src/scheduler.ts`), logging
  `chain_unavailable` and `chain_available` once each.
- Tests: `test/rpc-guard.test.ts` (the guard, also through a real web3.js Connection against a server answering 429),
  `test/api-chain-down.test.ts` (the API in its own process against a stub RPC that answers 429, then one that never answers),
  `test/keeper-backoff.test.ts` (the real keeper loop on a fake clock).

## The Creator wallet

`POST /coins/launch-tx { creatorWallet }`: the DBC program makes the launcher sign as the pool's creator, so the launch transaction hands
the pool to the wallet with `transfer_pool_creator` as its last instruction (the launcher signs once; the receiver need not sign or hold
SOL). From then on only the receiver can claim the creator fee and owns the creator's locked LP after graduation; the launcher can claim
nothing, and a mistyped address strands both. So `src/dbc/creatorWallet.ts` refuses (400 `bad_creator_wallet`, before any chain read) a
value that is not a canonical base58 address, is off the curve (a PDA or token account), or is one of the pad's own wallets (the keeper,
fee claimers and Squads members it recorded, the team wallet, the vault); blank or the launcher's own address means no handover. The
row stores `creatorWallet`; `Coin.creatorWallet` is the pool's creator read from the chain. `src/dbc/creatorClaim.ts` already read the
creator from the chain (never from the row), so a handed-over pool needed no change there: the receiver connects its wallet and claims,
the launcher is refused (`not_creator`). Tested end to end in `test/launch-window-live.test.ts` (handover in the launch transaction, the
chain / row / view / creator-fees route agree, the launcher is refused, the receiver claims exactly what was waiting) and
`test/api-hostile.test.ts` (off-curve, pad-owned, malformed).

## Supply chain

- Every dependency is an exact version in `package.json` (engine and web), the lockfiles are committed
  (`bun.lock`, `package-lock.json`), `bunfig.toml` and `web/.npmrc` keep new ones exact, and the
  install is `bun install --frozen-lockfile` / `npm ci`.
- `bigint-buffer` 1.1.5 has an unfixed high advisory (GHSA-3gc7-fjrx-p6mg, buffer overflow in the NATIVE
  `toBigIntLE`; no patched release, and the maintained fork ships the identical C source). Our path was
  not reachable (the addon is never built: `bun install` runs no dependency scripts, and the length it is
  given is a fixed 8 bytes from SPL account layouts), but it is now gone from the tree:
  `patches/bigint-buffer@1.1.5.patch` (a `bun patch`, recorded in `bun.lock`) replaces its `dist/node.js` with
  the same pure-JS code and deletes `binding.gyp`, the C source and the install scripts. `bun audit` lists the
  other advisories; none is reachable (`toml` only in Anchor's `workspace` loader that reads `Anchor.toml`,
  never used here; `stream-json` only in jayson's server/http parsing, while web3.js loads
  `jayson/lib/client/browser`; `uuid`'s buffer bug is in v3/v5/v6 with a caller buffer, jayson calls `v4()`).
- `tweetnacl` is replaced in production code by `src/crypto/ed25519.ts` (`node:crypto`): no new dependency, a
  maintained implementation, RFC 8032 strict. It is a dev dependency now (tests and the seed script sign with
  it, and `test/supply-chain.test.ts` uses it as the oracle: RFC vectors, 300 random keys with single-bit
  tampering, garbage inputs). One intended difference: a signature whose S is not reduced (the malleable twin)
  is refused, which tweetnacl accepts. The web keeps tweetnacl (browser mock signing), pinned.
- `scripts/build-devtool.sh` builds zcash-devtool at the tested commit with `--locked` and prints its sha256;
  set `ZCASH_DEVTOOL_SHA256` and the engine refuses to run any other binary (`src/zcash/devtool.ts`).
- **O-5 (recipient u1s on devtool's argv): accepted risk.** The pinned binary's `wallet pay` takes the payment
  request only as `--payment-uri` (checked in its help and string table; no file, stdin or env input), so the
  addresses are visible to a local user running `ps` for the seconds a batch takes. They are not linked to
  Solana wallets there. Mitigation is host hardening: a dedicated user for the keeper, no other accounts on the
  VPS, and `hidepid=2` on `/proc` where the OS offers it. `test/devtool.test.ts` is a canary: it fails the day the
  pinned binary offers a file or stdin input, at which point `payBatch` should switch and O-5 closes.

## API process and the keeper key

No module reachable from `src/api.ts` imports the keeper key; `test/api-no-keeper.test.ts`
walks the import graph and also runs every route in a subprocess whose keeper key
file cannot be created. The API reads only public facts the keeper-side scripts
record in the DB (`meta` table). It cannot create a DBC config (`src/dbc/setup.ts` is
keeper-side); with none recorded it answers `503 not_configured`.

## Design decisions this build made (not fully pinned by the contract)

- **`GET /optin/nonce`'s `message` field** is a display template with a literal
  `<u1 address>` placeholder; the frontend fills in the real address before
  signing. The server always reconstructs the expected message itself (`src/optin/message.ts`).
- **Launch/trade transactions are v0 `VersionedTransaction`s**: the Meteora SDKs
  build legacy transactions; `toUnsignedV0Base64` in `src/solana.ts` recompiles them.
- **A coin's `rewards` totals (`GET /coins/:mint`)** attribute a whole epoch's payouts to
  every coin in that epoch's `coinMints` (payouts are combined per wallet across coins). Exact for one coin.
- **`priceZec`** is a decimal string of zats per whole token; `marketCapZec` is integer zats; both
  are display estimates from `sqrtPrice`. Payouts always settle from the claim transactions' real amounts.
- **`feeZats`** on an epoch is the Zcash network fee of its shielded batch, read back from zebrad.
- **Shielded batch cap:** 350 recipients per transaction (measured ceiling 625, F-035).
- **Epoch scheduling:** no cron/scheduler and no `PAYOUTS_PAUSED` flag in this build; epochs run on demand
  via `bun run epoch`; `GET /treasury`'s `nextEpochAt` is `null`. The holder snapshot is taken when the
  claim lands, at no randomised time.
- **Coins with zero eligible holders:** the claimed ZEC is held in `coin_orphaned_zats` and folded into
  that coin's next claim that has eligible holders (`test/orphaned-proceeds.test.ts`).
- **A holder's repriced shielded share rounding to 0** is resolved as sent with no money moved
  (`sig: "zero_after_fee"`).
- **One owner approval per claim kind:** a coin that has migrated needs up to two approvals per epoch
  (curve fee, position fee). Batching them into one proposal is not done.

## Claim resume design (new with the Meteora port)

`claim_progress` is keyed (epoch, coin, kind) and holds the claim transaction's signature and
signed bytes, written BEFORE it is broadcast. A crash resumes with the same bytes (Solana dedups by
signature); a transaction whose blockhash expired unlanded is forgotten and rebuilt; a Squads claim
also carries its proposal index and a fingerprint of the message the keeper wrote.
**An epoch is never finalized, paid or discarded while any of its claims is unconfirmed**
(`test/epoch-claim-gate.test.ts`); a coin whose claim throws before anything was signed is skipped and
retried next epoch without stopping the other coins (`test/claim-isolation.test.ts`).

## Payout resume design (findings 1, 2, 4, 5, 6, 7)

Every step that can move real funds is split into a "durably record intent"
half and a "make it happen" half, in that order, so a crash anywhere resumes
from exactly what was last recorded instead of re-doing (double claim/
pay) or losing (unattributed proceeds) work. All of it lives in
`src/epoch/engine.ts`; the sequence below is also what the live tests in
`test/solana-payout-live.test.ts` and `test/zcash-payout-live.test.ts` exercise
against the real validator/regtest chain.

**1. Only one epoch run proceeds at a time.** `runEpoch` takes a DB-backed
exclusive lock (`db.tryAcquireLock`/`releaseLock`, table `locks`) before doing
anything else. A lock older than `config.epoch.lockStaleMs` (default 10
minutes) can be taken over, so a crashed run doesn't wedge the pad forever.
This closes the original bug where nothing stopped two concurrent runs from
claiming the same coin twice. `test/epoch-lock.test.ts`.

**2. Claiming is a resumable per-coin draft.** A new epoch starts as a
`status: "harvesting"` draft row (never shown on the public `GET /epochs`
— `db.listEpochs()` filters it out). For each launched coin not yet recorded
for this draft (`epoch_coin_harvests`), the engine migrates it if the curve is
full, claims what accrued (`src/dbc/claim.ts`), measures each claim from **that
specific claim transaction's own pre/post token balance** (`getTokenBalanceDelta`
in `src/solana.ts`) — never a separate before/after poll on the keeper's shared
quote-asset ATA, which the same ATA also receives every other coin's claims into
and pays every Solana ZEC holder out of — snapshots holders, computes that
coin's pro-rata shares, and persists the claimed amount + shares in one DB
transaction (`recordEpochCoinHarvest`) immediately, before moving to the next
coin. A crash mid-epoch resumes by skipping every coin already recorded and
continuing with the rest; it never re-snapshots an already-recorded coin's
holders (which could give a different, non-reproducible split if balances
changed since). (`soldForZatsQuote` keeps its column name; it now means "ZEC claimed".)

**3. The plan is finalized atomically.** Once every coin is claimed, the
epoch leaves "harvesting" and its full payout plan (every payout row, every
carry update) is written in one DB transaction (`finalizeHarvest`): either all
of it lands or none of it does.

**4. A shielded payout's destination is snapshotted at planning time.**
`payouts.zcashAddress` is set once, from the opt-in registry, when the row is
planned — never re-read from the registry when the shielded leg actually
sends. An opt-out between planning and sending cannot break an in-flight
payout; it only ever changes what the *next* epoch plans.

**5. The swap leg is a persisted state machine**
(`none -> submitted(ref) -> settled(amountOut)`, or `none ->
failed_before_funds_moved`, or `submitted -> returned_to_keeper`), never
re-entered once past `none`: `swap.submit(amount, epochId)` is the adapter's
contract boundary. A plain rejection means nothing was signed (safe to fall
back to Solana ZEC). A resolve, or a `SwapFundsMayHaveMoved` rejection (a
deposit is signed and stored but not confirmed), means a deposit may exist: the
engine persists `submitted` with the ref immediately and never falls back on a
`submit()` outcome again. The only way back to Solana payouts after that is
`status()` answering `returned`: the deposit provably never landed, or 1Click
refunded it and the refund is in the keeper's ZEC account. The epoch id is the
adapter's idempotency key, so a crash between the adapter finishing and the
engine recording it resumes the same swap instead of starting a second. `test/swap-state-machine.test.ts`
exercises this with fake adapters (no chain needed, since `progressSwap` only
touches `db` and the injected adapter); `src/swap/simulated.ts`'s own
`submit`/`status` split closes the "crashed process" case for real: the burn
is signed and its bytes persisted (`swap_progress.rawTxBase64`) BEFORE it is
broadcast, so a resumed process can re-broadcast the identical signed bytes
(Solana dedups by signature — replaying it can never cause a second burn)
rather than building a new one; once the burn is confirmed, `status()`
performs the treasury-side settlement exactly once, recording it so a later
poll is a no-op.

**6. Shielded payout pricing is repriced from the real settlement, once.**
The moment `status()` first reports `settled`, every payout row the swap
covers is repriced in the SAME DB write that marks the epoch settled: pro-rata
from the swap's real `amountOutZats` minus the Zcash network fee (`5000 *
(recipient count + 1)` zats), never from the claimed-amount estimate used at
planning time. This must happen exactly once — a later resume sees a smaller
`unsent` set (some rows already sent) and must not re-split the same settled
total against it, which is why it's tied to the state transition, not to
`sendShieldedLeg`'s call site. `test/swap-state-machine.test.ts` asserts both
the exact repriced amounts and that a second call never touches them again.

**7. Both payout legs sign/record before they broadcast.** For Solana, a
batch's transaction is signed locally (its signature is fixed with zero
network calls beyond fetching a blockhash), the signature is persisted as
pending — `db.markPayoutPending` — and only THEN is it broadcast; a crash in
between resumes by checking that signature's chain status
(`isSignatureLanded`, `src/solana.ts`) instead of blindly resending, and
clears it for a fresh attempt (fresh blockhash, fresh signature) if it never
landed. For Zcash, the instant devtool's `pay` returns a txid it is persisted
pending — never waiting for the whole chunked batch to finish — and resume
checks `zcashTxStatus` (`mined`/`mempool`/`unknown`): `mined` resolves it sent,
`mempool` leaves it alone (resending would double-pay), `unknown` (never
broadcast, or the regtest chain was reset) clears it for a fresh attempt.
`test/payout-resume.test.ts` covers the DB contract directly;
`test/solana-payout-live.test.ts` and `test/zcash-payout-live.test.ts` inject a
real crash (an `onPending` hook that persists then throws, before
broadcast/confirmation) against the real validator/regtest chain and prove
both that the pending record survives and that the chain-status check
correctly reports "never landed" / "in the mempool, not yet mined".

**8. Multi-chunk shielded payouts and unconfirmed change.** A shielded batch
over `maxShieldedRecipientsPerTx` (350) splits into multiple transactions. Chunk
2 must not spend chunk 1's still-unconfirmed change. **Chosen policy: wait for
confirmations between chunks** (`config.epoch.zcashChunkConfirmations`,
default 1 block on every network including mainnet), documented and
enforceable rather than pre-splitting notes, because pre-splitting requires
wallet-side note management this build doesn't have and a short wait is cheap
relative to an epoch's cadence. On regtest, mining + syncing to spendability
between chunks (already needed for the treasury's own spendability policy)
satisfies this with a wide margin. **Enforcement is only wired for regtest**
(`waitForZcashConfirmations`/`zcashTxStatus` in `src/zcash/regtest.ts`); a
real multi-chunk payout on testnet/mainnet throws a clear error rather than
silently skipping the wait, matching this build's other "written but never
run" non-local boundaries. No run in this build has ever needed more than one
chunk (this pad's holder counts are far under 350).

## Privacy

The API never returns a full Zcash address, to anyone, including the pad
operator after registration (`maskZcashAddress` in `src/zcash/address.ts`,
used everywhere a status is reported). Per-recipient shielded amounts are
never published; `GET /epochs` only ever reports a batch's `count` and
`totalZats`. Whether a wallet opted in, its masked address, what is pending for
it and the shielded rounds that paid it are shown only to a request that carries
that wallet's own fresh signature (`POST /optin/status`, contract v2.9; the same
nonce scheme as opt-in/opt-out, with its own message text, so a status signature
cannot opt anyone in or out and an opt-in signature cannot read the status).
There is no unsigned status route (`GET /optin/<wallet>` is a 404, the same for
every wallet), the holders list has no opted-in tag or count, and
`GET /rewards/:wallet` carries only the Solana payouts (a shielded share that was
paid as Solana ZEC because the round's shielded batch could not run is not one of
them: it is in the signed answer as `shielded.fallback`, since listing it publicly
would show the wallet had opted in): a stranger who only knows
a wallet's public key learns nothing about whether it opted in. See
the site's How page ("What is hidden vs not") for the corrected claim about
payout amounts: an exact per-recipient amount is never published, but it was
never true that the amount was unknowable: it follows from a wallet's public
Solana balance and the public per-token rate; and the same list names what the
pad cannot hide: a wallet that opted in stops receiving Solana payouts, which
are on chain. `test/optin-signed-read.test.ts` covers the signed read (an
unsigned read reveals nothing, a status signature cannot opt in or out, a reused
nonce is refused, the holders view has no opt-in field);
`test/api-payout-rail.test.ts` covers the payout-rail reclassification below.

A payout's `kind` (which holder-category it came from) and the RAIL that
actually moved its money can differ: a shielded-opt-in holder whose swap
failed before funds moved is paid over the Solana rail instead
(`sig: "fallback_solana:<sig>"`). `src/api.ts`'s `payoutRail()` classifies by
what actually happened — real Zcash txid, `fallback_solana:` prefix, or a
non-money marker (`carried:...`, `zero_after_fee`) — so `GET /epochs` and a
coin's `rewards` report the real rail, not the holder-category label.

## Layout

```
src/
  config.ts              mode selection, RPC endpoints, program ids, DBC/Squads settings, thresholds
  db.ts                   bun:sqlite schema + all persistence (claim_progress, meta, dbc_configs, ...)
  keeper.ts               keeper keypair (keeper-side only; generated for local mode)
  solana.ts               shared Connection + Meteora DBC / DAMM v2 SDK handles, commitment-aware waits
  api/                    common.ts (headers, errors, client address), params.ts (strict query values), traderRoutes.ts (the v2.6 routes),
                          uploadRoutes.ts + windowLimiter.ts (POST /uploads, v2.7), walletRoutes.ts (GET /wallets/:wallet, v2.9)
  publicFiles/            image.ts (sniff + re-encode), store.ts, paths.ts, metadata.ts, serve.ts (/i and /m), sweep.ts, ready.ts (v2.7)
  socials.ts              the creator's links: the checks the launch route applies (v2.7)
  tradeFeed.ts            the trades tape, the stream hub and its connection limits (v2.6)
  rewards.ts  epochsCsv.ts   a wallet's public rewards (Solana payouts) and the memo check; the epochs CSV (v2.6); since v2.9 a wallet's shielded rounds are given only by the signed status read
  dbc/                    reviewed.ts (the reviewed permanent values), createConfig.ts + createMultisig.ts +
                          pendingCreate.ts (the creation tools), config.ts (spec + verify, read-only), setup.ts (create config, keeper-side),
                          launch.ts, trade.ts, claim.ts (FeeClaimer + claim builders), claimers.ts (picks the
                          claimer per coin), squads.ts (Squads vault claimer + proposal decoding),
                          migrate.ts, read.ts; v2.6 read-only views: quote.ts, cpAmm.ts, holderBook.ts + holdersView.ts,
                          poolVaults.ts, pot.ts, fixed.ts; walletView.ts (the profile's data, v2.9)
  faucet.ts               test-money faucet (own key; devnet route)
  holders.ts              holder snapshot + exclusion rules
  optin/                  nonce, message format, ed25519 verify, registry (opt-in, opt-out and the v2.9 signed status read)
  zcash/                  unified-address gate, zcash-devtool wrapper, regtest process mgmt
  swap/                   types.ts (SwapAdapter contract), simulated.ts (local), near1click.ts (the real leg's state machine),
                          near1click-api.ts (HTTP client, quote signature + checks), near1click-chain.ts (the Solana deposit)
  epoch/                  pro-rata math + policies, Solana ZEC payouts, Zcash batched payouts, orchestrator,
                          snapshots.ts (random holder samples), stuck.ts (parking and isolation),
                          publicView.ts (what the public routes say about a round)
  pause.ts                kill switch (PAYOUTS_PAUSED / pause file) and graceful stop
  scheduler.ts            the keeper loop: cadence, samples, health log (scripts/keeper.ts runs it)
  crypto/ed25519.ts       Ed25519 verification (node:crypto)
  ledger.ts               public treasury view
  api.ts                  Bun.serve routes
scripts/
  local-up.ts   seed.ts   epoch.ts   keeper.ts   api.ts   e2e.ts (+ e2e-trader.ts)   qa-local.ts   swap-live-check.ts
  config-create.ts   squads-create.ts   build-devtool.sh   s1-devnet-dryrun.ts   squads-proposals.ts
test/
  dbc-config, dbc-read, dbc-live, squads-live, holders, payout-policy, chain-facts, api-no-keeper,
  epoch-claim-gate, claim-isolation, near1click-api, near1click-state, swap-fallback,
  epoch-math, optin-verify, optin-registry, ua-parse, idempotency, payout-resume, swap-state-machine,
  epoch-lock, orphaned-proceeds, solana-payout(-live), zcash-payout-live, api-payout-rail, api-hostile,
  config-create(-cli), copy, holder-samples, snapshot-attack-live, stuck-epoch, pause, scheduler, keeper-kill,
  supply-chain, devtool, trader-quote, holders-view, trade-feed, rewards, epochs-csv, trader-views, trader-hostile, trader-live,
  uploads, metadata, public-serve, public-sweep, socials, tiers-view, launch-image-live, ops-public-files (v2.7),
  optin-signed-read, wallet-view, signed-message-parity (v2.9)
  helpers/ (api-routes-probe, claim-isolation, squads-local, fake-1click, snapshot-attack, kill-setup, kill-trade)  fixtures/ (a real 1Click dry quote)
```
