<script lang="ts">
  import { router } from '../lib/router.svelte'
  import ThemeToggle from './ThemeToggle.svelte'
  import WalletButton from './WalletButton.svelte'
  const links = [
    { href: '#/', name: 'home', label: 'Explore' },
    { href: '#/launch', name: 'launch', label: 'Launch' },
    { href: '#/shielded', name: 'shielded', label: 'Shielded' },
    { href: '#/treasury', name: 'treasury', label: 'Payouts' },
    { href: '#/how', name: 'how', label: 'How it works' },
  ] as const
  // the coin page lights Explore; the legal pages and the 404 light nothing
  const current = $derived(router.route.name === 'coin' ? 'home' : router.route.name)
</script>

<header class="wrap nav">
  <a class="brand" href="#/" aria-label="SNARKS pad, home">
    <img src="/mascot-256.jpg" alt="" width="40" height="40" />
    <span class="word">SNARKS pad</span>
  </a>
  <nav aria-label="Main">
    {#each links as l (l.name)}
      <a href={l.href} aria-current={current === l.name ? 'page' : undefined}>{l.label}</a>
    {/each}
  </nav>
  <div class="tools"><ThemeToggle /><a class="btn primary launch" href="#/launch">Launch a coin</a><WalletButton /></div>
</header>

<style>
  .nav { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: var(--s-5); padding-top: var(--s-4); padding-bottom: var(--s-4); }
  .brand { display: flex; align-items: center; gap: var(--s-2); text-decoration: none; min-height: 44px; }
  .brand img { width: 40px; height: 40px; object-fit: cover; object-position: 50% 30%; border-radius: var(--r-md); transform: rotate(-4deg); box-shadow: var(--sh-2); }
  .word { font-family: var(--f-display); font-size: 28px; line-height: 1; white-space: nowrap; }
  nav { display: flex; gap: var(--s-1); justify-content: center; }
  nav a {
    padding: var(--s-2) var(--s-3); border-radius: var(--r-md); text-decoration: none; font-weight: 700; color: var(--ink-2);
    min-height: 44px; display: inline-flex; align-items: center; white-space: nowrap;
    transition: color var(--d-fn) var(--ease), transform var(--d-fn) var(--ease);
  }
  @media (hover: hover) { nav a:hover { color: var(--ink); transform: translateY(-1px); } }
  nav a:active { transform: translateY(0); transition-duration: var(--d-press); }
  nav a[aria-current='page'] { color: var(--ink); text-decoration: underline; text-decoration-thickness: 3px; text-underline-offset: 6px; text-decoration-color: var(--ink-3); }
  .tools { display: flex; gap: var(--s-2); align-items: center; }
  .launch { white-space: nowrap; }
  @media (max-width: 820px) {
    .nav { grid-template-columns: 1fr auto; row-gap: var(--s-2); }
    nav { grid-column: 1 / -1; grid-row: 2; justify-content: space-between; }
    nav a { padding: var(--s-2); }
  }
  @media (max-width: 640px) {
    .nav { grid-template-columns: 1fr auto; padding-top: var(--s-3); padding-bottom: var(--s-2); column-gap: var(--s-3); }
    .brand img { width: 32px; height: 32px; }
    .word { font-size: 24px; }
    /* the Launch a coin button returns above 640px; on a phone the bottom bar (BottomBar.svelte) carries Explore, Launch,
       Shielded and Treasury, so the header keeps only the brand, the theme button and the wallet. How it works stays in the footer. */
    .launch { display: none; }
    nav { display: none; }
    .tools :global(.btn) { min-height: 44px; padding: 0 var(--s-4); font-size: var(--t-14); }
  }
</style>
