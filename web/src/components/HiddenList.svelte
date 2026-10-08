<!-- Same wording as docs/API.md ("What is hidden vs not", v2.9, plain-words pass 2026-10-07). Change both together. -->
<div class="hl">
  <section>
    <h3 class="h3">Hidden from the public</h3>
    <ul>
      <li>Which Zcash address you are paid to.</li>
      <li>Where that ZEC goes afterwards.</li>
      <li>Whether your wallet opted in: the pad shows it to no one but you, after you sign.</li>
    </ul>
  </section>
  <section>
    <h3 class="h3">Not hidden</h3>
    <ul>
      <li>Your Solana wallet and its token balance (public on Solana).</li>
      <li>That the pad paid a shielded batch this week, and its total.</li>
      <li>The pad operator knows which Solana wallet maps to which Zcash address.</li>
      <li>Someone who compares the published payee list with payouts on chain can guess whether you opted in.</li>
      <li>Roughly how much you are paid: it follows from your public token balance.</li>
    </ul>
  </section>
</div>

<style>
  .hl { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-6); }
  @media (max-width: 720px) { .hl { grid-template-columns: 1fr; gap: var(--s-5); } }
  ul { list-style: none; padding: 0; margin: var(--s-3) 0 0; display: grid; gap: var(--s-3); }
  li { position: relative; padding-left: var(--s-5); }
  /* hatching marks what is shielded (the device); public items get a plain outline square */
  li::before {
    content: ''; position: absolute; left: 0; top: .3em; width: 12px; height: 12px; border-radius: var(--r-xs);
    box-shadow: inset 0 0 0 1.5px var(--ink-3);
  }
  section:first-child li::before {
    box-shadow: none;
    background: repeating-linear-gradient(-55deg, var(--pink) 0 3px, transparent 3px 6px), var(--pink-soft);
  }
</style>
