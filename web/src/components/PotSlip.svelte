<script lang="ts">
  import type { CoinDetail, Pot, Treasury } from '../lib/types'
  import { zec, usdOfZats, countdown, ago } from '../lib/format'
  import FillBar from './FillBar.svelte'
  // The coin's own pot, out in the open beside the buy box: what this pool has already accrued for its
  // holders and when it is next paid. The Rewards tab keeps the detail (legs, transactions, running
  // totals); this slip is the reason to hold, visible without a click. An engine without GET /pot
  // (pot === null) gets no slip rather than a slab of dashes.
  let { coin, pot, treasury, now, rate, yourCut = null }: { coin: CoinDetail; pot: Pot | null | undefined; treasury: Treasury | null; now: number; rate: number | null; yourCut?: bigint | null } = $props()

  const nextAt = $derived(pot && pot.nextPayoutAt !== null ? pot.nextPayoutAt : treasury?.nextEpochAt ?? null)
  const nextDue = $derived(nextAt !== null && Date.parse(nextAt) - now <= 0)
  const lastAt = $derived(pot?.lastPayout?.at ?? treasury?.lastEpochAt ?? null)
  const everyH = $derived(treasury?.cadence ? Math.max(1, Math.round(treasury.cadence.roundEveryMs / 3_600_000)) : null)
</script>

{#if pot === undefined}
  <div class="skel" style="height: 132px" aria-busy="true" aria-label="Loading this coin's pot"></div>
{:else if pot}
  <aside class="slip" aria-label="What this coin's holders are owed next">
    <p class="label">In this coin's pot</p>
    <p class="sum">
      <span class="mono big">{zec(pot.holdersZats)} ZEC</span>
      {#if usdOfZats(pot.holdersZats, rate)}<span class="usd mono">{usdOfZats(pot.holdersZats, rate)}</span>{/if}
      <span class="for">for holders</span>
    </p>
    <!-- the same trade-share figure the chips state (feeBps x holderShareBps), never the share-of-fee figure -->
    <p class="muted of">The pool has accrued <span class="mono">{zec(pot.accruedZats)} ZEC</span> in fees nobody has claimed yet; holders get {String(Math.round(coin.feeBps * coin.holderShareBps / 10_000) / 100)}% of each trade.</p>
    <FillBar fromIso={lastAt} toIso={nextAt} {now} />
    <p class="clock">
      {#if nextAt === null}
        {#if everyH}Rounds run about every {everyH}h; times are not announced.{:else}The next round is not scheduled yet.{/if}
      {:else if nextDue}The round is running now.
      {:else}Pays in <span class="mono">{countdown(nextAt, now)}</span>{/if}
    </p>
    {#if yourCut !== null && yourCut > 0n}
      <!-- the personal number: an estimate from the wallet's real balance, said as one, with the rule's condition -->
      <p class="cut">At your balance, about <span class="mono">{zec(yourCut, 6)} ZEC</span> of this pot is yours next round, if you hold through the round's checks.</p>
    {/if}
    {#if pot.lastPayout}
      <p class="muted last">Last round paid this coin's holders <span class="mono">{zec(pot.lastPayout.totalZats)} ZEC</span> {ago(pot.lastPayout.at, now)}.</p>
    {/if}
  </aside>
{/if}

<style>
  /* a paper slip, barely tilted, like the hero's proof strip: the pot is this page's proof */
  .slip {
    display: grid; gap: var(--s-2);
    background: var(--paper-2); border-radius: var(--r-xs);
    box-shadow: var(--sh-2), inset 0 1px 0 light-dark(transparent, rgba(239, 231, 218, .07));
    padding: var(--s-4) var(--s-5); transform: rotate(.35deg);
  }
  .sum { display: flex; align-items: baseline; gap: var(--s-2); flex-wrap: wrap; }
  .big { font-size: clamp(24px, 2vw, 30px); font-weight: 500; line-height: 1.1; }
  .usd { font-size: var(--t-14); color: var(--ink-3); }
  .for { font-size: var(--t-14); color: var(--ink-2); }
  .of { font-size: var(--t-14); max-width: 44ch; }
  .clock { font-size: var(--t-14); font-weight: 700; }
  .cut { font-size: var(--t-14); padding: var(--s-2) var(--s-3); background: var(--paper-3); border-radius: var(--r-sm); max-width: 44ch; }
  .last { font-size: var(--t-14); }
  /* the slip sits flat on a phone, like the hero's proof strip */
  @media (max-width: 640px) { .slip { transform: none; } }
</style>
