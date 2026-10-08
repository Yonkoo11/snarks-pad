<script lang="ts">
  import ModeBanner from './components/ModeBanner.svelte'
  import PauseBanner from './components/PauseBanner.svelte'
  import Nav from './components/Nav.svelte'
  import Footer from './components/Footer.svelte'
  import BottomBar from './components/BottomBar.svelte'
  import { router } from './lib/router.svelte'
  import Home from './routes/Home.svelte'
  import CoinPage from './routes/Coin.svelte'
  import Launch from './routes/Launch.svelte'
  import Shielded from './routes/Shielded.svelte'
  import Profile from './routes/Profile.svelte'
  import Me from './routes/Me.svelte'
  import Treasury from './routes/Treasury.svelte'
  import How from './routes/How.svelte'
  import Legal from './routes/Legal.svelte'
  const r = $derived(router.route)
  // One title per page; the coin page writes its own once the coin is known, and the profile page always writes its own (a tab click must not put the generic one back).
  const titles = {
    home: 'SNARKS pad', coin: 'Coin, SNARKS pad', me: 'Your profile, SNARKS pad', launch: 'Launch a coin, SNARKS pad', shielded: 'Shielded delivery, SNARKS pad', treasury: 'Treasury, SNARKS pad',
    how: 'How it works, SNARKS pad', terms: 'Terms of use, SNARKS pad', privacy: 'Privacy, SNARKS pad', risk: 'Risk notice, SNARKS pad', missing: 'Page not found, SNARKS pad',
  } as const
  $effect(() => { if (r.name !== 'profile') document.title = titles[r.name] })
</script>

<ModeBanner />
<PauseBanner />
<Nav />
<main>
  {#if r.name === 'home'}<Home />
  {:else if r.name === 'coin'}{#key r.mint}<CoinPage mint={r.mint} />{/key}
  {:else if r.name === 'profile'}{#key r.wallet}<Profile address={r.wallet} tab={r.tab} />{/key}
  {:else if r.name === 'me'}<Me tab={r.tab} />
  {:else if r.name === 'launch'}<Launch />
  {:else if r.name === 'shielded'}<Shielded />
  {:else if r.name === 'treasury'}<Treasury />
  {:else if r.name === 'how'}<How />
  {:else if r.name === 'terms' || r.name === 'privacy' || r.name === 'risk'}{#key r.name}<Legal kind={r.name} />{/key}
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

<style>
  .missing { padding-top: var(--s-8); display: grid; gap: var(--s-5); justify-items: start; }
</style>
