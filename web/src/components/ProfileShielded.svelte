<script lang="ts">
  import { shieldedView } from '../lib/shielded.svelte'
  import { zec } from '../lib/format'

  // The Shielded delivery tab, for the wallet's owner only. Whether a wallet opted in is private (contract v2.9): the pad shows it to nobody else, so this tab asks for one signature
  // and then shows On or Off and the masked address (the first and last four characters, never the whole address). The signature is shared with the Shielded page and the Rewards tab.
  // Changing or stopping happens on the Shielded page, where the opt-in form is.
  let { address }: { address: string } = $props()
  const status = $derived(shieldedView.of(address))
  const pending = $derived(status ? BigInt(status.pendingZats) : 0n)
</script>

<section class="panel box" aria-labelledby="sd-h">
  <span class="band hatch" aria-hidden="true"></span>
  <h2 class="h3" id="sd-h">Shielded delivery</h2>
  {#if status === null}
    <p>Whether this wallet gets its rewards shielded is private: the pad shows it only to you, after you sign.</p>
    <button class="btn" type="button" onclick={() => shieldedView.read(address)} disabled={shieldedView.busy}>{shieldedView.busy ? 'Waiting for your wallet…' : 'Show my settings'}</button>
    <p class="muted small">One signature, no transaction, no fee. Your wallet shows the exact text first.</p>
    {#if shieldedView.error}<p class="error">{shieldedView.error}</p>{/if}
  {:else if status.optedIn}
    <p>Shielded delivery is <strong>on</strong>. Your rewards go to <span class="mono">{status.zcashAddressMasked}</span> as native ZEC, in one batch about once a week (rounds run every 48 hours; shielded shares wait for the weekly batch).</p>
    {#if pending > 0n}
      <p class="muted">Waiting for the next weekly batch: <span class="mono">{zec(pending, 6)} ZEC</span>. A share is held until it reaches <span class="mono">0.001 ZEC</span>, then goes out in the next batch; nothing is lost while it waits.</p>
    {:else}
      <p class="muted">Nothing is waiting for the next weekly batch.</p>
    {/if}
    <a class="btn" href="#/shielded">Change or stop delivery</a>
  {:else}
    <p>Shielded delivery is <strong>off</strong>. Rewards arrive as Solana ZEC in this wallet.</p>
    <a class="btn primary" href="#/shielded">Get them shielded</a>
  {/if}
</section>

<style>
  .box { position: relative; overflow: hidden; display: grid; gap: var(--s-3); justify-items: start; padding: var(--s-5); padding-top: calc(var(--s-5) + 6px); max-width: 640px; }
  .band { position: absolute; inset: 0 0 auto 0; height: 6px; }
  .small { font-size: var(--t-14); }
</style>
