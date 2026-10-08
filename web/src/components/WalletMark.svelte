<script lang="ts">
  import { walletMark } from '../lib/walletMark'
  // The picture a wallet gets from its own address (lib/walletMark.ts): the same address, the same picture, drawn here as inline SVG with no outside service.
  // The tile's tint follows the recipe of the coin letter tiles (CoinImage), the cells are the ink, so it reads on light and night paper alike.
  let { address, size = 48 }: { address: string; size?: number } = $props()
  const mark = $derived(walletMark(address))
</script>

<svg class="mark" viewBox="-1 -1 {mark.size + 2} {mark.size + 2}" width={size} height={size} role="img" aria-label="Picture generated from this address" style:--h={mark.hue}>
  {#each mark.cells as on, i (i)}
    {#if on}<rect x={i % mark.size} y={Math.floor(i / mark.size)} width="1" height="1" rx="0.12" />{/if}
  {/each}
</svg>

<style>
  .mark { display: block; flex: none; border-radius: var(--r-md); background: hsl(var(--h) 45% 80%); }
  .mark rect { fill: var(--ink); }
  /* on night paper the tile is a dark tint of the same hue, as the coin tiles are */
  :global(:root[data-theme='dark']) .mark { background: hsl(var(--h) 22% 30%); }
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme='light'])) .mark { background: hsl(var(--h) 22% 30%); } }
</style>
