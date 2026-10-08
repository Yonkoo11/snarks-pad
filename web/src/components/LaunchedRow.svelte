<script lang="ts">
  import { api } from '../lib/api'
  import type { CreatorFees, WalletCoin } from '../lib/types'
  import { zec, short, ago, feeChip } from '../lib/format'
  import { profileHref } from '../lib/profile'
  import { whenVisible } from '../lib/lazy'
  import CoinImage from './CoinImage.svelte'

  // One coin of the Launched tab: a link to the coin's page, its stage and fee, and, for a coin on a tier with a creator share, the creator fee waiting. The fee is a public chain
  // number the coin page already shows its creator (GET /coins/:mint/creator-fees, one chain read), so it is read only when the row first scrolls into view, never for every row on
  // arrival. Claiming stays on the coin page: the row links to it. `you` = the wallet connected is the one whose profile this is.
  let { coin, address, you }: { coin: WalletCoin; address: string; you: boolean } = $props()

  type Fees = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; fees: CreatorFees } | { state: 'error' }
  let fees = $state<Fees>({ state: 'idle' })
  async function loadFees() {
    fees = { state: 'loading' }
    try {
      fees = { state: 'ok', fees: await api.creatorFees(coin.mint) }
    } catch {
      fees = { state: 'error' }
    }
  }
  const onVisible = () => { if (coin.creatorShareBps > 0 && fees.state === 'idle') loadFees() }

  // Who receives the creator's share: the pool's creator on chain once it is read, else what the pad recorded at launch.
  const payee = $derived(fees.state === 'ok' ? fees.fees.creator : coin.creatorWallet)
  const waiting = $derived(fees.state === 'ok' ? BigInt(fees.fees.curveZats) + BigInt(fees.fees.poolZats) : 0n)
  const mineToClaim = $derived(you && payee === address)
</script>

<div class="row" use:whenVisible={onVisible}>
  <a class="main" href="#/coin/{coin.mint}">
    <CoinImage src={coin.imageUrl} symbol={coin.symbol} size={44} />
    <span class="names">
      <strong>{coin.name}</strong>
      <span class="meta muted"><span class="mono">${coin.symbol}</span>, launched {ago(coin.createdAt)}</span>
    </span>
    <span class="chips">
      {#if coin.stage === 'graduated'}<span class="chip">Graduated</span>{:else}<span class="chip">{feeChip({ feeBps: coin.feeBps, stage: 'curve' })}</span>{/if}
    </span>
  </a>

  {#if coin.creator !== address && coin.creatorWallet === address}
    <p class="note muted">Launched by <a class="mono" href={profileHref(coin.creator)} title={coin.creator}>{short(coin.creator)}</a>. Its creator fees go to this wallet.</p>
  {/if}

  {#if coin.creatorShareBps > 0}
    <div class="fees">
      {#if fees.state === 'ok' && payee !== address}
        <p class="note muted">Creator fees go to <a class="mono" href={profileHref(payee)} title={payee}>{short(payee)}</a>.</p>
      {:else if fees.state === 'ok'}
        {#if waiting > 0n}
          <p class="note">Creator fees waiting: <span class="mono">{zec(waiting, 4)} ZEC</span>{#if mineToClaim}{' '}<a class="claim" href="#/coin/{coin.mint}">Claim on the coin page</a>{/if}</p>
        {:else}
          <p class="note muted">Nothing waiting. {you ? 'Your' : 'The creator\'s'} share builds with every trade.</p>
        {/if}
      {:else if fees.state === 'error'}
        <p class="note"><span class="muted">Could not read the creator fees.</span> <button class="again" type="button" onclick={loadFees}>Try again</button></p>
      {:else}
        <p class="note muted" aria-busy={fees.state === 'loading'}>Reading the creator fees…</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .row { display: grid; gap: var(--s-1); padding: var(--s-3) var(--s-2); border-bottom: 1px solid var(--line); }
  .main {
    display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: var(--s-3); align-items: center; min-height: 56px; color: inherit; text-decoration: none; border-radius: var(--r-sm);
    transition: transform var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .main:hover { transform: translateX(2px); } }
  .names { display: grid; min-width: 0; }
  .names strong { font-size: var(--t-16); overflow-wrap: anywhere; }
  .meta { font-size: var(--t-14); }
  .chips { display: flex; gap: var(--s-1); flex-wrap: wrap; justify-content: flex-end; }
  .note { font-size: var(--t-14); padding-left: calc(44px + var(--s-3)); overflow-wrap: anywhere; }
  .note a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); font-weight: 700; }
  /* the claim link wraps as one piece, and is a 44px target without making the row taller */
  .note .claim { display: inline-flex; align-items: center; min-height: 44px; margin: -12px 0; white-space: nowrap; }
  .again { font: inherit; font-weight: 700; color: var(--ink); background: none; border: 0; padding: 0; min-height: 44px; margin: -12px 0; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  @media (max-width: 640px) {
    .main { grid-template-columns: 44px minmax(0, 1fr); }
    .chips { grid-column: 2; justify-content: flex-start; }
    .note { padding-left: 0; }
  }
</style>
