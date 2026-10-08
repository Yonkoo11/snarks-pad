<script lang="ts">
  import type { PadMode, WalletTrade } from '../lib/types'
  import { zec, tokens, ago } from '../lib/format'
  import { solanaTxUrl } from '../lib/explorer'

  // The Trades tab: the wallet's newest recorded trades on this pad (GET /wallets/:wallet, at most 50). Only trades made through this pad's own page are recorded, so the tab
  // says so: a trade made anywhere else is not here. Each row links to its coin and, where an explorer shows the chain, to the transaction.
  let { trades, you, mode }: { trades: WalletTrade[]; you: boolean; mode: PadMode | null } = $props()
</script>

{#if trades.length === 0}
  <div class="state">
    <p class="muted">{you ? 'You have not' : 'This wallet has not'} traded on SNARKS pad yet.</p>
    <p class="muted note">Only trades made through this pad's page are listed here.</p>
  </div>
{:else}
  <div class="rows">
    {#each trades as t (t.sig)}
      <div class="row">
        <span class="side caps {t.side}">{t.side}</span>
        <span class="mono amt">{zec(t.amountZec)} ZEC</span>
        <a class="coin" href="#/coin/{t.mint}"><span class="mono">{tokens(t.amountToken)}</span> <span class="mono">${t.symbol}</span></a>
        <span class="muted when">{ago(t.at)}</span>
        {#if solanaTxUrl(t.sig, mode)}<a class="tx" href={solanaTxUrl(t.sig, mode)} target="_blank" rel="noopener noreferrer" aria-label="This trade on the Solana explorer" title={t.sig}>↗</a>{:else}<span class="tx" aria-hidden="true"></span>{/if}
      </div>
    {/each}
  </div>
  <p class="muted note">{you ? 'Your' : "This wallet's"} trades made through this pad's page{trades.length === 50 ? ', the newest 50' : ''}. A trade made anywhere else is not listed.</p>
{/if}

<style>
  .rows { display: grid; }
  .state { display: grid; gap: var(--s-2); }
  .row {
    display: grid; grid-template-columns: 48px minmax(7rem, 10rem) minmax(0, 1fr) auto 44px; gap: var(--s-3); align-items: center; min-height: 52px;
    padding: var(--s-1) 0; border-bottom: 1px solid var(--line); font-size: var(--t-14);
  }
  .side { font-weight: 700; font-size: var(--t-12); letter-spacing: .06em; }
  .side.sell { color: var(--ink-3); }
  /* a 44px target without a taller row: the padding is the hit area, the negative margin gives the room back */
  .coin { display: block; width: fit-content; justify-self: start; padding: 12px 0; margin: -12px 0; color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); overflow-wrap: anywhere; }
  .when { text-align: right; white-space: nowrap; }
  .tx { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; margin: -12px 0; color: var(--ink-2); text-decoration: none; border-radius: var(--r-xs); }
  @media (hover: hover) { a.tx:hover { color: var(--ink); } }
  .note { font-size: var(--t-14); max-width: 66ch; }
  .rows + .note { margin-top: var(--s-3); }
  /* on a phone a row takes two lines: side, amount and age on the first, the coin on the second; the transaction link spans both */
  @media (max-width: 640px) {
    .row { grid-template-columns: 40px minmax(0, 1fr) auto 44px; grid-template-areas: 'side amt when tx' 'side coin coin tx'; row-gap: 2px; }
    .side { grid-area: side; }
    .amt { grid-area: amt; white-space: nowrap; }
    .coin { grid-area: coin; }
    .when { grid-area: when; }
    .tx { grid-area: tx; }
  }
</style>
