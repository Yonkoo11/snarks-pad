# For the creator: what is left, and what is yours to decide

Everything on this branch is built against the engine as it is today. This page lists what only the owner can do or decide. Each item says what it unlocks and what the page does until then.

## Engine work (details in ENGINE-REQUESTS.md)

- **Candles and pool trades from the engine (item 0).** The chart now reads GeckoTerminal's free API from the visitor's browser: about 30 reads a minute, commercial terms not confirmed. This is the one dependency on a third party in the main screen. Items 1 to 8 in the same file each unlock a dash or a missing panel.

## Configuration

- **`VITE_CHART_SOURCE=recorded`** turns the third-party chart provider off for a build.
- **Expose the keeper's address** (ENGINE-REQUESTS item 9) so the round check can compare the memo's signer.

- **Set `VITE_RPC` to a mainnet RPC for the production build.** The round check reads the memo transaction through it. If it is missing or points at localhost the check says the memo could not be read.
- **Confirm the ZEC mint the pad names on mainnet** answers on the RPC chosen, since holdings and the check both use it.

## Decisions

- **Copy that is yours.** The How page text was shortened earlier on this branch. It needs a yes.
- **Snarks defaults.** It roams on a wide screen and starts Away on a phone. Say if the default should differ.
- **Confetti.** One small burst of paper-coloured scraps on a graduation, off under reduced motion. Remove the import in `Companion.svelte` (`confettiFrom`) if unwanted.
- **Chart attribution.** The chart library's licence needs its attribution shown; it is.

## Art

- **Poses.** One drawing carries all motion. A set of poses in the same hand (sleeping, cheering, alert, pointing, carrying an envelope, sitting, looking up) would lift every scene. The engine reads them from `web/src/lib/palPoses.ts`: a file and a line each.
- **A larger cutout.** `mascot-cut.webp` is 260 by 373. On the front page the figure stands at 1.5 times its size, so a 520 by 746 cutout would stay sharp on high-density screens.

## Not measured, not built

- **Not measured:** frame times (rAF p95) on a phone and a mid-range laptop, iOS Safari, a real device, the memo check against a live mainnet transaction.
- **Not built:** the companion's compare walk, tape and chart scenes; the Verify witness and the shielded envelope as the same moving figure; rethinks of the Coin, Launch, Me, Payouts and How pages beyond what is here.
- **Mock only:** most screens were checked against the mock engine. The real engine was read on a few pages only, and it answers slowly (2 s and more).
