<script lang="ts">
  // Three short, true pages: what the site does and does not do. One component, one date; the copy is in design/build-brief.md.
  let { kind }: { kind: 'terms' | 'privacy' | 'risk' } = $props()
  const titles = { terms: 'Terms of use', privacy: 'Privacy', risk: 'Risk notice' } as const
  const parts: Record<typeof kind, { h: string; p: string }[]> = {
    terms: [
      { h: 'What this site does', p: 'SNARKS pad builds Solana transactions for you to sign in your own wallet. It never holds your coins, your ZEC or your keys; every transaction is signed and sent by your wallet.' },
      { h: 'Meteora', p: "Coins launch on Meteora's Dynamic Bonding Curve and graduate to Meteora DAMM v2 pools. Those programs are run by Meteora, not by this pad. After graduation Meteora can pause a pool or change its fee." },
      { h: 'Fees', p: "A coin's trading fee is the tier its creator picked at launch (1, 2, 4, 6 or 10% on the curve) and cannot be changed. Meteora keeps 20% of every fee; the pad claims the rest and splits what it claims 75% to holders and 25% to the team; on tiers above 1% the creator's share is claimed by the creator's own wallet. The live split is on the How it works page." },
      { h: 'Payouts', p: "Holders are paid Solana ZEC each round, or native ZEC in one batched shielded Zcash transaction once a week if they opted in. Shielded delivery swaps through NEAR 1Click; when the swap cannot complete before funds move, that round's shielded holders are paid Solana ZEC instead. The pad can pause payouts; nothing is lost while it is paused, fees stay in the pools. The cost of delivering shielded rewards is paid from the team's share first; if it ever costs more than that share, the excess comes off the shielded holders' payouts." },
      { h: 'Test mode', p: 'While a banner at the top of every page names a test network, nothing on this site is real money.' },
      { h: 'No promises', p: 'Coin prices can fall to zero. Payouts depend on trading volume and can be zero. Use this site only with money you can afford to lose.' },
    ],
    privacy: [
      { h: 'In your browser', p: 'The site stores your theme choice, a referral code from a link you opened and, in mock mode, test data. No analytics, no cookies, no tracking scripts.' },
      { h: "On the pad's server", p: 'When you opt in to shielded delivery the server records your Solana wallet address, the Zcash unified address you signed and the time. Trades and launches are read from the public Solana chain. The pad operator can see which Solana wallet maps to which Zcash address; the server never returns a full Zcash address to anyone, including you.' },
      { h: 'Hidden and not hidden', p: 'The list on the Shielded page says exactly what shielded delivery hides and what it does not.' },
      { h: 'Third parties', p: "Your wallet extension, the Solana RPC the site talks to and the price feed it reads (NEAR 1Click's token list, CoinGecko as the fallback) see your requests as they would from any website." },
    ],
    risk: [
      { h: 'Coins', p: 'Coins launched here are speculative and most lose value. Nothing on this site is advice.' },
      { h: 'Programs outside the pad', p: "Meteora's programs, Solana, Zcash and NEAR 1Click are outside the pad's control. When 1Click is down, the shielded batch waits or falls back to Solana ZEC." },
      { h: 'Payouts', p: 'One operator runs the service that claims fees and pays holders. While it is paused or behind, payouts wait; nothing is lost, the fees stay in the pools.' },
      { h: 'After graduation', p: "A graduated coin trades in a Meteora pool. Meteora can pause that pool or change its fee." },
      { h: 'Fees are final', p: 'Buying and selling straight back pays the fee twice: about $1.99 of every $100 at a 1% fee.' },
      { h: 'Test networks', p: 'Coins on devnet or a local chain have no value.' },
    ],
  }
</script>

<section class="wrap pad">
  <h1 class="display">{titles[kind]}</h1>
  <p class="muted">Version of 7 October 2026.</p>
  <div class="parts">
    {#each parts[kind] as part (part.h)}
      <section>
        <h2 class="h3">{part.h}</h2>
        {#if kind === 'privacy' && part.h === 'Hidden and not hidden'}
          <p>The list on the <a href="#/shielded">Shielded page</a> says exactly what shielded delivery hides and what it does not.</p>
        {:else}
          <p>{part.p}</p>
        {/if}
      </section>
    {/each}
  </div>
  {#if kind === 'terms'}<p class="muted small">Independent project. Not affiliated with Zcash, Electric Coin Co., the Zcash Foundation or Meteora.</p>{/if}
</section>

<style>
  .pad { padding-top: var(--s-6); padding-bottom: var(--s-6); display: grid; gap: var(--s-5); max-width: calc(66ch + 64px); margin-left: 0; }
  .parts { display: grid; gap: var(--s-5); }
  section { display: grid; gap: var(--s-2); }
  a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .small { font-size: var(--t-14); }
</style>
