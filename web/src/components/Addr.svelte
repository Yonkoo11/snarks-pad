<script lang="ts">
  import { short } from '../lib/format'
  // A long chain id (address, signature, txid) shown short, with the full value in the title and a Copy button beside it.
  // With `href` the short text is a link (an explorer); without one, copying is the only way to take the id away.
  let { value, head = 6, tail = 6, href = null, label = 'id' }: { value: string; head?: number; tail?: number; href?: string | null; label?: string } = $props()
  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  async function copy() {
    try { await navigator.clipboard.writeText(value); copied = true } catch { copied = false }
    clearTimeout(timer)
    timer = setTimeout(() => (copied = false), 1600)
  }
</script>

<span class="addr">
  {#if href}<a class="mono" {href} target="_blank" rel="noreferrer" title={value}>{short(value, head, tail)}</a>
  {:else}<span class="mono" title={value}>{short(value, head, tail)}</span>{/if}
  <button class="copy caps" type="button" onclick={copy} aria-label="Copy the {label}">{copied ? 'Copied' : 'Copy'}</button>
</span>

<style>
  .addr { display: inline-flex; align-items: center; gap: var(--s-1); max-width: 100%; }
  /* the link and the button both answer a 44px-tall touch, without growing the line they sit in */
  .addr a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--ink-3); display: inline-flex; align-items: center; min-height: 44px; margin: -12px 0; }
  /* a 44px hit area on a 12px word: the negative margin keeps the line height where it was */
  .copy {
    font: inherit; font-size: var(--t-12); font-weight: 700; letter-spacing: .04em; color: var(--ink-2);
    background: none; border: 0; padding: 0 var(--s-1); min-height: 44px; min-width: 44px; margin: -12px 0; cursor: pointer; border-radius: var(--r-xs);
    transition: color var(--d-fn) var(--ease), transform var(--d-fn) var(--ease);
  }
  @media (hover: hover) { .copy:hover { color: var(--ink); transform: translateY(-1px); } }
  .copy:active { transform: translateY(0); transition-duration: var(--d-press); }
</style>
