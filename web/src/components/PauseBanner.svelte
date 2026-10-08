<script lang="ts">
  import { api } from '../lib/api'
  import { poll } from '../lib/poll'
  import type { Treasury } from '../lib/types'
  // The kill switch (plan section 4): while the keeper is paused, or an epoch waits for the operator, say so on
  // every page. Quiet when everything runs (no banner, no layout shift).
  let t = $state<Treasury | null>(null)
  async function load() {
    try { t = await api.treasury() } catch { /* the Treasury page shows load errors; a banner must not add one */ }
  }
  $effect(() => poll(load, 30_000))
</script>

{#if t?.paused}
  <div class="banner" role="status">
    <div class="wrap row">
      <span>Payouts are paused. Nothing is lost: fees stay in the pools and holders are paid when payouts resume.</span>
    </div>
  </div>
{:else if t && t.epochsNeedingAttention > 0}
  <div class="banner" role="status">
    <div class="wrap row">
      <span>An earlier payout round is waiting for the operator. What it owes is still counted, and new rounds only run when that money is kept apart.</span>
    </div>
  </div>
{/if}

<style>
  .banner { background: var(--warn-bg); color: var(--warn-ink); font-size: var(--t-14); font-weight: 700; }
  .row { display: flex; gap: var(--s-3); align-items: center; justify-content: center; min-height: 36px; padding-top: var(--s-2); padding-bottom: var(--s-2); text-align: center; flex-wrap: wrap; }
  @media (max-width: 640px) { .row { gap: var(--s-2); min-height: 0; padding-top: 6px; padding-bottom: 6px; } }
</style>
