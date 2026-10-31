<script lang="ts">
  import { api } from '../../lib/api'
  import type { IndexCoin } from '../../lib/types'
  // The paper index: press / anywhere (outside a field) and a slip of destinations opens - the four
  // places, the acts, and every coin by name or ticker. One keyboard model: arrows move, Enter goes,
  // Escape closes; the list is a listbox with aria-activedescendant. Fast travel for traders, and
  // nothing here is new data: the pages and the coin index the pad already serves.
  let open = $state(false)
  let q = $state('')
  let active = $state(0)
  let coins = $state<IndexCoin[]>([])
  let box = $state<HTMLInputElement>()

  const PLACES = [
    { label: 'Pad', hint: 'the door', href: '#/' },
    { label: 'Coins', hint: 'every coin', href: '#/coins' },
    { label: 'Payouts', hint: 'every round, verifiable', href: '#/payouts' },
    { label: 'Me', hint: 'your coins and payouts', href: '#/me' },
    { label: 'Launch a coin', hint: 'the one act', href: '#/launch' },
    { label: 'Shielded delivery', hint: 'seal the envelope', href: '#/shielded' },
    { label: 'How the pad works', hint: 'the route a fee takes', href: '#/how' },
  ]
  type Row = { id: string; label: string; hint: string; href: string }
  const rows = $derived.by<Row[]>(() => {
    const needle = q.trim().toLowerCase()
    const places = PLACES.filter((p) => !needle || p.label.toLowerCase().includes(needle) || p.hint.includes(needle))
      .map((p, i) => ({ id: `pal-p${i}`, ...p }))
    const cs = (needle ? coins.filter((c) => c.name.toLowerCase().includes(needle) || c.symbol.toLowerCase().includes(needle)) : coins)
      .slice(0, 8)
      .map((c, i) => ({ id: `pal-c${i}`, label: c.name, hint: `$${c.symbol}`, href: `#/coin/${c.mint}` }))
    return [...places, ...cs]
  })
  $effect(() => { rows; active = 0 })

  function show() {
    open = true
    q = ''
    if (coins.length === 0) api.coinIndex().then((r) => (coins = r.coins), () => {})
    setTimeout(() => box?.focus(), 0)
  }
  function go(r: Row | undefined) {
    if (!r) return
    open = false
    location.hash = r.href.slice(1)
  }
  function onGlobalKey(e: KeyboardEvent) {
    if (open) return
    if (e.key !== '/') return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    e.preventDefault()
    show()
  }
  function onBoxKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); open = false; return }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0) }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[active]) }
  }
  $effect(() => {
    addEventListener('keydown', onGlobalKey)
    return () => removeEventListener('keydown', onGlobalKey)
  })
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (open = false)}></div>
  <div class="slip onpaper" role="dialog" aria-label="Go to">
    <input
      bind:this={box}
      class="input mono q"
      placeholder="Type a coin or a page&hellip;"
      role="combobox"
      aria-expanded="true"
      aria-controls="pal-list"
      aria-activedescendant={rows[active]?.id}
      bind:value={q}
      onkeydown={onBoxKey}
    />
    <ul class="list" id="pal-list" role="listbox" aria-label="Destinations">
      {#each rows as r, i (r.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id={r.id} role="option" aria-selected={i === active} class:on={i === active} onclick={() => go(r)} onpointermove={() => (active = i)}>
          <span class="l">{r.label}</span><span class="h muted">{r.hint}</span>
        </li>
      {/each}
      {#if rows.length === 0}<li class="none muted">Nothing matches.</li>{/if}
    </ul>
    <p class="foot muted">&uarr;&darr; move &middot; Enter go &middot; Esc close</p>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 60; background: rgba(20, 16, 12, .35); }
  .slip {
    position: fixed; z-index: 61; top: 14vh; left: 50%; translate: -50% 0;
    width: min(560px, calc(100vw - 32px));
    background: var(--paper-2); border-radius: var(--r-sm); box-shadow: var(--sh-3);
    padding: var(--s-3); display: grid; gap: var(--s-2);
    animation: pal-in 160ms var(--ease) backwards;
  }
  @keyframes pal-in { from { opacity: 0; translate: -50% -8px; } }
  @media (prefers-reduced-motion: reduce) { .slip { animation: none; } }
  .q { font-size: var(--t-16); }
  .list { list-style: none; margin: 0; padding: 0; max-height: 46vh; overflow-y: auto; display: grid; }
  .list li { display: flex; justify-content: space-between; gap: var(--s-4); padding: var(--s-2) var(--s-3); border-radius: var(--r-sm); cursor: pointer; min-height: 40px; align-items: center; }
  .list li.on { background: var(--paper-3); }
  .l { font-weight: 700; }
  .h { font-size: var(--t-14); }
  .none { cursor: default; }
  .foot { font-size: var(--t-12); text-align: right; padding: 0 var(--s-2); }
</style>
