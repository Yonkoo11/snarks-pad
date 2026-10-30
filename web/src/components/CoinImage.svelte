<script lang="ts">
  import { crayonTile, hueOf } from '../lib/crayon'
  // A coin's image at a fixed size, or (`fill`) filling its box as a square; a coin without an image, or whose
  // image fails, gets a crayon-drawn disc in the coin's own hue (lib/crayon, deterministic per symbol), with the
  // flat letter tile underneath until the drawing is ready, so nothing flashes and nothing jumps.
  let { src, symbol, size = 48, fill = false }: { src: string; symbol: string; size?: number; fill?: boolean } = $props()
  let broken = $state(false)
  const hue = $derived(hueOf(symbol))
  // the drawn disc follows the theme the page renders in; data-theme is set pre-paint, the media query covers "system"
  let drawn = $state<string | null>(null)
  $effect(() => {
    if (src && !broken) return
    const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    let live = true
    crayonTile(symbol, dark, fill || size > 96 ? 512 : 256).then((u) => { if (live && u) drawn = u }, () => {})
    return () => { live = false }
  })
</script>

{#if src && !broken}
  <img class="ci" class:fill {src} alt="" width={fill ? undefined : size} height={fill ? undefined : size}
    style:width={fill ? undefined : `${size}px`} style:height={fill ? undefined : `${size}px`} onerror={() => (broken = true)} />
{:else if drawn}
  <img class="ci" class:fill src={drawn} alt="" aria-hidden="true" width={fill ? undefined : size} height={fill ? undefined : size}
    style:width={fill ? undefined : `${size}px`} style:height={fill ? undefined : `${size}px`} />
{:else}
  <span class="ci tile" class:fill aria-hidden="true" style:width={fill ? undefined : `${size}px`} style:height={fill ? undefined : `${size}px`}
    style:--h={hue} style:font-size={fill ? undefined : `${size * 0.5}px`}>{symbol.slice(0, 1)}</span>
{/if}

<style>
  .ci { border-radius: var(--r-md); object-fit: cover; flex: none; background: var(--paper); }
  .tile {
    display: grid; place-items: center; font-family: var(--f-display); color: light-dark(#2b2420, #efe7da);
    /* on night paper the tile is a dark tint of the same hue, so a grid of letter tiles does not glare */
    background: light-dark(hsl(var(--h) 45% 80%), hsl(var(--h) 22% 30%));
  }
  /* inside a card: a square as wide as its box */
  .fill { width: 100%; height: 100%; aspect-ratio: 1; border-radius: 0; }
  .tile.fill { font-size: 64px; }
</style>
