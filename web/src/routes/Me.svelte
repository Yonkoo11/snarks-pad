<script lang="ts">
  import { wallet } from '../lib/wallet.svelte'
  import { profileHref, type ProfileTab } from '../lib/profile'
  import WalletButton from '../components/WalletButton.svelte'

  // #/me is the connected wallet's own profile. It goes there as soon as there is a wallet (the address then names the profile, so the page can be shared and bookmarked) and
  // asks for a wallet until then. `location.replace`, so Back does not return to a page that only redirects.
  let { tab }: { tab: ProfileTab | null } = $props()
  $effect(() => { if (wallet.address) location.replace(profileHref(wallet.address, tab)) })
</script>

<section class="wrap pad">
  {#if wallet.address}
    <div class="skel" style="height: 120px" aria-busy="true" aria-label="Opening your profile"></div>
  {:else}
    <h1 class="display">Connect a wallet to see your profile.</h1>
    <p class="muted measure">What you hold, the coins you launched, your trades and what the pad has paid you, in one place.</p>
    <WalletButton primary />
  {/if}
</section>

<style>
  .pad { padding-top: var(--s-8); display: grid; gap: var(--s-4); justify-items: start; }
  .pad .skel { justify-self: stretch; }
</style>
