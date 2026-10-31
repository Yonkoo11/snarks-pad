# Snarks, the companion

The design for the pad's mascot as a living part of the product. Status of each part is marked: **built**, **next**, or **needs art**.

## What it is for

The pad's brand is "don't trust us, check". Snarks is the pad's witness. It stands next to the things that are true, moves with the product's one rhythm (the round clock), and makes the app feel inhabited without ever claiming more than the pad knows.

**The rule that keeps it honest:** motion is free, speech is fact. It may play, hop, doze and cheer for any reason. Every line it says is a number or a time the pad holds, and it never says what to do.

## Character

- **Curious, dry, brief.** A one-eyed watcher. It points at things and says what changed.
- **Voice is tape, not narrative.** Short factual lines. No exclamation marks, no emoji, no hype words, no "buy", no advice. Examples: "The next round pays in 10h 13m.", "$CRAYON: +12 holders since you followed it.", "Creator sold on $HALO."
- **It never blocks.** It stands on the top edge of cards, headings and ledger rows, and never over a button, link, field or chart. It stops moving while you type, while a sheet or the palette is open, and while the tab is hidden.

## The artwork rule

The drawing is human-made and is never redrawn, recoloured, split into parts or re-generated. The companion uses `mascot-cut.webp`, the same drawing with only the paper background removed by masking (the original `mascot.jpg` is untouched). Everything below is whole-figure motion: translate, rotate, scale and squash, plus a shadow. It is never mirrored, because the ZEC card carries a "Z".

## Motion language

One figure, so the life comes from timing. Twelve moves, each named so they can be tuned in one place:

| Move | What it is | Timing | Notes |
| --- | --- | --- | --- |
| Arrive | Slides in from the right edge with a hop and a settle | 900 ms | once per visit |
| Hop | Crouch (anticipation), arc, land squash, settle | 520 to 1150 ms by distance | arc height grows with distance; tilts into the direction of travel |
| Leap | A long hop with a half turn of tilt for distances over 500 px | 900 to 1300 ms | |
| Breathe | 1.5% scale swell on the feet | 3.2 s loop | while perched |
| Look | Tilts up to 5 degrees toward the pointer when it is within 240 px | follows, eased | attention without eyes |
| Doze | Slow rock, a little smaller | 3.4 s loop | after 24 s of no input |
| Sleep | The doze deepens: smaller, quieter | after 2 minutes | wakes on any input |
| Wave | Wiggle of ±12 degrees, three beats, on a small hop | 900 ms | round paid |
| Cheer | Two quick hops, a full turn on the second | 1.2 s | a coin graduated |
| Alert | Leans back 10 degrees and holds | 1.4 s | the creator of a coin it follows sold |
| Carry | Hangs from the pointer and swings like a pendulum with spring damping | live | drag |
| Settle | After a drop, a small overshoot then rest | 450 ms | |

Springs, not tweens, for everything that follows the pointer (Look, Carry): stiffness 170, damping 18, mass 1. Hops use authored keyframes so they read the same everywhere.

**Reduced motion and phones.** With reduced motion every move collapses to a still frame and a cut. On a phone (800 px and under) it does not roam: it stands in the corner above the tape's line, and a press still hops it once and says a fact.

## Behaviour

States: Away, Arriving, Perched, Wandering, Curious, Dozing, Sleeping, Carried, Reacting, Hidden.

- Wanders every 7 to 14 s while the tab is in use and nothing is happening, one hop at a time, preferring the coin it follows.
- Never hops while you type, while a sheet or the palette is open, or when a control is under where it would land (checked against every clickable element's box, not a few sample points).
- Re-checks its footing every two seconds: if the page shifted under it (images loading, a panel opening) it steps back to the edge.
- One setting: Roam, Stay or Away, kept in this browser, reachable from the palette (`> snarks away`) and from its own menu.

## What it reacts to (real events only)

| Event | Source | Reaction | Line |
| --- | --- | --- | --- |
| A round paid | `/epochs` newest id changes | Wave | "Round 8 paid 52 wallets." |
| A coin graduated | coin list `graduatedAt` newer than this visit | Cheer | "$SYM graduated to Meteora." |
| A followed coin gained holders | coin read against the follow snapshot | Hop to it | "$SYM: +12 holders since you followed it." |
| The creator of a followed coin sold | the coin's trades, tagged creator, sell | Alert | "Creator sold on $SYM." |
| You pressed it | you | Small hop | the nearest fact: the followed coin, the next round, the last round |
| You dropped it on a coin | you | Follow, then hop onto it | "Following $SYM. I will say what changes." |
| You re-hashed a round | the verify check | Lean, then settle | the real step, then the result |
| You sealed shielded delivery | the opt-in call | Rises from the envelope | only when the pad confirms |

Nothing fires from a guess, a timer, or a number it does not have.

## The scenes

Snarks is one character with a scene per job, so the app does not need a different mascot picture in every corner.

1. **Verify** (built as a separate figure, to be folded in): leans toward the hash while your browser computes, settles beside the stamp on a match, turns away on a mismatch.
2. **Envelope** (built as a separate figure): the hold lifts it halfway, a pending request keeps it there, only success lets it out.
3. **Follow** (built): drag it onto any coin to follow it; it sits on that coin from then on and reports what changed.
4. **Compare**: walks along the tops of the pinned coins when the compare shelf is open.
5. **Tape**: sits on the tape rail's header and bounces once on a big trade.
6. **Chart**: perches at the right edge of the chart and nods at a round line when the crosshair reaches one.
7. **Launch**: sits on the preview card and stamps it only when the launch is confirmed on chain.

## How it grows the product

- **A card worth posting.** "Snarks followed $SYM: +12 holders, 0.4 ZEC paid, since 3 days ago" as a shareable image, generated from the real deltas and carrying its receipts. People post proof, not hype.
- **A reason to come back that is not a streak.** The companion is where followed coins and the round clock meet: open the pad and it tells you what moved.
- **A brand you can screenshot.** One drawing, always in the pad's paper style, always standing on something real.

## What needs art

One drawing carries everything above. The single biggest upgrade is a small set of poses drawn by the same artist, in the same crayon style: **sleeping, cheering, alert, pointing, carrying an envelope, sitting, looking up**. The engine already reads poses from one manifest (`web/src/lib/palPoses.ts`), so adding a drawing is adding a file and a line. Until then every pose shows the standing drawing and the motion carries the meaning.

## Performance and access

- Animation uses the Web Animations API and a spring loop only while something is moving; nothing runs per frame at rest.
- The figure is one absolutely positioned element, moved by transform only.
- Bubbles are polite live regions. The figure is focusable; Enter or Space says a fact. Esc closes a bubble.
- Measured before it is shown to anyone: dropped frames and the 95th percentile frame time on a phone and a mid-range laptop, as with every other motion in the app.

## Order of work

1. **Engine and reactions** (this pass): robust footing, breathe, look, the full move set, the real-event reactions, the menu, the pose manifest.
2. **Scenes folded in:** Verify and Envelope become Snarks moving, not separate figures.
3. **Follow, deepened and shared:** the shareable card, the compare walk, the tape and chart scenes.
4. **Measured polish.**
5. **Artist poses**, when available.
