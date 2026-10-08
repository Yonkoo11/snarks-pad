<script lang="ts">
  import { api } from '../lib/api'
  import type { UploadedImage } from '../lib/types'
  import { ACCEPT, PICK_TEXT, canRetry, pickFile, problemWith, sizeText, uploadErrorText } from '../lib/upload'
  import CoinImage from './CoinImage.svelte'

  // The coin's picture, from the creator's device: click, drop (anywhere on the page) or paste. The first bytes of the file decide whether it is
  // a picture at all (lib/upload.ts) and the engine stores a clean copy (POST /uploads) and says where. `imageUrl` is that address ('' until it is
  // there); `shown` is what to draw right now, the local file the moment it is picked, so the preview never waits for the network; `hold` tells the
  // form to keep Launch off: 'sending' while the copy travels, 'failed' until the creator tries again or removes the picture.
  type Hold = 'sending' | 'failed' | null
  let { imageUrl = $bindable(''), shown = $bindable(''), hold = $bindable(null), symbol = '' }: { imageUrl?: string; shown?: string; hold?: Hold; symbol?: string } = $props()
  const id = $props.id()

  let file = $state<File | null>(null)
  let stored = $state<UploadedImage | null>(null)
  let note = $state<string | null>(null) // why the last pick was refused, or why the upload did not work
  let again = $state(false) // whether sending the same file again can help
  let over = $state(false) // a file is being dragged over the page
  let input = $state<HTMLInputElement>()
  let ticket = 0 // a newer pick, or a removal, makes an older answer stale
  let local = '' // the object address of the picked file, revoked when it is replaced

  function showLocal(f: File | null) {
    if (local) URL.revokeObjectURL(local)
    local = f ? URL.createObjectURL(f) : ''
    shown = local
    file = f
  }

  async function send(f: File) {
    const mine = ++ticket
    hold = 'sending'; note = null
    try {
      const up = await api.upload(f)
      if (mine !== ticket) return
      stored = up; imageUrl = up.url; hold = null
    } catch (e) {
      if (mine !== ticket) return
      note = uploadErrorText(e); again = canRetry(e); hold = 'failed'
    }
  }

  async function choose(f: File | null) {
    if (!f) return
    const problem = await problemWith(f)
    if (problem) { note = PICK_TEXT[problem]; again = false; return } // what was there stays
    stored = null; imageUrl = ''
    showLocal(f)
    await send(f)
  }

  function remove() {
    ticket++
    showLocal(null)
    stored = null; imageUrl = ''; hold = null; note = null
  }

  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
  function onPick(e: Event) {
    const el = e.currentTarget as HTMLInputElement
    const f = el.files?.[0] ?? null
    el.value = '' // the same file can be picked again later
    choose(f)
  }
  function onOver(e: DragEvent) { if (hasFiles(e)) { e.preventDefault(); over = true } }
  function onLeave(e: DragEvent) { if (e.relatedTarget === null) over = false }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault(); over = false
    choose(pickFile(e.dataTransfer?.files))
  }
  function onPaste(e: ClipboardEvent) {
    const f = pickFile(e.clipboardData?.files)
    if (f) { e.preventDefault(); choose(f) }
  }
  $effect(() => () => { if (local) URL.revokeObjectURL(local) })
</script>

<!-- A file dropped anywhere on the page would otherwise open in the tab and leave the form; the page takes it as the coin's picture instead. -->
<svelte:window onpaste={onPaste} ondragover={onOver} ondragenter={onOver} ondragleave={onLeave} ondrop={onDrop} />

<div class="field image" class:over>
  <span id="{id}-l">Coin image</span>
  <input class="file" type="file" accept={ACCEPT} tabindex="-1" aria-label="Choose a coin image file" bind:this={input} onchange={onPick} />
  {#if shown}
    <div class="picked" role="group" aria-labelledby="{id}-l">
      <CoinImage src={shown} symbol={symbol || '?'} size={96} />
      <div class="info">
        <p class="status" role="status">
          {#if hold === 'sending'}Uploading…{:else if hold === 'failed'}Not uploaded.{:else if stored}Uploaded. {stored.width} × {stored.height}, {sizeText(stored.bytes)}.{/if}
        </p>
        <div class="acts">
          {#if hold === 'failed' && again && file}<button type="button" class="btn" onclick={() => file && send(file)}>Try again</button>{/if}
          <button type="button" class="btn ghost" onclick={() => input?.click()}>Replace</button>
          <button type="button" class="btn ghost" onclick={remove}>Remove</button>
        </div>
      </div>
    </div>
  {:else}
    <button type="button" class="drop" aria-labelledby="{id}-l {id}-t" aria-describedby="{id}-h" onclick={() => input?.click()}>
      <span class="t" id="{id}-t">{over ? 'Drop it to use this image' : 'Drop an image here, or click to browse'}</span>
      <span class="s" id="{id}-h">PNG, JPG, GIF or WEBP, square looks best, up to 5 MB</span>
    </button>
  {/if}
  {#if note}<small class="error" role="alert">{note}</small>{/if}
</div>

<style>
  .image { position: relative; }
  /* a file input that is there for the file chooser and for tests, but never drawn: the dashed button opens it */
  .file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; pointer-events: none; }
  .drop {
    display: grid; align-content: center; justify-items: center; gap: var(--s-2); width: 100%; min-height: 176px; padding: var(--s-5);
    border: 2px dashed var(--ink-3); border-radius: var(--r-md); background: var(--paper); color: var(--ink); text-align: center; cursor: pointer;
    transition: border-color var(--d-fn) var(--ease), background-color var(--d-fn) var(--ease), box-shadow var(--d-fn) var(--ease);
  }
  .drop .t { font-weight: 700; font-size: var(--t-16); }
  .drop .s { font-size: var(--t-14); color: var(--ink-2); }
  @media (hover: hover) { .drop:hover { border-color: var(--ink); box-shadow: var(--sh-2); } }
  .drop:active { box-shadow: var(--sh-1); transition-duration: var(--d-press); }
  .over .drop { border-style: solid; border-color: var(--ink); background: var(--paper-3); }
  .picked {
    display: flex; gap: var(--s-4); align-items: center; padding: var(--s-3); border-radius: var(--r-md); background: var(--paper);
    box-shadow: inset 0 0 0 2px var(--line); transition: box-shadow var(--d-fn) var(--ease), background-color var(--d-fn) var(--ease);
  }
  .over .picked { box-shadow: inset 0 0 0 2px var(--ink); background: var(--paper-3); }
  .info { display: grid; gap: var(--s-2); min-width: 0; }
  .status { font-size: var(--t-14); color: var(--ink-2); min-height: 1.5em; }
  .acts { display: flex; flex-wrap: wrap; gap: var(--s-2); }
  .acts .btn { min-height: 44px; padding: 0 var(--s-4); font-size: var(--t-14); }
  @media (max-width: 520px) { .drop { min-height: 148px; padding: var(--s-4); } }
</style>
