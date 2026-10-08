<script lang="ts">
  import type { CoinDetail, Epoch, PadMode, Pot, Treasury } from '../lib/types'
  import { zec, usdOfZats, ago, countdown } from '../lib/format'
  import { solanaTxUrl, zcashTxUrl } from '../lib/explorer'
  import Addr from './Addr.svelte'

  // The Rewards tab: the pot the pool has accrued for this coin and the holders' part of it (contract v2.6 GET /coins/:mint/pot),
  // the countdown, the last round that paid this coin's holders with its public ids, and the running total. `pot` is undefined
  // while loading and null on an engine without the route: those tiles are dashes, never 0.
  let { coin, pot, epochs, treasury, mode, now, rate }: { coin: CoinDetail; pot: Pot | null | undefined; epochs: Epoch[] | null; treasury: Treasury | null; mode: PadMode | null; now: number; rate: number | null } = $props()

  const nextAt = $derived(pot?.nextPayoutAt !== undefined && pot !== null ? pot.nextPayoutAt : treasury ? treasury.nextEpochAt : null)
  const nextDue = $derived(nextAt !== null && Date.parse(nextAt) - now <= 0)
  const lastRound = $derived(epochs && pot?.lastPayout ? epochs.find((e) => e.id === pot!.lastPayout!.epochId) ?? null : epochs ? epochs.find((e) => e.coinMints.includes(coin.mint)) ?? null : null)
  const paidSol = $derived(BigInt(coin.rewards.paidSolanaZec))
  const paidShd = $derived(BigInt(coin.rewards.paidShieldedZec))
  const shdShare = $derived(paidSol + paidShd > 0n ? Number((paidShd * 1000n) / (paidSol + paidShd)) / 1000 : 0)
  const zNet = $derived(treasury?.zcashNetwork ?? null)
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
</script>

<div class="rw">
  <dl class="tiles">
    <div><dt class="label">Pot so far</dt>{#if pot === undefined}<dd class="skel tile-sk" aria-busy="true"></dd>{:else}<dd class="mono v">{pot ? `${zec(pot.accruedZats)} ZEC` : '–'}</dd>{#if pot && usdOfZats(pot.accruedZats, rate)}<dd class="mono usd">{usdOfZats(pot.accruedZats, rate)}</dd>{/if}{/if}</div>
    <div><dt class="label">Of it to holders</dt>{#if pot === undefined}<dd class="skel tile-sk" aria-busy="true"></dd>{:else}<dd class="mono v">{pot ? `${zec(pot.holdersZats)} ZEC` : '–'}</dd><dd class="usd">{coin.holderShareBps / 100}% of each trade, paid in ZEC</dd>{/if}</div>
    <div><dt class="label">Next payout</dt><dd class="v">{#if nextAt === null}<span class="muted">not scheduled yet</span>{:else if nextDue}running now{:else}in <span class="mono">{countdown(nextAt, now)}</span>{/if}</dd><dd class="usd">paid in ZEC each round</dd></div>
    <div><dt class="label">Paid so far</dt><dd class="mono v">{zec(paidSol + paidShd)} ZEC</dd><dd class="usd">over {coin.rewards.epochs} {coin.rewards.epochs === 1 ? 'round' : 'rounds'}</dd></div>
  </dl>
  <p class="muted note">Holders are paid from this pot each round, by how much they held during the round.</p>

  <section class="last" aria-labelledby="last-h">
    <h3 class="h3" id="last-h">Last payout</h3>
    {#if pot === undefined || epochs === null}
      <div class="skel" style="height: 72px" aria-busy="true" aria-label="Loading the last payout"></div>
    {:else if !lastRound}
      <p class="muted">No round has paid this coin's holders yet.</p>
    {:else}
      <p>{when(lastRound.at)} ({ago(lastRound.at, now)}).{#if pot?.lastPayout}{' '}This coin's holders were paid <span class="mono">{zec(pot.lastPayout.totalZats)} ZEC</span>, <span class="mono">{zec(pot.lastPayout.shieldedZats)} ZEC</span> of it the shielded way.{/if} The round claimed <span class="mono">{zec(lastRound.harvestedZats)} ZEC</span> from {lastRound.coinMints.length} {lastRound.coinMints.length === 1 ? 'coin' : 'coins'}.</p>
      <div class="legs">
        <p class="leg"><span class="label">Solana ZEC</span> <span class="mono">{zec(lastRound.solanaPayouts.totalZats)} ZEC</span> to {lastRound.solanaPayouts.count} wallets
          {#each lastRound.solanaPayouts.sigs as s (s)}<Addr value={s} head={6} tail={4} href={solanaTxUrl(s, mode)} label="Solana signature" />{/each}</p>
        <p class="leg shd"><span class="label">Shielded</span>
          {#if lastRound.shielded.count === 0}<span class="muted">none this round{lastRound.status === 'fallback_solana' ? ': the swap did not complete, so shielded holders were paid Solana ZEC' : ''}</span>
          {:else}<span class="mono">{zec(lastRound.shielded.totalZats)} ZEC</span> to {lastRound.shielded.count} addresses in one transaction
            {#each lastRound.shielded.zcashTxids as z (z)}<Addr value={z} head={8} tail={6} href={zcashTxUrl(z, zNet)} label="Zcash transaction id" />{/each}
            {#if lastRound.shielded.swap.provider === 'simulated'}<span class="chip sim">simulated</span>{/if}{/if}</p>
      </div>
    {/if}
  </section>

  <section class="split-sec" aria-labelledby="paid-h">
    <h3 class="h3" id="paid-h">Paid to holders so far</h3>
    <div class="split" aria-hidden="true">
      <span class="sol" style:flex-grow={1 - shdShare}></span>
      <span class="shd-seg hatch" style:flex-grow={shdShare || 0.0001}></span>
    </div>
    <dl class="legend">
      <div><dt><span class="key sol-k" aria-hidden="true"></span>As Solana ZEC</dt><dd class="mono">{zec(paidSol)} ZEC</dd></div>
      <div><dt><span class="key hatch" aria-hidden="true"></span>As shielded ZEC</dt><dd class="mono">{zec(paidShd)} ZEC</dd></div>
    </dl>
  </section>
</div>

<style>
  .rw { display: grid; gap: var(--s-5); }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-4); margin: 0; }
  .tiles dd { margin: var(--s-1) 0 0; }
  .v { font-size: var(--t-20); font-weight: 500; }
  .tile-sk { height: 30px; width: 7ch; }
  .usd { font-size: var(--t-14); color: var(--ink-2); font-weight: 400; margin-top: 0 !important; }
  .note { font-size: var(--t-16); max-width: 66ch; }
  .last, .split-sec { display: grid; gap: var(--s-2); }
  .legs { display: grid; gap: var(--s-2); font-size: var(--t-14); }
  .leg { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); align-items: center; }
  .leg .label { margin-right: var(--s-1); }
  .shd { position: relative; padding-left: calc(var(--s-3) + 8px); }
  /* hatching marks what is shielded (the device) */
  .shd::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 8px; border-radius: var(--r-xs); background: repeating-linear-gradient(-55deg, var(--pink) 0 3px, transparent 3px 6px), var(--pink-soft); }
  .split { display: flex; height: 12px; gap: 2px; margin-top: var(--s-1); }
  .split > span { flex-basis: 0; border-radius: var(--r-xs); min-width: 4px; }
  .sol, .sol-k { background: var(--ink); }
  .legend { display: grid; grid-template-columns: repeat(2, auto); justify-content: start; gap: var(--s-6); margin: 0; }
  .legend dt { display: flex; align-items: center; gap: var(--s-2); font-size: var(--t-14); color: var(--ink-2); }
  .legend dd { margin: var(--s-1) 0 0; font-size: var(--t-20); font-weight: 500; }
  .key { width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }
  @media (max-width: 760px) { .tiles { grid-template-columns: 1fr 1fr; } .v { font-size: var(--t-16); } }
</style>
