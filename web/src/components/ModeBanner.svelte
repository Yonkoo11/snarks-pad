<script lang="ts">
  import { api, ApiError, onMode, USE_REAL } from '../lib/api'
  import { wallet, friendly } from '../lib/wallet.svelte'
  import { zec } from '../lib/format'
  import { poll } from '../lib/poll'
  import type { PadMode } from '../lib/types'
  let mode = $state<PadMode | null>(null)
  let faucetMsg = $state<string | null>(null)
  // The engine says the faucet key cannot pay another fill (GET /treasury faucet.available, or a 503 faucet_unavailable on the click):
  // a plain sentence takes the button's place instead of an error code.
  let faucetDry = $state(false)
  async function getTestFunds() {
    if (!wallet.address) return
    faucetMsg = 'Sending…'
    try {
      const funds = await api.faucet(wallet.address)
      faucetMsg = `Sent: ${funds.sol} devnet SOL and ${zec(funds.zecZats)} test ZEC.`
    } catch (e) {
      if (e instanceof ApiError && e.code === 'faucet_unavailable') { faucetDry = true; faucetMsg = null }
      else faucetMsg = friendly(e)
    }
  }
  async function checkFaucet() {
    try { faucetDry = (await api.treasury()).faucet?.available === false } catch { /* the Treasury page shows load errors; a banner must not add one */ }
  }
  $effect(() => onMode((m) => (mode = m)))
  // While the faucet button is on screen (devnet, wallet connected): ask now and every 30 s, so a refill brings the button back.
  $effect(() => {
    if (mode !== 'devnet' || !wallet.address) return
    return poll(checkFaucet, 30_000)
  })
  const text = $derived(
    mode === 'local' ? 'LOCAL MODE: test validator and Zcash regtest. Nothing here is real money.'
    : mode === 'devnet' ? 'DEVNET MODE: Solana devnet and Zcash testnet, the swap to native ZEC simulated. Nothing here is real money.'
    : 'Checking which network the pad is on. Treat nothing here as real money until this says mainnet.'
  )
</script>

{#if mode !== 'mainnet'}
  <div class="banner" role="status">
    <div class="wrap row">
      <span>{text}</span>
      {#if !USE_REAL}<span class="chip">mock data</span>{/if}
      {#if mode === 'devnet' && wallet.address}
        {#if faucetDry}
          <span>Test money temporarily unavailable. Please try again later.</span>
        {:else}
          <button class="faucet" type="button" onclick={getTestFunds}>Get test SOL and ZEC</button>
        {/if}
        {#if faucetMsg}<span>{faucetMsg}</span>{/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .banner { background: var(--warn-bg); color: var(--warn-ink); font-size: var(--t-14); font-weight: 700; }
  .row { display: flex; gap: var(--s-3); align-items: center; justify-content: center; min-height: 36px; padding-top: var(--s-2); padding-bottom: var(--s-2); text-align: center; flex-wrap: wrap; }
  .chip { background: var(--pink); color: var(--pink-ink); }
  /* a 44px hit area on one underlined line; the negative margin keeps the banner's height */
  .faucet { font: inherit; font-weight: 700; text-decoration: underline; background: none; border: 0; color: inherit; cursor: pointer; padding: 0; min-height: 44px; margin: -10px 0; transition: transform var(--d-fn) var(--ease); }
  @media (hover: hover) { .faucet:hover { text-decoration-thickness: 2px; transform: translateY(-1px); } }
  .faucet:active { transform: translateY(0); transition-duration: var(--d-press); }
  @media (max-width: 640px) { .row { gap: var(--s-2); min-height: 0; padding-top: 6px; padding-bottom: 6px; } }
</style>
