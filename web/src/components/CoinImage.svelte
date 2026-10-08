<script lang="ts">
  // A coin's image at a fixed size, or (`fill`) filling its box as a square; a coin without an image, or whose image fails,
  // gets a letter tile whose hue comes from the symbol, so the same coin always looks the same.
  let { src, symbol, size = 48, fill = false }: { src: string; symbol: string; size?: number; fill?: boolean } = $props()
  let broken = $state(false)
  const hue = $derived([...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 360)
</script>

{#if src && !broken}
  <img class="ci" class:fill {src} alt="" width={fill ? undefined : size} height={fill ? undefined : size}
    style:width={fill ? undefined : `${size}px`} style:height={fill ? undefined : `${size}px`} onerror={() => (broken = true)} />
{:else}
  <span class="ci tile" class:fill aria-hidden="true" style:width={fill ? undefined : `${size}px`} style:height={fill ? undefined : `${size}px`}
    style:--h={hue} style:font-size={fill ? undefined : `${size * 0.5}px`}>{symbol.slice(0, 1)}</span>
{/if}

<style>
  .ci { border-radius: var(--r-md); object-fit: cover; flex: none; background: #f5efe2; }
  .tile {
    display: grid; place-items: center; font-family: var(--f-display); color: #2b2420;
    background: hsl(var(--h) 45% 80%);
  }
  /* inside a card: a square as wide as its box */
  .fill { width: 100%; height: 100%; aspect-ratio: 1; border-radius: 0; }
  .tile.fill { font-size: 64px; }
  /* on night paper the tile is a dark tint of the same hue, so a grid of letter tiles does not glare */
  :global(:root[data-theme='dark']) .tile { background: hsl(var(--h) 22% 30%); color: #efe7da; }
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme='light'])) .tile { background: hsl(var(--h) 22% 30%); color: #efe7da; } }
</style>
