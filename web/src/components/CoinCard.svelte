<script lang="ts">
  import type { Coin } from '../lib/types'
  import { zec, usdOfZats, pct, ago, feeChip, feeLabel } from '../lib/format'
  import CoinImage from './CoinImage.svelte'
  import CurveBar from './CurveBar.svelte'
  // One coin of the market: a paper card in the grid, or a row in the list. Every value comes from the coin itself; a v2.5
  // or v2.6 field an older engine does not send is a dash, never 0. The hatched chip appears only on a coin whose holders
  // have been paid shielded ZEC (the device marks what is shielded, and nothing else).
  // `preview`: the launch form's live card for a coin that does not exist yet; the numbers it cannot know are dashes and it links nowhere.
  let { coin, view = 'grid', rate = null, now = Date.now(), preview = false }: { coin: Coin; view?: 'grid' | 'list'; rate?: number | null; now?: number; preview?: boolean } = $props()
  const vol = $derived(preview || coin.volume24hZats === undefined ? null : `${zec(coin.volume24hZats, 2)} ZEC`)
  const usd = $derived(preview || coin.marketCapZec === undefined ? null : usdOfZats(coin.marketCapZec, rate))
  const shielded = $derived(BigInt(coin.rewards.paidShieldedZec || '0') > 0n)
  const graduated = $derived(coin.stage === 'graduated')
  const first = $derived(coin.symbol === 'SNARKS')
  // What holders get of every trade: the fee times the holders' share of it (0.6% on every tier; 0.612% on the 6% tier), never the share of
  // the fee alone, which would make a 10% coin look ten times worse for holders when it is only costlier to trade.
  const holderPct = $derived(String(Math.round(coin.feeBps * coin.holderShareBps / 10_000) / 100))
  // The fee is never printed bare: "on curve" while the coin is on its curve, the pool's range once graduated. The hover tells both halves.
  const feeTitle = $derived(graduated ? `Meteora's pool charges ${feeLabel(coin)}` : `Flat while the coin is on its curve. After graduation: ${feeLabel({ ...coin, stage: 'graduated' })}`)
  // 24h change in words a trader reads: a sign and a percent, plain ink (the page's one accent marks shielded, nothing else).
  // The engine sends null for a coin with no trade in the window: the price did not move, which is a true number, so it reads 0.0% in the
  // muted ink. A field an older engine does not send is unknown: a dash.
  const noTrade = $derived(!preview && coin.priceChange24hBps === null)
  const change = $derived.by(() => {
    const b = coin.priceChange24hBps
    if (noTrade) return '0.0%'
    if (b === undefined || b === null) return null
    const p = Math.abs(b) / 100
    return `${b < 0 ? '−' : b > 0 ? '+' : ''}${p >= 10 ? Math.round(p) : p.toFixed(1)}%`
  })
  const holders = $derived(preview || coin.holders === undefined || coin.holders === null ? null : coin.holders.toLocaleString('en-US'))
  // ZEC the curve still needs (v2.6); hidden on an engine that does not send it
  const toGo = $derived(!graduated && !preview && coin.curveRoomZats !== undefined ? BigInt(coin.curveRoomZats) : null)
  // the pool numbers are absent while the engine cannot read the chain and never has for this coin (contract v2.8.1): a dash, never 0
  const mcap = $derived(preview || coin.marketCapZec === undefined ? '–' : `${zec(coin.marketCapZec, 2)} ZEC`)
  const age = $derived(preview ? 'not launched yet' : ago(coin.createdAt, now))
</script>

{#if view === 'list'}
  <a class="lrow" role="row" href="#/coin/{coin.mint}">
    <span role="cell" class="c-coin">
      <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={36} />
      <span class="c-name"><strong>{coin.name}</strong>{#if first}<span class="chip">Coin #1</span>{/if}<span class="mono sym">${coin.symbol}</span></span>
    </span>
    <span role="cell" class="num"><span class="mono v">{mcap}</span>{#if usd}<span class="mono usd">{usd}</span>{/if}</span>
    <span role="cell" class="num hide-md mono v">{vol ?? '–'}</span>
    <span role="cell" class="num hide-md mono v" class:muted={noTrade} title="Price change over 24 hours">{change ?? '–'}</span>
    <span role="cell" class="num hide-md mono v">{holders ?? '–'}</span>
    <span role="cell" class="bond">
      {#if graduated}<span class="chip">Graduated</span>
      {:else if coin.curveProgress === undefined}<span class="mono pc">–</span>
      {:else}<span class="bar"><CurveBar progress={coin.curveProgress} stage={coin.stage} compact /></span><span class="mono pc">{pct(coin.curveProgress)}</span>{/if}
    </span>
    <span role="cell" class="num hide-md"><span class="mono v">{feeLabel(coin, true)}</span><span class="mono where">{graduated ? 'in pool' : 'on curve'}</span></span>
    <span role="cell" class="num hide-md age">{ago(coin.createdAt, now)}</span>
  </a>
{:else}
  <a class="card panel" class:preview href={preview ? undefined : `#/coin/${coin.mint}`} aria-label={preview ? 'Preview of your coin\'s card' : undefined}>
    <span class="img"><CoinImage src={coin.imageUrl} symbol={coin.symbol} fill /></span>
    <strong class="name">{coin.name}</strong>
    <span class="row2"><span class="mono">${coin.symbol}</span><span>{age}</span></span>
    <dl class="nums">
      <div><dt class="label">Market cap</dt><dd class="mono v">{mcap}</dd>{#if usd}<dd class="mono usd">{usd}</dd>{/if}</div>
      <div><dt class="label">24h volume</dt><dd class="mono v">{vol ?? '–'}</dd></div>
      <div><dt class="label">Holders</dt><dd class="mono v">{holders ?? '–'}</dd></div>
      <div><dt class="label">24h change</dt><dd class="mono v" class:down={change?.startsWith('−')} class:muted={noTrade}>{change ?? '–'}</dd></div>
    </dl>
    <span class="bond">
      {#if graduated}<span class="chip">Graduated</span>
      {:else if coin.curveProgress === undefined}<span class="mono pc">–</span>
      {:else}<span class="bar"><CurveBar progress={coin.curveProgress} stage={coin.stage} compact /></span><span class="mono pc">{pct(coin.curveProgress)}</span>{/if}
    </span>
    {#if toGo !== null}<span class="togo">{#if toGo > 0n}<span class="mono">{zec(toGo, 2)} ZEC</span> to go{:else}curve full, graduating{/if}</span>{/if}
    <span class="badges">
      {#if first}<span class="chip">Coin #1</span>{/if}
      <span class="chip" title={feeTitle}>{feeChip(coin)}</span>
      <span class="chip" title="Of every trade, {holderPct}% is paid to this coin's holders in ZEC each round">pays holders {holderPct}% in ZEC</span>
      {#if shielded}<span class="chip" title="Holders of this coin have been paid shielded ZEC"><span class="key hatch" aria-hidden="true"></span>Shielded delivery</span>{/if}
    </span>
  </a>
{/if}

<style>
  .card {
    display: grid; gap: var(--s-2); align-content: start; padding: var(--s-3); border-radius: var(--r-md);
    text-decoration: none; color: inherit;
    transition: transform var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  @media (hover: hover) {
    .card:not(.preview):hover { transform: translateY(-2px); box-shadow: var(--sh-3); }
    .lrow:hover { background: var(--paper-2); transform: translateX(2px); }
  }
  .card:not(.preview):active { transform: translateY(1px); box-shadow: var(--sh-1); transition-duration: var(--d-press); }
  .card.preview { cursor: default; }
  .img { display: block; aspect-ratio: 1; border-radius: var(--r-sm); overflow: hidden; }
  .name { font-size: var(--t-16); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row2 { display: flex; justify-content: space-between; gap: var(--s-2); font-size: var(--t-14); color: var(--ink-2); }
  .nums { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2); margin: 0; }
  .nums dd { margin: 0; }
  .v { font-size: var(--t-16); font-weight: 500; }
  .down { color: var(--ink-2); }
  .usd, .where { display: block; font-size: var(--t-12); color: var(--ink-2); font-weight: 400; }
  .bond { display: flex; align-items: center; gap: var(--s-3); min-height: 20px; }
  .bar { flex: 1; min-width: 0; }
  .pc { font-size: var(--t-14); color: var(--ink-2); min-width: 4ch; text-align: right; }
  .togo { font-size: var(--t-12); color: var(--ink-2); margin-top: calc(-1 * var(--s-1)); }
  .togo .mono { color: var(--ink); }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .key { display: inline-block; width: 12px; height: 12px; border-radius: var(--r-xs); margin-right: var(--s-1); }

  .lrow {
    display: grid; grid-template-columns: minmax(0, 2.2fr) 1.1fr 1fr .7fr .7fr 1.3fr .6fr .7fr; gap: var(--s-4); align-items: center;
    padding: var(--s-3); border-bottom: 1px solid var(--line); border-radius: var(--r-sm); text-decoration: none; color: inherit;
    transition: background-color var(--d-fn) var(--ease), transform var(--d-fn) var(--ease);
  }
  .lrow:active { transform: translateX(0); background: var(--paper-3); transition-duration: var(--d-press); }
  .c-coin { display: flex; align-items: center; gap: var(--s-3); min-width: 0; }
  .c-name { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1) var(--s-2); min-width: 0; }
  .c-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sym { font-size: var(--t-14); color: var(--ink-2); }
  .num { text-align: right; }
  .age { font-size: var(--t-14); color: var(--ink-2); }
  @media (max-width: 800px) {
    .lrow { grid-template-columns: minmax(0, 2fr) 1fr 1.2fr; }
    .hide-md { display: none; }
  }
  @media (max-width: 640px) {
    /* on a phone the card is a row: the image at the left, the data beside it, so every label and chip keeps its full words */
    .card { grid-template-columns: 96px minmax(0, 1fr); gap: var(--s-1) var(--s-3); padding: var(--s-3); align-items: start; }
    .img { grid-row: 1 / span 3; width: 96px; }
    .nums { gap: var(--s-1) var(--s-3); }
    .v { font-size: var(--t-14); }
    .name, .row2, .nums, .bond, .togo, .badges { grid-column: 2; }
    .bond { margin-top: var(--s-1); }
  }
</style>
