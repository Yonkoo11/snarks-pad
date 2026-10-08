<script lang="ts">
  import type { WalletCoin } from '../lib/types'
  import LaunchedRow from './LaunchedRow.svelte'

  // The Launched tab: the coins this wallet launched (GET /wallets/:wallet), newest first, and below them, apart, the coins another wallet launched and
  // named this one to receive the creator fees of: a name typed by the launcher, not this wallet's doing, so it is never listed as "launched" here
  // (audit S6, product decision 3). `you` = the wallet connected is the one whose profile this is.
  let { coins, address, you }: { coins: WalletCoin[]; address: string; you: boolean } = $props()
  const launched = $derived(coins.filter((c) => c.creator === address))
  const named = $derived(coins.filter((c) => c.creator !== address && c.creatorWallet === address))
</script>

{#if launched.length === 0}
  <div class="state">
    <p class="muted">{you ? 'You have not launched a coin.' : 'This wallet has not launched a coin here.'}</p>
    {#if you}<a class="btn primary" href="#/launch">Launch a coin</a>{/if}
  </div>
{:else}
  <div class="list">
    {#each launched as c (c.mint)}<LaunchedRow coin={c} {address} {you} />{/each}
  </div>
{/if}

{#if named.length > 0}
  <h3 class="named">Named to receive creator fees</h3>
  <p class="muted small">Launched by someone else, who named this wallet for the creator fees. {you ? 'You did not sign for this.' : 'This wallet did not sign for it.'}</p>
  <div class="list">
    {#each named as c (c.mint)}<LaunchedRow coin={c} {address} {you} />{/each}
  </div>
{/if}

<style>
  .state { display: grid; gap: var(--s-3); justify-items: start; }
  .list { display: grid; }
  .named { margin-top: var(--s-5); margin-bottom: 0; }
  .small { margin-top: var(--s-1); }
</style>
