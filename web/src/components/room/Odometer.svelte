<script lang="ts">
  import { Spring } from 'svelte/motion'
  import { reducedMotion } from '../../lib/motion'
  // A till for the page's one big number: each digit is a column of 0-9 that rolls to its value
  // with a spring and a slight overshoot, staggered from the right like a mechanical counter.
  // Non-digit characters (the dot, the unit) sit still. Rolls once on entrance from zero, then
  // only the digits that change roll again. Reduced motion renders the plain final string.
  // `roll` off renders the plain final string: the page passes it false after the session's first
  // arrival, so the till does not re-ring on every navigation back.
  let { text, delay = 0, roll = true }: { text: string; delay?: number; roll?: boolean } = $props()

  const still = $derived(reducedMotion() || !roll)
  const chars = $derived([...text])
  let started = $state(false)
  $effect(() => {
    const t = setTimeout(() => (started = true), delay)
    return () => clearTimeout(t)
  })

  // one spring per column, created as columns appear; a column springs to its digit, or to 0 before the start
  const springs = new Map<number, Spring<number>>()
  function springOf(i: number, digit: number, stagger: number): Spring<number> {
    let s = springs.get(i)
    if (!s) {
      s = new Spring(0, { stiffness: 0.06, damping: 0.62 })
      springs.set(i, s)
    }
    if (started) setTimeout(() => s!.set(digit), stagger)
    return s
  }
</script>

{#if still}
  <span class="od mono">{text}</span>
{:else}
  <!-- role="img" makes the aria-label real for AT; the rolling columns underneath are presentation -->
  <span class="od mono" role="img" aria-label={text}>
    {#each chars as ch, i (i)}
      {#if /\d/.test(ch)}
        {@const s = springOf(i, Number(ch), (chars.length - i) * 55)}
        <span class="col" aria-hidden="true">
          <span class="stack" style:transform="translateY({-s.current}em)">
            {#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as d (d)}<span class="d">{d}</span>{/each}
          </span>
        </span>
      {:else}
        <span class="ch" aria-hidden="true">{ch === ' ' ? ' ' : ch}</span>
      {/if}
    {/each}
  </span>
{/if}

<style>
  .od { display: inline-flex; align-items: baseline; font-variant-numeric: tabular-nums; }
  .col { display: inline-block; height: 1em; overflow: hidden; line-height: 1; }
  .stack { display: grid; will-change: transform; }
  .d { display: block; height: 1em; line-height: 1; }
  .ch { line-height: 1; }
</style>
