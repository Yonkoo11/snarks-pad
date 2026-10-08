<script lang="ts">
  import { tick } from 'svelte'
  import { wallet, walletOptions } from '../lib/wallet.svelte'
  import { short } from '../lib/format'
  import { api, onMode } from '../lib/api'
  import { solscanAccountUrl } from '../lib/explorer'
  import { profileHref } from '../lib/profile'
  import { router } from '../lib/router.svelte'
  import type { PadMode } from '../lib/types'

  // Not connected: a button that opens the list of wallets to connect. Connected: the wallet's address, which opens its menu (a real menu: arrow keys, Home and End move between
  // the items, Escape closes it and returns to the button): who is connected with Copy (the first item, so it is a keyboard action too), then View my profile, Rewards, Shielded
  // delivery, My coins (only for a wallet that has launched a coin), View on Solscan and Disconnect. No amounts: a menu is read over a shoulder, and what a wallet was paid is the
  // profile's to show.
  let { primary = false, label = 'Connect wallet' }: { primary?: boolean; label?: string } = $props()
  const menuId = $props.id()
  let open = $state(false)
  // a page change closes the menu, whatever caused it (a menu item, a link elsewhere, the back button)
  $effect(() => { void router.route; open = false })
  let allowTest = $state(false)
  let mode = $state<PadMode | null>(null)
  $effect(() => onMode((m) => { mode = m; allowTest = m !== 'mainnet' }))
  const opts = $derived(open ? walletOptions(allowTest) : [])
  let root: HTMLDivElement
  let trigger = $state<HTMLButtonElement>()
  let menu = $state<HTMLDivElement>()
  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  // "My coins" is in the menu only for a wallet that launched one: the profile's data is one light read of the engine's database, taken when the wallet connects and again each
  // time the menu opens (a coin launched since then shows up). A failed read leaves the item as it was; a menu must not add an error of its own.
  let launched = $state(0)
  function readLaunched(a: string) {
    api.wallet(a).then((p) => { if (wallet.address === a) launched = p.launched.length }, () => {})
  }
  $effect(() => {
    const a = wallet.address
    launched = 0
    if (a) readLaunched(a)
  })

  interface Item { label: string; href: string; external?: boolean; shielded?: boolean }
  const items = $derived.by((): Item[] => {
    const a = wallet.address
    if (!a) return []
    const scan = solscanAccountUrl(a, mode)
    return [
      { label: 'View my profile', href: profileHref(a) },
      { label: 'Rewards', href: profileHref(a, 'rewards') },
      { label: 'Shielded delivery', href: '#/shielded', shielded: true },
      ...(launched > 0 ? [{ label: 'My coins', href: profileHref(a, 'launched') }] : []),
      ...(scan ? [{ label: 'View on Solscan', href: scan, external: true }] : []),
    ]
  })

  const itemEls = (): HTMLElement[] => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  function focusItem(i: number) {
    const els = itemEls()
    els[(i + els.length) % els.length]?.focus()
  }
  async function openMenu(focus: 'first' | 'last' | null) {
    open = true
    if (wallet.address) readLaunched(wallet.address)
    if (!focus) return
    await tick()
    focusItem(focus === 'first' ? 0 : -1)
  }
  function closeMenu(returnFocus = true) {
    open = false
    if (returnFocus) trigger?.focus()
  }
  function onTriggerKey(e: KeyboardEvent) {
    if (!wallet.address || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    e.preventDefault()
    openMenu(e.key === 'ArrowDown' ? 'first' : 'last')
  }
  function onMenuKey(e: KeyboardEvent) {
    const here = itemEls().indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(here + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(here - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0) }
    else if (e.key === 'End') { e.preventDefault(); focusItem(-1) }
    else if (e.key === 'Tab') closeMenu() // focus goes to the button first, so Tab moves on from it
    else if (e.key === ' ' && document.activeElement instanceof HTMLAnchorElement) { e.preventDefault(); document.activeElement.click() } // a menu item answers Space as well as Enter
  }
  function onDoc(e: MouseEvent) { if (open && root && !root.contains(e.target as Node)) open = false }
  /** Focus moved to another element on the page (Tab, or a click on a control): the menu closes. A click on plain text inside the menu moves it to nothing, and the menu stays. */
  function onFocusOut(e: FocusEvent) { if (open && e.relatedTarget && !root.contains(e.relatedTarget as Node)) open = false }

  async function pick(id: string) {
    await wallet.connect(id)
    if (!wallet.address) return
    open = false
    await tick()
    trigger?.focus() // the button that was here is gone: the focus goes to the one that shows the address
  }
  async function disconnect() {
    await wallet.disconnect()
    open = false
    await tick()
    trigger?.focus()
  }
  async function copyAddress() {
    if (!wallet.address) return
    try { await navigator.clipboard.writeText(wallet.address); copied = true } catch { copied = false }
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied = false), 1600)
  }
</script>

<svelte:document onmousedown={onDoc} onkeydown={(e) => { if (e.key === 'Escape' && open) closeMenu() }} />

<!-- every button here is type="button": the wallet button sits inside forms (Launch, Shielded), and a button without a type submits the form it is in, which showed the form's errors before anything was typed -->
<div class="wb" bind:this={root} onfocusout={onFocusOut}>
  {#if wallet.address}
    <button class="btn ghost addr" type="button" bind:this={trigger} onclick={() => (open ? closeMenu(false) : openMenu('first'))} onkeydown={onTriggerKey} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}>
      <span class="dot" aria-hidden="true"></span><span class="mono">{short(wallet.address)}</span>
    </button>
    {#if open}
      <div class="menu panel">
        <div class="items" id={menuId} role="menu" aria-label="Connected wallet {short(wallet.address, 6, 6)}" tabindex="-1" bind:this={menu} onkeydown={onMenuKey}>
          <div class="who" role="none">
            <p class="label">Connected with {wallet.kind === 'test' ? 'the test wallet' : wallet.kind}</p>
            <div class="idrow">
              <span class="mono" title={wallet.address}>{short(wallet.address, 6, 6)}</span>
              <button class="copy caps" role="menuitem" tabindex="-1" type="button" onclick={copyAddress} aria-label="Copy the wallet address">{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
          {#each items as it (it.label)}
            <a class="item" role="menuitem" tabindex="-1" href={it.href} target={it.external ? '_blank' : undefined} rel={it.external ? 'noopener noreferrer' : undefined} onclick={() => closeMenu()}>
              {#if it.shielded}<span class="key hatch" aria-hidden="true"></span>{/if}{it.label}{#if it.external}<span aria-hidden="true"> ↗</span>{/if}
            </a>
          {/each}
          <button class="item out" role="menuitem" tabindex="-1" type="button" onclick={disconnect}>Disconnect</button>
        </div>
        <span class="live" role="status">{copied ? 'Wallet address copied' : ''}</span>
      </div>
    {/if}
  {:else}
    <button class="btn" class:primary type="button" bind:this={trigger} onclick={() => (open = !open)} aria-haspopup="true" aria-expanded={open} disabled={wallet.busy}>
      {wallet.busy ? 'Waiting for wallet…' : label}
    </button>
    {#if open}
      <div class="menu panel">
        <p class="label">Solana wallet</p>
        {#each opts as o (o.id)}
          {#if o.installed}
            <button class="btn block opt" type="button" onclick={() => pick(o.id)}>{o.name}</button>
          {:else}
            <a class="btn ghost block opt" href={o.url} target="_blank" rel="noreferrer">Get {o.name}</a>
          {/if}
        {/each}
        {#if wallet.error}<p class="error">{wallet.error}</p>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .wb { position: relative; }
  .addr { gap: var(--s-2); }
  .dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--ink); }
  .menu {
    position: absolute; right: 0; top: calc(100% + var(--s-2)); z-index: 20;
    width: min(300px, calc(100vw - 32px)); display: grid; gap: var(--s-2); padding: var(--s-4);
  }
  .who { display: grid; padding: var(--s-2) var(--s-3) var(--s-1); margin-bottom: var(--s-2); border-radius: var(--r-sm); background: var(--paper-3); }
  /* the row is as tall as Copy's 44px target, so the focus ring of Copy sits inside the block and never over the label above it */
  .idrow { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); min-height: 44px; font-size: var(--t-14); color: var(--ink-2); }
  .copy {
    font: inherit; font-size: var(--t-12); font-weight: 700; letter-spacing: .04em; color: var(--ink-2); background: none; border: 0; cursor: pointer;
    padding: 0 var(--s-2); min-height: 44px; min-width: 44px; border-radius: var(--r-xs);
    transition: color var(--d-fn) var(--ease), transform var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .copy:hover { color: var(--ink); transform: translateY(-1px); } }
  /* said to a screen reader when Copy is used (the button's own word changes on screen only); nothing to see */
  .live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .items { display: grid; gap: 2px; }
  .items:focus { outline: none; }
  .item {
    display: flex; align-items: center; gap: var(--s-2); min-height: 44px; padding: 0 var(--s-3); border: 0; border-radius: var(--r-sm); background: none; width: 100%;
    font: inherit; font-weight: 700; color: var(--ink); text-align: left; text-decoration: none; cursor: pointer;
    transition: background-color var(--d-fn) var(--ease), transform var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .item:hover { background: var(--paper-3); transform: translateX(2px); } }
  .item:focus-visible { background: var(--paper-3); }
  .item:active { background: var(--paper-3); }
  .item.out { margin-top: var(--s-2); color: var(--ink-2); }
  .key { width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }
  .opt { justify-content: flex-start; }
  :global(.wb-left) .menu { left: 0; right: auto; }
</style>
