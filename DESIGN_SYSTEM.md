# SNARKS pad design system

Extracted 2026-10-01 from the built web app (web/src/app.css and components), after `design-check.sh` exited 0. Direction: design/direction.md, Direction A "Fridge door, working". Values here are the ones the code uses; change the code first, then this file.

## Identity
The owner's crayon drawing of a pink pizza-slice monster holding a ZEC card is taped to the paper it was drawn on, and the page around it states fees, prices and payouts in plain, legible type. The accent is crayon pink #c42f6c (dark theme #f07aa8), taken from the drawing, used on the headline's payoff word, primary buttons, focus rings and the hatch. Signature device: pink crayon hatching marks what is shielded, and nothing else (shielded share of every split bar, shielded totals and keys, hidden items in the hidden / not-hidden list, the opt-in panels, the treasury's shielded leg). The drawing (web/public/mascot.jpg) is human-made; never recolour it: in the dark theme it stays on its taped cream card.

## Tokens
- Ground and surfaces, light: `--paper #f5efe2` (ground), `--paper-2 #fbf7ee` (raised), `--paper-3 #ece4d2` (sunk). Dark: `#1f1b18`, `#29241f`, `#17130f`. The page follows the OS; `[data-theme]` overrides.
- Ink: `--ink #2b2420`, `--ink-2 #5e544c`, `--ink-3 #6f6457`; dark `#efe7da`, `#bdb2a4`, `#978c80`. Lines `--line rgba(43,36,32,.14)`.
- Accent: `--pink #c42f6c`, `--pink-ink #fbf7ee` (text on pink), `--pink-soft rgba(196,47,108,.12)`. Semantic: `--bad #9c2b1f` (dark `#ff8f7f`), always with a "!" mark and words. Mode banner: `--warn-bg` / `--warn-ink` (inverted ink).
- Type: Gaegu 700 for h1/h2 only; Atkinson Hyperlegible 400/700 for everything people read; JetBrains Mono 400/500 for machine values (addresses, signatures, txids, amounts, percents) with `tabular-nums`. Scale `--t-12 12px`, `--t-14 14px`, `--t-16 16px`, `--t-20 20px`, Home fee line 18px, `--t-display clamp(38px, 4vw, 56px)`, `--t-h2 clamp(28px, 3vw, 36px)`. Display line-height 1, tracking -0.01em; body 1.5.
- Spacing: 4px step, `--s-1..--s-9` = 4, 8, 12, 16, 24, 32, 48, 64, 96px.
- Radius by role: `--r-xs 3px` (marks, keys, paper corners), `--r-sm 6px` (inputs, small chips), `--r-md 12px` (buttons, nav links), `--r-lg 18px` (panels), `--r-full 999px` (chips, bars).
- Shadow: `--sh-1 0 2px 0 var(--line)`, `--sh-2 3px 4px 0 rgba(43,36,32,.16)`, `--sh-3 6px 8px 0 rgba(43,36,32,.18)`; dark `.45` / `.5` black.

## Craft
- Radius scale (CF-1): the five tokens above; components reference them, no literals.
- Surface steps (CF-2): ground `--paper`, raised panels `--paper-2` plus `--sh-2`, sunk tracks and tabs `--paper-3`. No 1px border as elevation; hairline `--line` only for table rows.
- Shadow philosophy (CF-5): pixel-offset, hard 0-blur shadows at a 3:4 ratio, like paper cut-outs. `.panel { background: var(--paper-2); border-radius: var(--r-lg); box-shadow: var(--sh-2); }`; dark adds `inset 0 1px 0 rgba(239,231,218,.07)`.
- Glass (CF-3): not used.
- Hover (inside `@media (hover: hover)`): buttons `translateY(-2px)` and `--sh-2` to `--sh-3`; table rows `--paper-2` background and `translateX(2px)`; nav links ink colour and `translateY(-1px)`. Press: `translateY(1px)`, `--sh-1`, 100ms.
- Focus: `:focus-visible { outline: 3px solid var(--pink); outline-offset: 2px; }`; inputs switch border to `--pink`.
- The hatch: `.hatch { background: repeating-linear-gradient(-55deg, var(--pink) 0 3px, transparent 3px 6px), var(--pink-soft); }`. Only on shielded things.

## Primitives
- Button: `.btn` (48px min height, 0 24px padding, `--r-md`, 700 weight, `--paper-3` fill, `--sh-2`); `.btn.primary` (pink fill, `--pink-ink` text); `.btn.ghost` (transparent, `inset 0 0 0 2px var(--line)`); `.btn.block` (full width).
- Input: `.input` (48px min height, 16px text, `--paper` fill, 2px `--line` border, `--r-sm`), `aria-invalid` turns the border `--bad`; `.field` wraps label, input and help text.
- Card: `.panel` (see Craft); hatched band: a 6px `.hatch` strip across the top of an opt-in panel.
- Badge: `.chip` (12px caps, `--r-full`, `--paper-3`); `.chip.sim` outlined, for "simulated".
- Components: Taped (the drawing, -2deg, two tape strips), CurveBar (solid `--ink-2` fill with a triangle cap), FeeSplit (Meteora 20% outline segment, holders 10% with Solana ZEC solid and shielded hatched, team 70% outline segment; the live strip reads the API policy), HiddenList (verbatim contract list, hatched marks on hidden items), ModeBanner, PauseBanner.

## Motion
- Curve: `--ease cubic-bezier(.16,1,.3,1)`, the only one.
- Durations: `--d-fn 160ms` (hover, toggles, colour), `--d-press 100ms` (press), `--d-in 700ms` (the entrance).
- Entrance: the taped drawing on Home settles from `rotate(-4deg) translateY(12px)` to `rotate(-2deg)` once.
- Loops: none. The next-payout countdown changes its text every second without animation.
- Reduced motion: all animations and transitions `.01ms`, `scroll-behavior: auto`, `.taped { animation: none }`.
- Never `transition: all`; only transform, opacity, colour and shadow animate.
