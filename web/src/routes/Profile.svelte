<script lang="ts">
  import { api, onMode } from '../lib/api'
  import type { PadMode, WalletProfile } from '../lib/types'
  import { wallet } from '../lib/wallet.svelte'
  import { router } from '../lib/router.svelte'
  import { short } from '../lib/format'
  import { solscanAccountUrl } from '../lib/explorer'
  import { isWalletAddress, profileHref, tabFor, TAB_LABELS, visibleTabs, type ProfileTab } from '../lib/profile'
  import WalletMark from '../components/WalletMark.svelte'
  import Addr from '../components/Addr.svelte'
  import ProfileHoldings from '../components/ProfileHoldings.svelte'
  import ProfileLaunched from '../components/ProfileLaunched.svelte'
  import ProfileTrades from '../components/ProfileTrades.svelte'
  import ProfileShielded from '../components/ProfileShielded.svelte'
  import MyRewards from '../components/MyRewards.svelte'

  // A wallet's profile, #/u/<wallet>. Anyone sees what is public on chain or recorded by the pad: the coins it holds (read in the browser), the coins it launched with the creator fees
  // waiting, and its trades on this pad (GET /wallets/:wallet, the engine's database only). The wallet's owner also sees what the pad paid it and its shielded delivery, and nobody
  // else sees any of that: whether a wallet opted in is private (contract v2.9), so those two tabs ask the owner for one signature before they show it.
  let { address: given, tab: asked }: { address: string; tab: ProfileTab | null } = $props()
  // Choosing a tab rewrites the page address, which hands this page a new route object with the same wallet. Reading the wallet through a derived value means what depends on it
  // (the data loads) runs again only when the wallet itself changed, not on every tab click.
  const address = $derived(given)
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => (mode = m)))

  const valid = $derived(isWalletAddress(address))
  const you = $derived(wallet.address === address)
  const tabs = $derived(visibleTabs(you))
  // what is shown: the tab the address asks for if this viewer may see it, else Holdings (a visitor asking for Rewards, or the owner's wallet disconnected while Rewards was open)
  const current = $derived(tabFor(asked, you))
  $effect(() => { document.title = `${you ? 'Your profile' : `Profile ${short(address)}`}, SNARKS pad` })

  let profile = $state<WalletProfile | null>(null)
  let loadErr = $state(false)
  let asks = 0
  async function load() {
    const mine = ++asks
    loadErr = false
    try {
      const p = await api.wallet(address)
      if (mine === asks) profile = p
    } catch {
      if (mine === asks) { profile = null; loadErr = true }
    }
  }
  $effect(() => { void address; profile = null; if (valid) load() })

  /** A tab was chosen: rewrite the address (no history entry, no jump to the top) and tell the router, so the route and the tab stay one thing. */
  function select(t: ProfileTab) {
    history.replaceState(null, '', profileHref(address, t))
    router.sync()
  }
  /** Arrow keys, Home and End move between the tabs (the tab list is one tab stop). */
  function onTabKey(e: KeyboardEvent) {
    const i = tabs.indexOf(current)
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    e.preventDefault()
    select(tabs[next])
    document.getElementById(`ptab-${tabs[next]}`)?.focus()
  }
  // The chosen tab can be out of sight in a strip that scrolls (a link to ?tab=rewards on a phone): the strip moves to show it, never the page.
  let strip = $state<HTMLDivElement>()
  $effect(() => {
    const el = strip?.querySelector<HTMLElement>(`#ptab-${current}`)
    if (!strip || !el) return
    const a = el.getBoundingClientRect()
    const b = strip.getBoundingClientRect()
    if (a.left < b.left) strip.scrollLeft -= b.left - a.left + 8
    else if (a.right > b.right) strip.scrollLeft += a.right - b.right + 8
  })
  const firstSeen = $derived(profile?.firstSeenAt ? new Date(profile.firstSeenAt).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : null)
  const solscan = $derived(solscanAccountUrl(address, mode))
</script>

{#if !valid}
  <section class="wrap pad bad">
    <h1 class="display">That is not a Solana wallet address.</h1>
    <p class="muted measure">The link may be mistyped.</p>
    <a class="btn" href="#/">See the coins</a>
  </section>
{:else}
  <section class="wrap pad">
    <header class="head">
      <WalletMark {address} size={56} />
      <div class="who">
        <h1 class="display">{you ? 'Your profile' : 'Wallet profile'}</h1>
        <div class="line">
          <Addr value={address} head={6} tail={6} label="wallet address" />
          <span class="chip">{you ? 'You' : 'Watch-only'}</span>
          {#if solscan}<a class="ext" href={solscan} target="_blank" rel="noopener noreferrer">View on Solscan<span aria-hidden="true"> ↗</span></a>{/if}
        </div>
        {#if firstSeen}<p class="muted seen">First seen on the pad {firstSeen}.</p>{/if}
      </div>
    </header>

    <div class="tabs">
      <div class="seg" role="tablist" aria-label="Profile sections" bind:this={strip}>
        {#each tabs as t (t)}
          <button type="button" role="tab" id="ptab-{t}" aria-selected={current === t} aria-controls="ppanel" tabindex={current === t ? 0 : -1} class:on={current === t} onclick={() => select(t)} onkeydown={onTabKey}>
            {TAB_LABELS[t]}{#if t === 'launched' && profile && profile.launched.length > 0}<span class="cnt mono">{profile.launched.length}</span>{/if}
          </button>
        {/each}
      </div>
    </div>

    <div class="body" role="tabpanel" id="ppanel" aria-labelledby="ptab-{current}">
      {#if current === 'holdings'}
        <ProfileHoldings {address} {you} />
      {:else if current === 'rewards'}
        <MyRewards wallet={address} verify={false} />
      {:else if current === 'shielded'}
        <ProfileShielded {address} />
      {:else if loadErr}
        <div class="state"><p class="error">Could not load this wallet.</p><button class="btn" type="button" onclick={load}>Try again</button></div>
      {:else if profile === null}
        <div class="skel sk" aria-busy="true" aria-label="Loading this wallet"></div>
      {:else if current === 'launched'}
        <ProfileLaunched coins={profile.launched} {address} {you} />
      {:else}
        <ProfileTrades trades={profile.trades} {you} {mode} />
      {/if}
    </div>
  </section>
{/if}

<style>
  .pad { padding-top: var(--s-6); display: grid; gap: var(--s-5); }
  .bad { padding-top: var(--s-8); justify-items: start; }
  .head { display: flex; gap: var(--s-4); align-items: center; }
  .who { display: grid; gap: var(--s-1); min-width: 0; }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
  .ext { color: var(--ink); font-size: var(--t-14); font-weight: 700; text-underline-offset: 3px; text-decoration-color: var(--ink-3); min-height: 44px; display: inline-flex; align-items: center; margin: -12px 0; }
  .seen { font-size: var(--t-14); }
  /* the tabs scroll sideways on a phone instead of wrapping or widening the page */
  .tabs { min-width: 0; }
  .seg { width: max-content; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .seg::-webkit-scrollbar { display: none; }
  .seg > button { display: inline-flex; align-items: center; gap: var(--s-2); white-space: nowrap; flex: none; }
  .cnt { font-size: var(--t-12); font-weight: 500; color: var(--ink-2); }
  .body { min-height: 160px; min-width: 0; }
  .state { display: grid; gap: var(--s-3); justify-items: start; }
  .sk { height: 200px; }
  @media (max-width: 640px) {
    .pad { padding-top: var(--s-4); gap: var(--s-4); }
    .head { gap: var(--s-3); align-items: flex-start; }
    .seg { width: 100%; }
  }
</style>
