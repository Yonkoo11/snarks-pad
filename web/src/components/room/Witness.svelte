<script lang="ts">
  // The mascot as a witness to a check, never a host. Its pose is the state of a real computation in this browser: leaning in while
  // the file is hashed, settled when the hash matched, turned away when it did not. It does not exist before a check starts and it
  // says nothing a number could not. The artwork is only ever moved as one whole picture (rotate, shift, crop); with reduced
  // motion every pose is the same still frame and the words carry the state.
  const { state, size = 56 }: { state: 'working' | 'match' | 'mismatch'; size?: number } = $props()
</script>

<span class="w {state}" style:--sz="{size}px" aria-hidden="true"><img src="/mascot-256.jpg" alt="" width={size} height={size} /></span>

<style>
  .w { display: inline-block; width: var(--sz); height: var(--sz); flex: none; border-radius: var(--r-sm); overflow: hidden; background: var(--paper-2); box-shadow: var(--sh-1); }
  img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: 50% 30%; transform-origin: 50% 90%; transition: transform 420ms var(--ease); }
  .working img { transform: rotate(6deg) translateX(2px); animation: lean 1.6s ease-in-out infinite alternate; }
  .match { animation: press 260ms var(--ease) backwards; }
  .match img { transform: rotate(-3deg); }
  .mismatch img { transform: rotate(-16deg) translateY(4px); }
  @keyframes lean { to { transform: rotate(9deg) translateX(3px); } }
  @keyframes press { from { transform: scale(1.18); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    img, .working img, .match img, .mismatch img { transform: none; animation: none; transition: none; }
    .match { animation: none; }
  }
</style>
