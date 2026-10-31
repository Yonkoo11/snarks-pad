<script lang="ts">
  // The card a resting pointer (or a held finger) opens over a ledger row: the trade line large, the supply rule, the curve,
  // what the next round pays a holder and what this coin has paid with its round count. Every number is one the row reads;
  // nothing here is fetched that the row would not fetch.
  import { peek } from '../../lib/peek.svelte'
  import { rowExtras, type RowExtras } from '../../lib/desk'
  import { zec, pricePerMillion, ago } from '../../lib/format'
  import Spark from '../Spark.svelte'
  import ConcRule from '../ConcRule.svelte'
  import CoinImage from '../CoinImage.svelte'

  const W = 304
  let extras = $state<RowExtras | null>(null)
  const coin = $derived(peek.coin)
  $effect(() => {
    const c = peek.coin
    extras = null
    if (!c) return
    let live = true
    rowExtras(c.mint).then((e) => { if (live) extras = e })
    return () => { live = false }
  })
  // any scroll or key closes it: a card must never stay behind the thing it describes
  $effect(() => {
    if (!peek.coin) return
    const off = () => peek.hide()
    addEventListener('scroll', off, { passive: true, capture: true })
    addEventListener('keydown', off)
    return () => { removeEventListener('scroll', off, true); removeEventListener('keydown', off) }
  })
  const left = $derived(Math.max(8, Math.min(peek.x + 14, innerWidth - W - 8)))
  const above = $derived(peek.bottom + 280 > innerHeight && peek.top > 290)
  const topPx = $derived(above ? peek.top - 8 : peek.bottom + 6)
  const perHolder = $derived.by(() => {
    if (!extras || extras.holdersPotZats == null || !extras.holdersCount) return null
    return BigInt(extras.holdersPotZats) / BigInt(extras.holdersCount)
  })
  const paid = $derived(coin ? BigInt(coin.rewards.paidSolanaZec || '0') + BigInt(coin.rewards.paidShieldedZec || '0') : 0n)
  const curve = $derived(coin?.curveProgress ?? null)
  const phoneAnchor = $derived(peek.touch && innerWidth <= 640)
</script>

{#if coin}
  <div class="peek" class:above class:phone={phoneAnchor} style:left={phoneAnchor ? undefined : `${left}px`} style:top={phoneAnchor ? undefined : `${topPx}px`} role="status" aria-label="Quick look at {coin.name}">
    <div class="ph">
      <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={30} />
      <div class="pn"><b>{coin.name}</b><span class="mono muted">${coin.symbol}</span></div>
      <span class="mono pp">{coin.priceZec === undefined ? '–' : `${pricePerMillion(coin.priceZec)} ZEC`}</span>
    </div>
    <div class="spark">
      {#if extras?.trades}<Spark trades={extras.trades} w={272} h={56} />{:else}<span class="label">&ndash;</span>{/if}
    </div>
    <dl>
      <div><dt class="label">Supply</dt><dd>{#if extras}<ConcRule top10={extras.top10Pct} dev={extras.devPct} pool={extras.poolPct} w={96} />{:else}<span class="mono">–</span>{/if}</dd></div>
      <div><dt class="label">Curve</dt><dd class="mono">{curve === null ? '–' : `${Math.round(curve * 100)}%`}</dd></div>
      <div><dt class="label">Holders</dt><dd class="mono">{coin.holders == null ? '–' : coin.holders.toLocaleString('en-US')}</dd></div>
      <div><dt class="label">Next / holder</dt><dd class="mono">{perHolder === null ? '–' : `${zec(perHolder, 6)} ZEC`}</dd></div>
      <div><dt class="label">Paid so far</dt><dd class="mono">{paid > 0n ? `${zec(paid, 2)} ZEC` : '–'} <span class="nn">n={coin.rewards.epochs}</span></dd></div>
      <div><dt class="label">Age</dt><dd class="mono">{ago(coin.createdAt)}</dd></div>
    </dl>
    <p class="src muted">{#if extras?.trades && extras.trades.length >= 2}Last {extras.trades.length} trades, {ago(extras.trades[0].at).replace(' ago', '')} wide.{:else}Too few trades for a line.{/if} {peek.touch ? 'Tap' : 'Click'} the row to open the sheet.</p>
  </div>
{/if}

<style>
  .peek {
    position: fixed; z-index: 45; width: 304px; display: grid; gap: var(--s-3); padding: var(--s-4); pointer-events: none;
    background: var(--paper-2); border-radius: var(--r-md); box-shadow: var(--sh-3), 0 0 0 1.5px var(--line);
    animation: peek-in 140ms var(--ease);
  }
  .peek.above { translate: 0 -100%; }
  .peek.phone { left: 12px; right: 12px; top: auto; bottom: calc(76px + env(safe-area-inset-bottom, 0px)); width: auto; }
  @keyframes peek-in { from { opacity: 0; transform: translateY(4px); } }
  .ph { display: flex; align-items: center; gap: var(--s-2); min-width: 0; }
  .pn { display: grid; min-width: 0; flex: 1; line-height: 1.2; }
  .pn b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-14); }
  .pn span { font-size: var(--t-11); }
  .pp { font-weight: 700; font-size: var(--t-14); }
  .spark { min-height: 56px; display: flex; align-items: center; color: var(--ink-2); }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2) var(--s-4); margin: 0; }
  dt { font-size: var(--t-11); } dd { margin: 0; font-size: var(--t-12); font-variant-numeric: tabular-nums; }
  .nn { color: var(--ink-3); font-size: var(--t-11); }
  .src { margin: 0; font-size: var(--t-11); }
  @media (prefers-reduced-motion: reduce) { .peek { animation: none; } }
</style>
