<script lang="ts">
  // The payout rounds as layers of ground. Newest on top; each band's thickness is the number of wallets that round paid
  // (printed as n), never a guess, with a minimum so a small round stays legible. The pink hatched part of a band is the share
  // of its wallets paid shielded; the rest is plain. Older rounds fade, and the note says so. A scrubber walks the layers;
  // the wax at the end of a band says whether THIS device has re-hashed that round's holder file.
  import type { Epoch } from '../lib/types'
  import { zec } from '../lib/format'

  const { epochs, checked, onshow }: { epochs: Epoch[]; checked: string[]; onshow: (id: string) => void } = $props()
  const MAX = 24
  const MIN_H = 30
  const MAX_H = 120
  const shown = $derived(epochs.slice(0, MAX))
  const nOf = (e: Epoch) => e.solanaPayouts.count + e.shielded.count
  const maxN = $derived(Math.max(1, ...shown.map(nOf)))
  const height = (e: Epoch) => (nOf(e) === 0 ? MIN_H : Math.round(MIN_H + (nOf(e) / maxN) * (MAX_H - MIN_H)))
  const shieldedShare = (e: Epoch) => (nOf(e) === 0 ? 0 : e.shielded.count / nOf(e))
  const numberOf = (e: Epoch) => epochs.length - epochs.indexOf(e)
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  let sel = $state(0) // index into `shown`
  const cur = $derived(shown[Math.min(sel, shown.length - 1)])
  const wax = (e: Epoch): 'here' | 'not-yet' | 'none' => (checked.includes(e.id) ? 'here' : e.snapshot ? 'not-yet' : 'none')
  const waxText = { here: 're-hashed on this device', 'not-yet': 'not re-hashed on this device yet', none: 'no holder file to re-hash' } as const
</script>

<section class="strata" aria-labelledby="strata-h">
  <div class="sh">
    <h2 class="h2" id="strata-h">The rounds, as layers</h2>
    <p class="muted measure">Newest on top. A band is as thick as the number of wallets that round paid, <span class="mono">n</span> printed on it. The pink hatched part is the share paid shielded. Older rounds fade. {#if epochs.length > MAX}Showing the newest {MAX} of {epochs.length}.{/if}</p>
  </div>

  <div class="scrub">
    <label for="strata-r" class="label">Walk the layers</label>
    <input id="strata-r" type="range" min="0" max={shown.length - 1} step="1" bind:value={sel} aria-valuetext="Round {numberOf(cur)}, {day(cur.at)}" />
    <span class="mono small">round {numberOf(cur)}, {day(cur.at)}</span>
  </div>

  <ol class="bands" aria-label="Payout rounds, newest first">
    {#each shown as e, i (e.id)}
      <li class="band" class:on={i === sel} style:--h="{height(e)}px" style:--fade={Math.max(0.55, 1 - i * 0.025)}>
        <button type="button" onclick={() => (sel = i)} aria-pressed={i === sel} aria-label="Round {numberOf(e)}, {day(e.at)}, {nOf(e)} wallets paid">
          <span class="id mono">#{numberOf(e)}</span>
          <span class="date muted">{day(e.at)}</span>
          <span class="body" aria-hidden="true">
            <span class="plain" style:width="{(1 - shieldedShare(e)) * 100}%"></span>
            <span class="shd hatch" style:width="{shieldedShare(e) * 100}%"></span>
          </span>
          <span class="n mono">n={nOf(e)}</span>
          <span class="wax {wax(e)}" title={waxText[wax(e)]} aria-hidden="true"></span>
        </button>
      </li>
    {/each}
  </ol>

  <div class="detail" aria-live="polite">
    <p class="dt"><strong>Round {numberOf(cur)}</strong>, {new Date(cur.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p>
    <dl>
      <div><dt class="label">Wallets paid</dt><dd class="mono">{nOf(cur)} ({cur.solanaPayouts.count} Solana, {cur.shielded.count} shielded)</dd></div>
      <div><dt class="label">To holders</dt><dd class="mono">{zec(cur.split.holdersZats)} ZEC</dd></div>
      <div><dt class="label">This device</dt><dd>{waxText[wax(cur)]}</dd></div>
    </dl>
    <button class="btn ghost jump" type="button" onclick={() => onshow(cur.id)}>Show it in the list</button>
  </div>
</section>

<style>
  .strata { display: grid; gap: var(--s-4); }
  .sh { display: grid; gap: var(--s-2); }
  .scrub { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
  .scrub input { flex: 1 1 200px; min-width: 120px; accent-color: var(--ink); min-height: 44px; }
  .small { font-size: var(--t-12); }
  .bands { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
  .band { height: var(--h); opacity: var(--fade); transition: opacity var(--d-fn) var(--ease), transform var(--d-fn) var(--ease); }
  .band.on { opacity: 1; transform: translateX(6px); }
  .band button {
    width: 100%; height: 100%; display: grid; grid-template-columns: 46px 54px minmax(0, 1fr) 56px 14px; gap: var(--s-3); align-items: center; padding: 0 var(--s-3);
    border: 0; border-radius: var(--r-xs); background: var(--paper-3); color: inherit; font: inherit; font-size: var(--t-12); cursor: pointer; text-align: left;
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .band.on button { box-shadow: inset 0 0 0 1.5px var(--ink); background: var(--paper-2); }
  @media (hover: hover) { .band button:hover { background: var(--paper-2); } }
  .id { font-weight: 700; }
  .date { white-space: nowrap; }
  .body { display: flex; height: 100%; max-height: calc(var(--h) - 12px); align-self: center; min-width: 0; border-radius: 2px; overflow: hidden; background: repeating-linear-gradient(0deg, transparent 0 5px, var(--line) 5px 6px); }
  .plain { background: transparent; }
  .shd { min-width: 0; }
  .n { text-align: right; white-space: nowrap; }
  .wax { width: 12px; height: 12px; border-radius: var(--r-full); border: 1.5px solid var(--ink-3); background: var(--ink-3); opacity: .5; }
  .wax.here { border-color: var(--good); background: var(--good); opacity: 1; }
  .wax.none { background: transparent; border-style: dashed; }
  .detail { display: grid; gap: var(--s-2); padding: var(--s-3) var(--s-4); background: var(--paper-2); border-radius: var(--r-xs); box-shadow: var(--sh-1); }
  .dt { margin: 0; }
  dl { display: flex; gap: var(--s-2) var(--s-6); flex-wrap: wrap; margin: 0; }
  dd { margin: 0; font-size: var(--t-14); }
  .jump { min-height: 44px; width: max-content; font-size: var(--t-14); }
  @media (max-width: 640px) { .band button { grid-template-columns: 38px 46px minmax(0, 1fr) 48px 12px; gap: var(--s-2); padding: 0 var(--s-2); } }
  /* scrolled into view, a band settles into its place; no support, no motion */
  @supports (animation-timeline: view()) {
    @media (prefers-reduced-motion: no-preference) {
      .band { animation: settle linear both; animation-timeline: view(); animation-range: entry 0% entry 80%; }
      @keyframes settle { from { opacity: 0; transform: translateY(18px); } to { opacity: var(--fade); transform: none; } }
      .band.on { animation: none; }
    }
  }
  @media (prefers-reduced-motion: reduce) { .band { transition: none; } .band.on { transform: none; } }
</style>
