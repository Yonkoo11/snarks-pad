<script lang="ts">
  // One sheet of paper laid over the page: a side sheet on a desk, a bottom sheet on a phone. Its torn edge shows the layer
  // beneath; layers below the top are inert and sit a few pixels back so the stack reads as a stack. The header carries the
  // breadcrumb and the close button, and a phone can drag the header down to dismiss.
  import type { Snippet } from 'svelte'
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { layers, type Layer } from '../../lib/layers.svelte'
  import { tornClip } from '../../lib/torn'
  import { reducedMotion } from '../../lib/motion'
  import Crumbs from './Crumbs.svelte'

  const { layer, below, children }: { layer: Layer; below: number; children: Snippet } = $props()
  const isTop = $derived(below === 0)
  const phone = matchMedia('(max-width: 640px)').matches
  const ms = reducedMotion() ? 0 : 280
  let panel = $state<HTMLElement>()
  $effect(() => { if (isTop) panel?.focus({ preventScroll: true }) })

  // drag the header down to dismiss (phone only)
  let dy = $state(0)
  let dragging = $state(false)
  let startY = 0
  function down(e: PointerEvent) {
    if (!phone || (e.target as HTMLElement).closest('a, button')) return
    dragging = true; startY = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function move(e: PointerEvent) { if (dragging) dy = Math.max(0, e.clientY - startY) }
  function up() {
    if (!dragging) return
    dragging = false
    if (dy > 110) layers.closeTop()
    dy = 0
  }
  const clip = $derived(tornClip(layer.uid, phone ? 'top' : 'left', 46, phone ? 0.7 : 0.9))
</script>

<div
  class="wrap-sheet"
  class:phone
  style:--below={below}
  inert={!isTop}
  transition:fly={{ x: phone ? 0 : 64, y: phone ? 120 : 0, duration: ms, easing: cubicOut }}
>
  <div
    class="sheet"
    class:dragging={dragging || dy > 0}
    role="dialog"
    aria-modal="true"
    aria-label={layer.title}
    tabindex="-1"
    bind:this={panel}
    style:clip-path={clip}
    style:transform={dy ? `translateY(${dy}px)` : undefined}
  >
    <header class="shead" role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
      <span class="grip" aria-hidden="true"></span>
      <Crumbs />
      <button class="x" type="button" onclick={() => layers.closeTop()} aria-label="Close this sheet">
        <span aria-hidden="true">&times;</span><kbd class="mono">Esc</kbd>
      </button>
    </header>
    <div class="sbody">{@render children()}</div>
  </div>
</div>

<style>
  /* the shadow lives on the wrapper: a clip-path would cut a shadow drawn on the sheet itself */
  .wrap-sheet {
    position: fixed; z-index: 52; inset: 0 0 0 auto; width: min(640px, 94vw);
    filter: drop-shadow(-6px 0 0 light-dark(rgba(43, 36, 32, .14), rgba(0, 0, 0, .4)));
    transform: translateX(calc(var(--below) * -34px));
    transition: transform 220ms var(--ease);
    pointer-events: none;
  }
  .wrap-sheet > .sheet { pointer-events: auto; }
  .sheet {
    height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr);
    background: var(--paper-2); outline: none;
    padding-left: 6px;
  }
  .wrap-sheet:not(:last-child) .sheet { filter: saturate(.85) brightness(.97); }
  .shead {
    display: flex; align-items: center; gap: var(--s-3); padding: var(--s-3) var(--s-4) var(--s-3) var(--s-5);
    border-bottom: 1.5px solid var(--line); background: var(--paper-2); touch-action: none; min-width: 0;
  }
  .grip { display: none; }
  .x {
    margin-left: auto; display: inline-flex; align-items: center; gap: var(--s-2); min-height: 44px; min-width: 44px; justify-content: center;
    border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 26px; line-height: 1; cursor: pointer; border-radius: var(--r-md);
  }
  .x kbd { font-size: var(--t-11); border: 1px solid var(--line); border-radius: var(--r-xs); padding: 1px 5px; color: var(--ink-3); }
  @media (hover: hover) { .x:hover { background: var(--hover); } }
  .sbody { overflow-y: auto; overscroll-behavior: contain; padding: var(--s-5); display: grid; grid-auto-rows: max-content; gap: var(--s-5); align-content: start; }

  @media (max-width: 640px) {
    .wrap-sheet {
      inset: auto 0 0 0; width: 100%; height: min(88svh, calc(100svh - 48px));
      filter: drop-shadow(0 -6px 0 light-dark(rgba(43, 36, 32, .14), rgba(0, 0, 0, .4)));
      transform: translateY(calc(var(--below) * -14px));
    }
    .sheet { padding-left: 0; padding-top: 5px; transition: transform 200ms var(--ease); }
    .sheet.dragging { transition: none; }
    .shead { padding: var(--s-3) var(--s-3) var(--s-3) var(--s-4); position: relative; padding-top: var(--s-5); }
    .grip { display: block; position: absolute; top: 8px; left: 50%; translate: -50% 0; width: 44px; height: 4px; border-radius: 2px; background: var(--ink-3); opacity: .6; }
    .x kbd { display: none; }
    .sbody { padding: var(--s-4); padding-bottom: calc(var(--s-6) + env(safe-area-inset-bottom, 0px)); }
  }
  @media (prefers-reduced-motion: reduce) { .wrap-sheet, .sheet { transition: none; } }
</style>
