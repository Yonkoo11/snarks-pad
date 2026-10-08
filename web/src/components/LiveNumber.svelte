<script lang="ts">
  import { Tween } from 'svelte/motion'
  import { dataTween } from '../lib/motion'
  // A number that moves to its new value in place (240ms on the one curve) instead of jumping. It mounts at its first
  // value, so there is no count-up from 0; only later changes move.
  let { value, format }: { value: number; format: (v: number) => string } = $props()
  const shown = Tween.of(() => value, dataTween())
</script>

<span class="mono">{format(shown.current)}</span>
