<script lang="ts">
  let { size = 'lg', settle = false }: { size?: 'lg' | 'md' | 'sm' | 'xs'; settle?: boolean } = $props()
</script>

<figure class="taped {size}" class:settle>
  <span class="tape t1" aria-hidden="true"></span>
  <span class="tape t2" aria-hidden="true"></span>
  <img src={size === 'sm' || size === 'xs' ? '/mascot-256.jpg' : '/mascot-600.jpg'} width="784" height="1168"
    alt="Crayon drawing of SNARKS: a pink pizza-slice monster with one eye, goat horns and small wings, holding a black ZEC card." />
</figure>

<style>
  .taped {
    position: relative; margin: 0; background: #f5efe2; padding: 10px;
    transform: rotate(-2deg);
    box-shadow: var(--sh-3);
    border-radius: var(--r-xs);
  }
  .taped img { width: 100%; height: auto; border-radius: var(--r-xs); }
  .lg { width: min(360px, 100%); }
  .md { width: 220px; }
  .sm { width: 120px; padding: 6px; }
  /* the Explore banner: the drawing at 48px beside the one-line headline */
  .xs { width: 48px; padding: 4px; }
  .settle { animation: settle var(--d-in) var(--ease) both; }
  @keyframes settle {
    from { transform: rotate(-4deg) translateY(12px); opacity: 0; }
    to { transform: rotate(-2deg) translateY(0); opacity: 1; }
  }
  .tape {
    position: absolute; width: 84px; height: 26px; top: -12px;
    background: rgba(236, 222, 190, .82);
    box-shadow: 0 1px 0 rgba(43, 36, 32, .12);
  }
  .sm .tape { width: 44px; height: 14px; top: -7px; }
  .xs .tape { width: 28px; height: 10px; top: -5px; }
  .t1 { left: 14%; transform: rotate(-8deg); }
  .t2 { right: 12%; transform: rotate(6deg); }
  :global(:root[data-theme='dark']) .taped img { filter: brightness(.92); }
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme='light'])) .taped img { filter: brightness(.92); } }
</style>
