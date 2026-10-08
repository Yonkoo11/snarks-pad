<script lang="ts">
  import { X_HANDLE } from '../lib/site'
  const product = [
    ['#/', 'Explore'], ['#/launch', 'Launch'], ['#/shielded', 'Shielded'], ['#/treasury', 'Payouts'], ['#/how', 'How it works'],
  ] as const
  const legal = [['#/terms', 'Terms of use'], ['#/privacy', 'Privacy'], ['#/risk', 'Risk notice']] as const
</script>

<footer class="foot">
  <div class="wrap inner">
    <div class="cols">
      <div class="brandcol">
        <a class="brand" href="#/" aria-label="SNARKS pad, home">
          <img src="/mascot-256.jpg" alt="" width="32" height="32" />
          <span class="word">SNARKS pad</span>
        </a>
        <p class="line">Launch and trade coins that pay their holders in ZEC, shielded if you opt in. Your wallet signs every transaction; the pad never holds your coins.</p>
      </div>
      <nav aria-label="Product">
        <h2 class="label">Product</h2>
        <ul>{#each product as [href, label] (href)}<li><a {href}>{label}</a></li>{/each}</ul>
      </nav>
      <nav aria-label="Legal">
        <h2 class="label">Legal</h2>
        <ul>{#each legal as [href, label] (href)}<li><a {href}>{label}</a></li>{/each}</ul>
      </nav>
    </div>
    <div class="bottom">
      <p class="risk">Coins launched here are speculative and can lose all their value. Nothing on this site is advice.</p>
      <p class="meta">
        <span>© 2026 SNARKS pad</span>
        {#if X_HANDLE}<a href="https://x.com/{X_HANDLE}" target="_blank" rel="noreferrer">X</a>{:else}<span>X: handle to come</span>{/if}
      </p>
    </div>
  </div>
</footer>

<style>
  .foot { margin-top: auto; padding-top: var(--s-8); padding-bottom: var(--s-6); }
  .inner { border-top: 2px dashed var(--line); padding-top: var(--s-7); display: grid; gap: var(--s-6); }
  .cols { display: grid; grid-template-columns: minmax(0, 1.6fr) 1fr 1fr; gap: var(--s-6); }
  .brandcol { display: grid; gap: var(--s-3); align-content: start; }
  .brand { display: flex; align-items: center; gap: var(--s-2); text-decoration: none; min-height: 44px; width: max-content; }
  .brand img { width: 32px; height: 32px; object-fit: cover; object-position: 50% 30%; border-radius: var(--r-md); transform: rotate(-4deg); box-shadow: var(--sh-2); }
  .word { font-family: var(--f-display); font-size: 24px; line-height: 1; }
  .line { color: var(--ink-2); max-width: 46ch; }
  nav { display: grid; gap: var(--s-2); align-content: start; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; }
  /* every link answers a 44px-tall touch and changes by its underline only */
  li a { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; color: var(--ink-2); font-weight: 700; }
  @media (hover: hover) { li a:hover, .meta a:hover { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; color: var(--ink); } }
  .bottom { display: grid; gap: var(--s-3); }
  .risk { color: var(--ink-2); max-width: 70ch; }
  .meta { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-4); font-size: var(--t-14); color: var(--ink-3); }
  .meta a { color: var(--ink-2); display: inline-flex; align-items: center; min-height: 44px; margin: -12px 0; }
  @media (max-width: 800px) {
    .cols { grid-template-columns: 1fr 1fr; }
    .brandcol { grid-column: 1 / -1; }
  }
</style>
