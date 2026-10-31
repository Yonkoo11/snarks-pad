<script lang="ts">
  // The stack, drawn: "Coins / $SNRK / Holders". Every part but the last is a way back: a layer pops, a page navigates.
  // Depth is something the reader can see and walk, not only feel.
  import { router } from '../../lib/router.svelte'
  import { layers } from '../../lib/layers.svelte'

  const pageName: Record<string, string> = { coins: 'Coins', coin: 'Coins', treasury: 'Payouts', me: 'Me', profile: 'Profile', launch: 'Launch', shielded: 'Shielded', how: 'How it works', home: 'Pad' }
  const pageHref: Record<string, string> = { coins: '#/coins', coin: '#/coins', treasury: '#/payouts', me: '#/me', launch: '#/launch', shielded: '#/shielded', how: '#/how', home: '#/' }
  const parts = $derived.by(() => {
    const r = router.route
    const out: { label: string; href?: string; depth?: number }[] = []
    out.push({ label: pageName[r.name] ?? 'Page', href: pageHref[r.name] })
    if (r.name === 'coin') out.push({ label: layers.routeLabel ?? 'Coin', href: layers.stack.length ? `#/coin/${r.mint}` : undefined })
    layers.stack.forEach((l, i) => out.push({ label: l.title, depth: i + 1 }))
    return out
  })
</script>

<nav class="crumbs" aria-label="Where you are">
  <ol>
    {#each parts as p, i (i)}
      <li>
        {#if i === parts.length - 1}<span class="here" aria-current="location">{p.label}</span>
        {:else if p.depth !== undefined}<button type="button" onclick={() => layers.popTo(p.depth!)}>{p.label}</button>
        {:else if p.href}<a href={p.href}>{p.label}</a>
        {:else}<span>{p.label}</span>{/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .crumbs { min-width: 0; }
  ol { display: flex; align-items: center; flex-wrap: wrap; gap: 0 var(--s-2); margin: 0; padding: 0; list-style: none; font-family: var(--f-mono, ui-monospace, monospace); font-size: var(--t-12); color: var(--ink-3); }
  li + li::before { content: '/'; margin-right: var(--s-2); color: var(--ink-3); }
  a, button { color: var(--ink-2); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; background: none; border: 0; padding: 0; font: inherit; cursor: pointer; min-height: 24px; }
  @media (hover: hover) { a:hover, button:hover { color: var(--ink); text-decoration-color: var(--ink-3); } }
  .here { color: var(--ink); font-weight: 700; }
</style>
