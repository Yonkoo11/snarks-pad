<script lang="ts">
  // The two-chain postmark: a round earns this cancellation stamp only when the page holds both legs' transaction
  // ids (Solana signatures and a Zcash txid). It is drawn in stamp ink, never pink: the hatch stays shielded-only.
  // A round without both legs simply has no stamp, which is itself the honest signal.
  let { n, date }: { n: number; date: string } = $props()
  const uid = $props.id()
</script>

<svg class="pm" viewBox="0 0 104 104" role="img" aria-label={`Round ${n} paid on both chains, ${date}`}>
  <circle cx="52" cy="52" r="50" />
  <circle cx="52" cy="52" r="36" />
  <path id="pm-arc-{uid}" d="M 52 9.5 A 42.5 42.5 0 1 1 51.99 9.5" fill="none" stroke="none" />
  <text class="ring"><textPath href="#pm-arc-{uid}" startOffset="4">PAID ON BOTH CHAINS &#183; SOLANA &#183; ZCASH</textPath></text>
  <text class="mid" x="52" y="48" text-anchor="middle">SOL &#183; ZEC</text>
  <text class="sub" x="52" y="62" text-anchor="middle">{date}</text>
</svg>

<style>
  .pm { width: 96px; height: 96px; flex: none; transform: rotate(-11deg); opacity: .85; }
  circle { fill: none; stroke: var(--ink-2); stroke-width: 2.5; }
  circle:last-of-type { stroke-width: 1.5; }
  .ring { font-family: var(--f-mono); font-size: 9.5px; letter-spacing: .08em; fill: var(--ink-2); }
  .mid { font-family: var(--f-mono); font-size: 11.5px; font-weight: 500; letter-spacing: .04em; fill: var(--ink-2); }
  .sub { font-family: var(--f-mono); font-size: 8.5px; letter-spacing: .04em; fill: var(--ink-2); }
</style>
