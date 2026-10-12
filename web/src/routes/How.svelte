<script lang="ts">
  import { api } from '../lib/api'
  import type { FeePolicy, Tier } from '../lib/types'
  import { sharesFromPolicy } from '../lib/fees'
  import { HOW_EXAMPLE, bpsText, exampleSteps } from '../lib/window'
  import FeeSplit from '../components/FeeSplit.svelte'
  import HiddenList from '../components/HiddenList.svelte'
  import Taped from '../components/Taped.svelte'

  // How the pad works, in plain words (research/COPY-AUDIT.md, 2026-10-07): no other launchpad is named, and the mechanics stay at the level a holder
  // or a creator needs. The disclosures live in Terms and Risk. The fee split is drawn from the published policy (GET /treasury).
  let policy = $state<FeePolicy | null | undefined>(undefined)
  const load = () => { policy = undefined; api.treasury().then((t) => (policy = t.policy), () => (policy = null)) }
  $effect(() => { load() })
  const split = $derived(policy ? sharesFromPolicy(policy) : policy)
  // the line about higher fee levels shows only on a network that offers more than one (mainnet offers only the 1% level)
  let tiers = $state<Tier[]>([])
  $effect(() => { api.tiers().then((r) => (tiers = r.tiers ?? []), () => (tiers = [])) })
  const manyTiers = $derived(tiers.filter((t) => t.available).length > 1)
</script>

<section class="wrap pad">
  <div class="top">
    <h1 class="display">How the pad works.</h1>
    <p class="lede muted">Every coin here trades against ZEC. Every trade pays a fee, and 10% of it goes to the coin's holders each round: as Solana ZEC, or as native ZEC in your own shielded Zcash wallet if you opt in.</p>
  </div>

  <section class="part">
    <FeeSplit {split} onretry={load} />
    {#if manyTiers}<p class="prose">On the higher fee levels the extra goes to the coin's creator; holders still get 0.10% of every trade (0.102% on the 6% level).</p>{/if}
  </section>

  <section class="part" aria-labelledby="why-h">
    <h2 class="h2" id="why-h">Why SNARKS pad</h2>
    <ul class="why prose">
      <li><strong>Rewards in ZEC, never in the coin.</strong> Holders are paid from the trading fee, so payouts never sell the coin's own supply. There is no transfer tax.</li>
      <li><strong>Shielded if you want it.</strong> Rounds run every 48 hours and pay Solana ZEC. Opt in once and your share arrives instead as native ZEC in your own Zcash wallet, in one shielded transaction about once a week. Nothing to claim.</li>
      <li><strong>Fees go to a vault, not a person.</strong> The pad's share of the fees is claimed into a 2-of-3 Squads vault. No single key can move it.</li>
      <li><strong>Fixed at launch.</strong> A coin's fee on the curve, its name and its image can never change, no new coins can be minted, and its liquidity is locked for good after graduation. Every launch also carries the pad's own signature, so trading terminals can tell a SNARKS pad coin from any other.</li>
      <li><strong>Every payout is public.</strong> The <a href="#/treasury">Payouts page</a> lists each round with its transactions.</li>
    </ul>
  </section>

  <section class="part" aria-labelledby="steps-h">
    <h2 class="h2" id="steps-h">Shielded delivery in three steps</h2>
    <div class="panel steps">
      <span class="band hatch" aria-hidden="true"></span>
      <ol>
        <li><span class="n" aria-hidden="true">1</span><p>Connect the Solana wallet that holds your coins.</p></li>
        <li><span class="n" aria-hidden="true">2</span><p>Paste your Zcash unified address. It starts with u1; your wallet's Receive screen shows it.</p></li>
        <li><span class="n" aria-hidden="true">3</span><p>Sign one message. No transaction, no fee. Rounds still run every 48 hours; your share is held and arrives as native ZEC in that wallet in the next weekly shielded batch.</p></li>
      </ol>
      <a class="btn primary" href="#/shielded">Get my rewards shielded</a>
    </div>
  </section>

  <section class="part" aria-labelledby="hidden-h">
    <h2 class="h2" id="hidden-h">What is hidden, and what is not</h2>
    <HiddenList />
  </section>

  <section class="part" aria-labelledby="meteora-h">
    <h2 class="h2" id="meteora-h">Launch, curve and graduation</h2>
    <div class="prose">
      <p>Every coin starts on a Meteora bonding curve paired with Solana ZEC. Buying moves the price up; selling moves it down. The fee is fixed at launch and charged on every buy and sell once the launch window below has closed.</p>
      <p>When its curve fills up, the coin graduates to a Meteora pool, where trading carries on and the liquidity is locked for good. The pool's fee is the coin's own fee, rising by up to a fifth when trading is volatile: 1% rises to about 1.2%. After graduation the pool is Meteora's: Meteora can pause it or change its fee.</p>
    </div>
  </section>

  <section class="part" aria-labelledby="window-h">
    <h2 class="h2" id="window-h">The launch window</h2>
    <div class="prose">
      <p>Every coin's first five seconds cost more. A trade in the first second pays <span class="mono">{bpsText(HOW_EXAMPLE.cliffBps)}</span>, and the fee falls in five equal steps to the coin's own fee, which it keeps for good: on the 1% tier <span class="mono">{exampleSteps(HOW_EXAMPLE)}</span>. A bot that buys in the launch block pays that fee, and holders get their usual share of it. The pad's pages hold Buy for those seconds and show a countdown, so a person who waits pays the coin's fee. The launcher's own first buy, inside the launch transaction, pays the coin's fee. It is written into the Meteora config and can never change.</p>
    </div>
  </section>

  <section class="part" aria-labelledby="when-h">
    <h2 class="h2" id="when-h">When holders are paid</h2>
    <div class="prose">
      <p>Every two days holders are paid their share as Solana ZEC. Holders who chose shielded delivery are paid once a week. Very small shares wait for a later payout; nothing is lost.</p>
      <p>A shielded share is never paid publicly instead. If a round cannot swap it at a fair price, it waits for the next shielded round; switch shielded delivery off and what is waiting arrives as Solana ZEC.</p>
      <p>Fees of a coin that has no eligible holder are not claimed. Fees already held for such a coin wait 30 days for its holders, then join the next round's payout.</p>
      <p>Your share follows the least you held at random checks during the round, so buying just before a payout earns nothing for that round.</p>
    </div>
  </section>

  <section class="part story" aria-labelledby="story-h">
    <div>
      <h2 class="h2" id="story-h">The $SNARKS story</h2>
      <p class="prose">$SNARKS is the pad's own coin. Its name and its drawing are a tribute to the 2023 "RELEASE THE SNARKS!" video, where kids drew what zk-SNARKs look like: this one is a pink pizza-slice monster holding a ZEC card, drawn by the pad's maker.</p>
    </div>
    <div class="draw"><Taped size="sm" /></div>
  </section>
</section>

<style>
  .pad { padding-top: var(--s-6); padding-bottom: var(--s-6); display: grid; gap: var(--s-7); }
  .top { display: grid; gap: var(--s-4); }
  .lede { font-size: var(--t-20); line-height: 1.45; max-width: 60ch; }
  .part { display: grid; gap: var(--s-4); }
  .prose { display: grid; gap: var(--s-3); max-width: 66ch; }
  .prose a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .why { margin: 0; padding-left: var(--s-5); display: grid; gap: var(--s-3); }
  .steps { position: relative; overflow: hidden; padding: var(--s-6); padding-top: calc(var(--s-6) + 6px); display: grid; gap: var(--s-5); justify-items: start; max-width: 720px; }
  .band { position: absolute; inset: 0 0 auto 0; height: 6px; }
  /* the numbered steps only: an unscoped li rule once squeezed every other list on the page into a 36px column */
  .steps ol { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-4); }
  .steps li { display: grid; grid-template-columns: 36px 1fr; gap: var(--s-4); align-items: start; }
  .n {
    width: 36px; height: 36px; display: grid; place-items: center; font-family: var(--f-mono); font-weight: 500; font-size: var(--t-16);
    background: var(--paper-3); border-radius: var(--r-full);
  }
  .steps li p { padding-top: 6px; }
  .story { grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-6); align-items: start; }
  .story > div:first-child { display: grid; gap: var(--s-4); }
  .draw { padding-top: var(--s-3); padding-right: var(--s-3); }
  @media (max-width: 640px) {
    .pad { gap: var(--s-6); }
    .lede { font-size: var(--t-16); }
    .steps { padding: var(--s-5); padding-top: calc(var(--s-5) + 6px); }
    .story { grid-template-columns: 1fr; }
    .draw :global(.taped) { width: 84px; padding: 4px; }
  }
</style>
