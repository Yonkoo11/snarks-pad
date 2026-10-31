<script lang="ts">
  import ModeBanner from './components/ModeBanner.svelte'
  import PauseBanner from './components/PauseBanner.svelte'
  import Nav from './components/Nav.svelte'
  import Footer from './components/Footer.svelte'
  import BottomBar from './components/BottomBar.svelte'
  import Palette from './components/room/Palette.svelte'
  import LayerHost from './components/layers/LayerHost.svelte'
  import Crumbs from './components/layers/Crumbs.svelte'
  import PeekCard from './components/layers/PeekCard.svelte'
  import TapeRail from './components/layers/TapeRail.svelte'
  import Companion from './components/pal/Companion.svelte'
  import { layers } from './lib/layers.svelte'
  import { audit } from './lib/audit.svelte'
  import AuditToggle from './components/AuditToggle.svelte'
  import { router } from './lib/router.svelte'
  import { reducedMotion } from './lib/motion'
  import Home from './routes/Home.svelte'
  import CoinPage from './routes/Coin.svelte'
  // Home and the coin page paint eagerly (the first screen and the first click); every other page is its own chunk,
  // fetched on first visit. import() caches, so a return to a page mounts it at once.
  const Coins = () => import('./routes/Coins.svelte')
  const Launch = () => import('./routes/Launch.svelte')
  const Shielded = () => import('./routes/Shielded.svelte')
  const Profile = () => import('./routes/Profile.svelte')
  const Me = () => import('./routes/Me.svelte')
  const Treasury = () => import('./routes/Treasury.svelte')
  const How = () => import('./routes/How.svelte')
  const Legal = () => import('./routes/Legal.svelte')
  const r = $derived(router.route)
  // One title per page; the coin page writes its own once the coin is known, and the profile page always writes its own (a tab click must not put the generic one back).
  const titles = {
    home: 'SNARKS pad', coins: 'Every coin, SNARKS pad', coin: 'Coin, SNARKS pad', me: 'Your profile, SNARKS pad', launch: 'Launch a coin, SNARKS pad', shielded: 'Shielded delivery, SNARKS pad', treasury: 'Payouts, SNARKS pad',
    how: 'How it works, SNARKS pad', terms: 'Terms of use, SNARKS pad', privacy: 'Privacy, SNARKS pad', risk: 'Risk notice, SNARKS pad', missing: 'Page not found, SNARKS pad',
  } as const
  $effect(() => { if (r.name !== 'profile') document.title = titles[r.name] })
  // A route change moves focus to the page region, so a keyboard or screen-reader user lands on the
  // new page instead of staying on the link they clicked; the title change announces the page.
  let mainEl = $state<HTMLElement>()
  // The hand is the lamp: the pointer nudges every hard shadow's offset a little (at most ~1.2px),
  // so the paper objects read as truly lifted. One rAF-throttled listener; touch and reduced motion
  // leave the light still.
  $effect(() => {
    if (reducedMotion() || !matchMedia('(hover: hover)').matches) return
    let raf = 0
    const onMove = (e: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const nx = (e.clientX / innerWidth - 0.5) * 2
        const ny = (e.clientY / innerHeight - 0.5) * 2
        document.documentElement.style.setProperty('--shx', `${(3 - nx * 1.2).toFixed(2)}px`)
        document.documentElement.style.setProperty('--shy', `${(4 - ny * 1.2).toFixed(2)}px`)
      })
    }
    addEventListener('pointermove', onMove, { passive: true })
    return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(raf) }
  })
  // a: the audit view, anywhere outside a field; never while a modifier is held
  $effect(() => {
    const onA = (e: KeyboardEvent) => {
      if (e.key !== 'a' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target
      if (t instanceof HTMLElement && t.closest('input, select, textarea, [contenteditable]')) return
      audit.toggle()
    }
    addEventListener('keydown', onA)
    return () => removeEventListener('keydown', onA)
  })
  let firstRoute = true
  $effect(() => {
    r.name
    if (firstRoute) { firstRoute = false; return }
    mainEl?.focus({ preventScroll: true })
  })
</script>

<Palette />
<LayerHost />
<PeekCard />
<!-- everything under an open layer is inert: seen, not reachable, so focus and clicks stay on the top sheet -->
<div class="base" inert={layers.stack.length > 0}>
<ModeBanner />
<PauseBanner />
<Nav />
{#if r.name === 'coin'}<div class="wrap pathbar"><Crumbs /><AuditToggle /></div>{/if}
<main bind:this={mainEl} tabindex="-1">
  {#if r.name === 'home'}<Home />
  {:else if r.name === 'coin'}{#key r.mint}<CoinPage mint={r.mint} />{/key}
  {:else if r.name === 'profile'}{#key r.wallet}{#await Profile() then M}<M.default address={r.wallet} tab={r.tab} />{/await}{/key}
  {:else if r.name === 'me'}{#await Me() then M}<M.default tab={r.tab} />{/await}
  {:else if r.name === 'coins'}{#await Coins() then M}<M.default />{/await}
  {:else if r.name === 'launch'}{#await Launch() then M}<M.default />{/await}
  {:else if r.name === 'shielded'}{#await Shielded() then M}<M.default />{/await}
  {:else if r.name === 'treasury'}{#await Treasury() then M}<M.default />{/await}
  {:else if r.name === 'how'}{#await How() then M}<M.default />{/await}
  {:else if r.name === 'terms' || r.name === 'privacy' || r.name === 'risk'}{#key r.name}{#await Legal() then M}<M.default kind={r.name} />{/await}{/key}
  {:else}
    <section class="wrap missing">
      <h1 class="display">No page here.</h1>
      <p class="muted measure">The link may be mistyped, or it points at a coin that was never launched on this pad.</p>
      <a class="btn primary" href="#/">See the coins</a>
    </section>
  {/if}
</main>
<Footer />
<BottomBar />
<TapeRail />
<Companion />
</div>

<style>
  .base { display: contents; }
  .pathbar { padding-top: 0; padding-bottom: 0; margin-top: calc(-1 * var(--s-2)); display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap; }
  .missing { padding-top: var(--s-8); display: grid; gap: var(--s-5); justify-items: start; }
</style>
