<script lang="ts">
  import { readHoldings } from '../lib/holdings'
  import type { Holding } from '../lib/profile'
  import { tokens, zec, usdOfZats } from '../lib/format'
  import { zecUsd } from '../lib/usd.svelte'
  import CoinImage from './CoinImage.svelte'

  // The Holdings tab: the pad's coins this wallet holds, read in the browser (lib/holdings.ts: one read of its Token-2022 accounts, kept to the coins the engine lists), with
  // what each is worth in ZEC at the pool's price. A coin the engine has no price for yet shows a dash, never 0. No server call reads a balance.
  let { address, you }: { address: string; you: boolean } = $props()
  let rows = $state<Holding[] | null>(null) // null = loading
  let err = $state(false)
  let asked = 0
  async function load() {
    const mine = ++asked
    rows = null; err = false
    try {
      const read = await readHoldings(address)
      if (mine === asked) rows = read
    } catch {
      if (mine === asked) err = true
    }
  }
  $effect(() => { void address; load() })
  $effect(() => { zecUsd.refresh() })
  const amountOf = (h: Holding): string => tokens(h.amount, h.amount < 1_000_000n ? 4 : 0)
</script>

{#if err}
  <div class="state"><p class="error">Could not read this wallet's coins from Solana.</p><button class="btn" type="button" onclick={load}>Try again</button></div>
{:else if rows === null}
  <div class="skel sk" aria-busy="true" aria-label="Loading the coins this wallet holds"></div>
{:else if rows.length === 0}
  <div class="state">
    <p class="muted">{you ? 'You hold' : 'This wallet holds'} no SNARKS pad coins yet.</p>
    <a class="btn" href="#/">See the coins</a>
  </div>
{:else}
  <div class="list" aria-label="Coins in this wallet">
    {#each rows as h (h.coin.mint)}
      <a class="row" href="#/coin/{h.coin.mint}">
        <CoinImage src={h.coin.imageUrl} symbol={h.coin.symbol} size={36} />
        <span class="names"><strong>{h.coin.name}</strong><span class="mono sub">{amountOf(h)} ${h.coin.symbol}</span></span>
        <span class="worth">
          <span class="mono">{h.valueZats === null ? '–' : `${zec(h.valueZats, 4)} ZEC`}</span>
          {#if h.valueZats !== null && usdOfZats(h.valueZats, zecUsd.rate)}<span class="mono usd">{usdOfZats(h.valueZats, zecUsd.rate)}</span>{/if}
        </span>
      </a>
    {/each}
  </div>
{/if}

<style>
  .state { display: grid; gap: var(--s-3); justify-items: start; }
  .sk { height: 200px; }
  .list { display: grid; }
  .row {
    display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: var(--s-3); align-items: center; padding: var(--s-3) var(--s-2);
    border-bottom: 1px solid var(--line); border-radius: var(--r-sm); font-size: var(--t-14); color: inherit; text-decoration: none; min-height: 56px;
  }
  a.row { transition: background-color var(--d-fn) var(--ease), transform var(--d-fn) var(--ease); }
  @media (hover: hover) { a.row:hover { background: var(--paper-2); transform: translateX(2px); } }
  a.row:active { background: var(--paper-3); transition-duration: var(--d-press); }
  .names { display: grid; min-width: 0; }
  .names strong { font-size: var(--t-16); overflow-wrap: anywhere; }
  .sub { color: var(--ink-2); overflow-wrap: anywhere; }
  .worth { display: grid; justify-items: end; text-align: right; }
  .usd { font-size: var(--t-12); color: var(--ink-2); }
</style>
