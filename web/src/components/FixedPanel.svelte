<script lang="ts">
  import type { Coin, Fixed, PadMode } from '../lib/types'
  import { feeLabel, zecRounded } from '../lib/format'
  import { solscanAccountUrl } from '../lib/explorer'
  import { fixedWindowText } from '../lib/window'

  // "Token info" (contract v2.6 GET /coins/:mint/fixed): what nobody can change about this coin, one line each, with a link to the account it was read
  // from (research/COPY-AUDIT.md, 2026-10-07: the long version named internal mechanics; those now live on How it works and in the Terms). The page
  // loads the object once (Coin.svelte) and hands it here: undefined while loading, null on an engine without the route, which gets the facts the
  // coin's own record states. The words are the web's; every number and address is the engine's.
  let { fixed, coin, mode, err = false, onretry }: { fixed: Fixed | null | undefined; coin: Coin; mode: PadMode | null; err?: boolean; onretry?: () => void } = $props()

  interface Fact { id: string; label: string; value: string; address?: string | null; warn?: boolean }
  const pctText = (bps: number) => `${bps / 100}%`
  const creatorText = (bps: number) => (bps === 0 ? 'None.' : `${pctText(bps)} of the fee, to the creator's own wallet.`)
  const facts = $derived.by<Fact[]>(() => {
    if (!fixed) return []
    const f = fixed
    const grad = coin.stage === 'graduated'
    const auth = f.tokenAuthorities
    const locked = Math.round((f.liquidity.partnerLockedPct + f.liquidity.creatorLockedPct) * 100) / 100
    return [
      { id: 'curve_fee', label: 'Trading fee', value: `${pctText(f.curveFee.bps)} on the bonding curve${f.launchWindow ? ' once the launch window has closed' : ''}, fixed at launch.`, address: f.curveFee.source },
      ...(f.launchWindow ? [{ id: 'launch_window', label: 'Launch window', value: fixedWindowText(f.launchWindow), address: f.launchWindow.source }] : []),
      { id: 'creator_share', label: 'Creator fee', value: creatorText(f.creatorShare.bps), address: f.creatorShare.source },
      { id: 'migration', label: 'Graduation', value: `Once it has raised ${zecRounded(f.migration.thresholdZats, 2)} ZEC${grad ? ', which it has' : ''}.`, address: f.migration.source },
      { id: 'graduated_fee', label: 'Fee after graduation', value: `The Meteora pool charges ${pctText(f.graduatedFee.minBps)}, rising to about ${pctText(f.graduatedFee.maxBps)} when trading is volatile. Meteora can pause that pool or change its fee.`, address: f.graduatedFee.source },
      { id: 'mint_authority', label: 'Mint authority', value: auth.mintAuthority === null ? 'None. No new coins can be minted.' : grad ? 'Still held: more coins could be minted.' : 'Held by the bonding curve until graduation.', address: auth.mintAuthority ?? auth.source, warn: auth.mintAuthority !== null && grad },
      { id: 'freeze_authority', label: 'Freeze authority', value: auth.freezeAuthority === null ? 'None.' : 'Held: wallets could be frozen.', address: auth.freezeAuthority ?? auth.source, warn: auth.freezeAuthority !== null },
      { id: 'update_authority', label: 'Name and image', value: auth.updateAuthority === null ? 'Fixed for good.' : 'Can still be changed.', address: auth.updateAuthority ?? auth.source, warn: auth.updateAuthority !== null },
      { id: 'liquidity', label: 'Liquidity after graduation', value: f.liquidity.unlockedPct > 0 ? `${locked}% locked for good; ${f.liquidity.unlockedPct}% could be withdrawn.` : 'Locked for good.', address: f.liquidity.source, warn: f.liquidity.unlockedPct > 0 },
    ]
  })
  // an engine without the route: the facts the coin's own record states
  const own = $derived<Fact[]>([
    { id: 'curve_fee', label: 'Trading fee', value: `${feeLabel({ feeBps: coin.feeBps, stage: 'curve' })}, fixed at launch.` },
    { id: 'creator_share', label: 'Creator fee', value: creatorText(coin.creatorShareBps) },
  ])
  const shown = $derived(fixed ? facts : fixed === null ? own : [])
</script>

<div class="fixed">
  {#if err}
    <div class="state"><p class="error">Could not load these facts from the pad.</p>{#if onretry}<button class="btn" type="button" onclick={onretry}>Try again</button>{/if}</div>
  {:else if fixed === undefined}
    <div class="skel sk" aria-busy="true" aria-label="Loading the token info"></div>
  {:else}
    <ul class="facts">
      {#each shown as f (f.id)}
        {@const url = f.address ? solscanAccountUrl(f.address, mode) : null}
        <li class:no={f.warn}>
          <span class="mark mono" aria-hidden="true">{f.warn ? '!' : '✓'}</span>
          <p class="body"><strong>{f.label}:</strong> {f.value}{#if url}{' '}<a class="verify" href={url} target="_blank" rel="noopener noreferrer" aria-label="Verify {f.label.toLowerCase()} on Solscan">Verify<span aria-hidden="true"> ↗</span></a>{/if}</p>
        </li>
      {/each}
    </ul>
    {#if fixed?.launchWindow?.firstSwapAtEndFee}
      <p class="neg muted">There is no whitelist and there are no paid placements on this pad.</p>
    {:else}
      <p class="neg muted">There are no snipe exemptions, no whitelist and no paid placements on this pad.</p>
    {/if}
    {#if fixed === null}<p class="muted small">Read from this coin's record. The chain checks are not available on this pad's engine yet.</p>{/if}
  {/if}
</div>

<style>
  .fixed { display: grid; gap: var(--s-4); }
  .sk { height: 320px; }
  .state { display: grid; gap: var(--s-3); justify-items: start; }
  .facts { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-3); }
  li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--s-3); align-items: start; }
  .mark { width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--r-full); background: var(--ink); color: var(--paper); font-weight: 500; }
  li.no .mark { background: var(--bad); }
  .body { padding-top: 3px; font-size: var(--t-16); max-width: 66ch; }
  .neg { font-size: var(--t-14); max-width: 66ch; }
  .verify { font-size: var(--t-14); color: var(--ink-2); text-underline-offset: 3px; text-decoration-color: var(--ink-3); white-space: nowrap; }
</style>
