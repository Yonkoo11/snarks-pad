<script lang="ts">
  // Concentration as one 0-100 rule instead of three numbers: the pool's share is the filled
  // block (not people, never paid), the ten largest wallets are the tick above the line, the
  // dev is the notch below it. All three are % of total supply.
  const { top10, dev, pool, w = 52 }: { top10: number | null; dev: number | null; pool: number | null; w?: number } = $props()

  const H = 14
  const mid = H / 2
  const x = (p: number) => 1 + (Math.min(100, Math.max(0, p)) / 100) * (w - 2)
  const label = $derived.by(() => {
    const parts: string[] = []
    if (top10 != null) parts.push(`top 10 wallets ${top10}%`)
    if (dev != null) parts.push(`dev ${dev}%`)
    if (pool != null) parts.push(`pool ${pool}%`)
    return parts.length ? `Supply: ${parts.join(', ')}` : 'Supply split not read yet'
  })
</script>

{#if top10 == null && dev == null && pool == null}
  <span class="label dash">&ndash;</span>
{:else}
  <svg width={w} height={H} viewBox="0 0 {w} {H}" role="img" aria-label={label}>
    <line x1="1" y1={mid} x2={w - 1} y2={mid} class="rule" />
    {#if pool != null}<rect x="1" y={mid - 2} width={x(pool) - 1} height="4" class="pool" />{/if}
    {#if top10 != null}<line x1={x(top10)} y1="1" x2={x(top10)} y2={mid} class="tick" />{/if}
    {#if dev != null}<line x1={x(dev)} y1={mid} x2={x(dev)} y2={H - 1} class="notch" />{/if}
  </svg>
{/if}

<style>
  svg { display: block; overflow: visible; }
  .rule { stroke: var(--line); stroke-width: 1; }
  .pool { fill: var(--ink-3); opacity: .45; }
  .tick { stroke: var(--ink); stroke-width: 2; }
  .notch { stroke: var(--pink); stroke-width: 2; }
  .dash { color: var(--ink-3); }
</style>
