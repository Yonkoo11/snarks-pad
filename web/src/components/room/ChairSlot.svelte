<script lang="ts">
  // One slot in the book of rounds: the mascot at full strength once THIS device has re-hashed the round's holder file, and the same
  // picture faint in a dashed outline until then. Nothing else changes it; the count of full slots is the real length of the checked list.
  const { filled, size = 34 }: { filled: boolean; size?: number } = $props()
</script>

<span class="chair" class:filled style:--sz="{size}px" role="img" aria-label={filled ? 'Re-hashed on this device' : 'Not re-hashed on this device yet'}>
  <img src="/mascot-256.jpg" alt="" width={size} height={size} />
</span>

<style>
  .chair { display: inline-block; width: var(--sz); height: var(--sz); flex: none; border-radius: var(--r-xs); overflow: hidden; outline: 1.5px dashed var(--ink-3); outline-offset: -1.5px; align-self: center; }
  img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: 50% 30%; opacity: .22; }
  .chair.filled { outline: 1.5px solid var(--good); }
  .chair.filled img { opacity: 1; }
</style>
