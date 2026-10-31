<script lang="ts">
  // The ten-second read before a buy, pinned under the headline numbers: who holds the supply,
  // what the dev holds, what moved since this browser last looked, which way the recent trades
  // lean (with how much time they actually cover: the tape is shallow, and hiding that would be
  // lying), and what the next round would pay each holder if it closed now.
  import type { Coin, Pot } from '../lib/types'
  import type { RowExtras } from '../lib/desk'
  import { rowExtras } from '../lib/desk'
  import { zec, countdown } from '../lib/format'
  import { lastLook, lookDelta, recordLook, snapOf } from '../lib/looked'
  import ConcRule from './ConcRule.svelte'
  import Prov from './Prov.svelte'

  const { coin, pot, now }: { coin: Coin; pot: Pot | null | undefined; now: number } = $props()

  let extras = $state<RowExtras | null>(null)
  $effect(() => {
    let live = true
    const read = () => rowExtras(coin.mint).then((e) => { if (live) extras = e })
    read()
    const t = setInterval(read, 60_000)
    return () => { live = false; clearInterval(t) }
  })

  // the delta is computed once against the stored look, then this visit becomes the new look
  let delta = $state<string[]>([])
  let compared = false
  $effect(() => {
    if (compared || coin.holders == null) return
    compared = true
    const snap = snapOf(coin)
    delta = lookDelta(lastLook(coin.mint), snap)
    recordLook(coin.mint, snap)
  })

  const lean = $derived.by(() => {
    const ts = extras?.trades
    if (!ts || ts.length === 0) return null
    const buys = ts.filter((t) => t.side === 'buy').length
    const mins = Math.max(1, Math.round((now - Date.parse(ts[0].at)) / 60_000))
    const covers = mins < 90 ? `${mins} min` : mins < 60 * 48 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / (60 * 24))} d`
    return { buys, sells: ts.length - buys, covers, all: ts.length < 40 }
  })
  const perHolder = $derived.by(() => {
    if (!pot || !extras?.holdersCount) return null
    return BigInt(pot.holdersZats) / BigInt(extras.holdersCount)
  })
</script>

<dl class="strip" aria-label="Before you buy">
  <div>
    <dt class="label">Supply<Prov label="supply split" src="Holder list aggregates from the pad API, the keeper's sample or the chain" note="Ten largest eligible wallets, the creator and the pool vaults as shares of total supply." {now} /></dt>
    <dd class="viz">{#if extras}<ConcRule top10={extras.top10Pct} dev={extras.devPct} pool={extras.poolPct} w={64} />{:else}<span class="mono">–</span>{/if}</dd>
    <dd class="mono sub">{extras?.top10Pct != null ? `top10 ${extras.top10Pct}%` : ''}{extras?.devPct != null ? ` · dev ${extras.devPct}%` : ''}</dd>
  </div>
  <div>
    <dt class="label">Since you looked<Prov label="since you looked" src="This browser's own record of the last time you opened this coin" note="Nobody else sees it and it is not on a server." {now} /></dt>
    <dd class="mono">{delta.length ? delta.join(', ') : 'no change'}</dd>
    <dd class="mono sub">this browser's own memory</dd>
  </div>
  <div>
    <dt class="label">Trade lean<Prov label="trade lean" src={lean ? `The last ${lean.buys + lean.sells} trades the engine records for this coin` : 'The coin\'s recorded trades'} n={lean ? lean.buys + lean.sells : null} note="Counts of buys and sells, not their size. It covers only the window printed under it." {now} /></dt>
    {#if lean}
      <dd class="mono">{lean.buys} buys / {lean.sells} sells</dd>
      <dd class="mono sub">{lean.all ? `all ${lean.buys + lean.sells} recorded trades` : `last 40 trades`} · covers {lean.covers}</dd>
    {:else}
      <dd class="mono">–</dd>
    {/if}
  </div>
  <div>
    <dt class="label">Next round / holder<Prov label="next round per holder" src="The coin's pot for holders from the pad API, divided by its eligible holder count" note="An even split if the round closed now. The real payout follows the least each wallet held at the round's random checks." {now} /></dt>
    <dd class="mono">{perHolder === null ? '–' : `${zec(perHolder, 6)} ZEC`}</dd>
    <dd class="mono sub">if the round closed now, spread evenly</dd>
  </div>
  <div>
    <dt class="label">Round pays in<Prov label="round countdown" src="The pad API's next payout time for this coin" note="A round that finds nothing to claim still ends the countdown." {now} /></dt>
    <dd class="mono">{pot?.nextPayoutAt ? countdown(pot.nextPayoutAt, now) : '–'}</dd>
  </div>
</dl>

<style>
  .strip { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-5); margin: 0; padding: var(--s-2) var(--s-3);
    border-block: 1px solid var(--line); font-size: var(--t-12); }
  .strip > div { display: grid; gap: 1px; align-content: start; }
  dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 700; }
  .sub { font-weight: 400; color: var(--ink-3); font-size: var(--t-11); }
  .viz { display: flex; align-items: center; min-height: 16px; }
  .strip .label { font-size: var(--t-11); }
  @media (max-width: 640px) { .strip { gap: var(--s-2) var(--s-4); } }
</style>
