<script lang="ts">
  import { api } from '../lib/api'
  import type { FeePolicy, Tier } from '../lib/types'
  import { sharesFromPolicy } from '../lib/fees'
  import { HOW_EXAMPLE, bpsText, exampleSteps } from '../lib/window'
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
  // the route's last stop carries the real count of rounds that have run
  let nRounds = $state<number | null>(null)
  $effect(() => { api.epochs().then((r) => (nRounds = r.epochs.length), () => (nRounds = null)) })
</script>

<section class="wrap pad">
  <div class="top">
    <h1 class="display">How the pad works.</h1>
    <p class="lede muted">Every coin here trades against ZEC. Every trade pays a fee, and 10% of it goes to the coin's holders each round: as Solana ZEC, or as native ZEC in your own shielded Zcash wallet if you opt in.</p>
  </div>

  <!-- the whole mechanism as four stops, before any prose: a trade becomes a fee, the fee a round, the round a payout -->
  <section class="part" aria-label="The route a trade's fee takes">
    <ol class="route">
      <li class="stop s1"><span class="r-n mono" aria-hidden="true">1</span><strong>A trade</strong><span class="r-p">Someone buys or sells a coin. The trade pays its fee in ZEC.</span></li>
      <li class="stop s2"><span class="r-n mono" aria-hidden="true">2</span><strong>The fee</strong><span class="r-p">10% of every fee belongs to the coin's holders.</span></li>
      <li class="stop s3"><span class="r-n mono" aria-hidden="true">3</span><strong>A round</strong><span class="r-p">Every 48 hours a round claims the fees and works out each share.</span></li>
      <li class="stop s4"><span class="r-n mono" aria-hidden="true">4</span><strong>You are paid</strong><span class="r-p">As Solana ZEC, or <em class="shd">shielded</em> into your own Zcash wallet.</span>{#if nRounds}<a class="chip r-chip" href="#/treasury">{nRounds} rounds so far</a>{/if}</li>
    </ol>
  </section>

  <!-- the fee split lives in one place; this page points at it instead of repeating it -->
  <section class="part">
    <p class="prose">Where the rest of the fee goes, share by share, is on the <a href="#/treasury">Payouts page</a>, beside the rounds that prove it.{#if manyTiers}{' '}On the higher fee levels the extra goes to the coin's creator; holders still get 0.10% of every trade (0.102% on the 6% level).{/if}</p>
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

  <!-- the opt-in steps and the hidden/not-hidden lists live on the Shielded page, where you act on them -->
  <section class="part" aria-labelledby="steps-h">
    <h2 class="h2" id="steps-h">Shielded delivery</h2>
    <p class="prose">One signature, no transaction, no fee: the <a href="#/shielded">Shielded page</a> walks the three steps and says exactly what is hidden from the public and what is not.</p>
    <a class="btn shd" href="#/shielded"><span class="key hatch" aria-hidden="true"></span>Get my rewards shielded</a>
  </section>

  <section class="part" aria-labelledby="meteora-h">
    <details class="fold">
    <summary><h2 class="h2" id="meteora-h">Launch, curve and graduation</h2></summary>
    <div class="prose">
      <p>Every coin starts on a Meteora bonding curve paired with Solana ZEC. Buying moves the price up; selling moves it down. The fee is fixed at launch and charged on every buy and sell once the launch window below has closed.</p>
      <p>When its curve fills up, the coin graduates to a Meteora pool, where trading carries on and the liquidity is locked for good. The pool's fee is the coin's own fee, rising by up to a fifth when trading is volatile: 1% rises to about 1.2%. After graduation the pool is Meteora's: Meteora can pause it or change its fee.</p>
    </div>
    </details>
  </section>

  <section class="part" aria-labelledby="window-h">
    <details class="fold">
    <summary><h2 class="h2" id="window-h">The launch window</h2></summary>
    <div class="prose">
      <p>Every coin's first five seconds cost more. A trade in the first second pays <span class="mono">{bpsText(HOW_EXAMPLE.cliffBps)}</span>, and the fee falls in five equal steps to the coin's own fee, which it keeps for good: on the 1% tier <span class="mono">{exampleSteps(HOW_EXAMPLE)}</span>. A bot that buys in the launch block pays that fee, and holders get their usual share of it. The pad's pages hold Buy for those seconds and show a countdown, so a person who waits pays the coin's fee. The launcher's own first buy, inside the launch transaction, pays the coin's fee. It is written into the Meteora config and can never change.</p>
    </div>
    </details>
  </section>

  <section class="part" aria-labelledby="when-h">
    <details class="fold">
    <summary><h2 class="h2" id="when-h">When holders are paid</h2></summary>
    <div class="prose">
      <p>Every two days holders are paid their share as Solana ZEC. Holders who chose shielded delivery are paid once a week. Very small shares wait for a later payout; nothing is lost.</p>
      <p>A shielded share is never paid publicly instead. If a round cannot swap it at a fair price, it waits for the next shielded round; switch shielded delivery off and what is waiting arrives as Solana ZEC.</p>
      <p>Fees of a coin that has no eligible holder are not claimed. Fees already held for such a coin wait 30 days for its holders, then join the next round's payout.</p>
      <p>Your share follows the least you held at random checks during the round, so buying just before a payout earns nothing for that round.</p>
    </div>
    </details>
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
  /* the page name outranks the prose under it */
  .top .display { font-size: clamp(30px, 2.6vw, 36px); }
  .top { display: grid; gap: var(--s-4); }
  .lede { font-size: var(--t-20); line-height: 1.45; max-width: 60ch; }
  .part { display: grid; gap: var(--s-4); }

  /* the route: four paper stops in a line, each barely tilted, read left to right like stamps on a card */
  .route { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s-4); counter-reset: none; }
  .stop {
    position: relative; display: grid; gap: var(--s-2); align-content: start; padding: var(--s-4);
    background: var(--paper-2); border-radius: var(--r-xs);
    box-shadow: var(--sh-2), inset 0 1px 0 light-dark(transparent, rgba(239, 231, 218, .07));
  }
  .s1, .s3 { transform: rotate(-.5deg); }
  .s2, .s4 { transform: rotate(.5deg); }
  .r-n {
    width: 32px; height: 32px; display: grid; place-items: center; font-weight: 500;
    background: var(--paper-3); border-radius: var(--r-full);
  }
  .stop strong { font-size: var(--t-20); }
  .r-p { font-size: var(--t-14); color: var(--ink-2); }
  /* the word shielded wears the device, nothing else in the route does */
  .shd { font-style: normal; color: var(--pink); padding-bottom: 2px; background: repeating-linear-gradient(-55deg, var(--pink) 0 3px, transparent 3px 6px) left bottom / 100% 3px no-repeat; }
  .r-chip { justify-self: start; text-decoration: none; }
  /* the arrow each stop passes the fee along with */
  .stop:not(:last-child)::after { content: '\2192'; position: absolute; right: -17px; top: 42%; color: var(--ink-3); font-size: var(--t-20); z-index: 1; }

  /* folded reference: the heading is the summary, the prose opens under it */
  .fold summary { cursor: pointer; width: max-content; border-radius: var(--r-sm); list-style: none; display: flex; align-items: baseline; gap: var(--s-2); }
  .fold summary::-webkit-details-marker { display: none; }
  .fold summary::after { content: '\25BE'; color: var(--ink-3); transition: transform var(--d-fn) var(--ease); }
  .fold[open] summary::after { transform: rotate(180deg); }
  .fold summary h2 { display: inline; }
  .fold .prose { padding-top: var(--s-3); }
  .prose { display: grid; gap: var(--s-3); max-width: 66ch; }
  .prose a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
  .why { margin: 0; padding-left: var(--s-5); display: grid; gap: var(--s-3); }
  .shd { white-space: nowrap; }
  .key { display: inline-block; width: 12px; height: 12px; border-radius: var(--r-xs); flex: none; }
  .story { grid-template-columns: minmax(0, 1fr) auto; gap: var(--s-6); align-items: start; }
  .story > div:first-child { display: grid; gap: var(--s-4); }
  .draw { padding-top: var(--s-3); padding-right: var(--s-3); }
  @media (max-width: 900px) {
    .route { grid-template-columns: 1fr 1fr; }
    .stop:nth-child(2)::after { content: none; }
  }
  @media (max-width: 640px) {
    .pad { gap: var(--s-6); }
    .lede { font-size: var(--t-16); }
    .route { grid-template-columns: 1fr; }
    .stop::after { content: none !important; }
    .story { grid-template-columns: 1fr; }
    .draw :global(.taped) { width: 84px; padding: 4px; }
  }
</style>
