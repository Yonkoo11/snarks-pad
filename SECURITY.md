# Security review

What was reviewed, what was fixed and what is not covered. These were internal rounds run by the team with static analysis tools and manual passes over the money paths. They are not an outside audit.

## Rounds

| Round | Date | Scope | Outcome |
|---|---|---|---|
| S2 | 2026-10-01 | Supply chain of the engine's dependencies, the Meteora config values and the token integration, static analysis, a differential review of the engine, a logic pass over the round engine, claims, snapshots, payouts and the swap state machine | Findings fixed before the first devnet rounds; the DBC config numbers reviewed line by line against the program's rules |
| S3 | 2026-10-04 | Differential review of everything added since S2; configuration and operational edge cases | Go decision for devnet with the listed fixes applied |
| S4 | 2026-10-05 | Differential review of the upload, window, live fee, creator wallet, quote and listing code; a stress pass over the API and the site (hostile inputs, bursts, malformed bodies) | Input hardening and limiter fixes, each with a test |
| S5 | 2026-10-06 | Signing order, send and watch, reconcile, signed reads, the profile page, hidden coins, priority fees, the update script | Fixes applied before the mainnet deploy |
| S6 | 2026-10-07 | The product pass (six payout decisions: holder gate and orphan release, carry on a refused swap, creator wallet rules, launch flood limits, the API's own RPC budget) and a logic pass over the new code; a hostile read-only fix review of the whole diff | Three true positives fixed with tests (a chain read failure that stopped the claim loop; legacy rows of a pre-rule round resumed for good; the carry transaction's alert and counter written outside it); the fix review's open items closed before the mainnet deploy |

## What the tests pin

- Launch and co-sign order (the wallet signs first; the engine adds the coin's key and the pad's signer; a transaction whose signer list differs from the built one is refused).
- The launch window fee schedule and the launcher's first buy at the tier fee.
- Claims through the Squads vault; the DAMM v2 position fee after graduation.
- Holder samples at random moments; vault members, pool vaults and the keeper never count as holders.
- The swap state machine: refusals, refunds, the loss cap, resume without a second deposit.
- Batch payments with up to 350 outputs; detection and resend of a payout transaction that expired unmined, without paying twice.
- Per-address and pad-wide caps on launch builds and chain reads; hostile inputs on every route.

## Not covered

- No outside audit has been done.
- Graduation and the DAMM v2 position fee have run only on the local validator; no mainnet coin has filled its curve.
- The reviews read the Meteora, Squads and NEAR programs as black boxes against their documentation; they did not audit those programs.
- The site has no login and stores nothing about a visitor; a holder's shielded status is shown only after a signed message, and that path is tested, not formally verified.

## Reporting

Open an issue in this repository for anything that is not a live-money problem. For a live-money problem, contact the maintainer through the X account linked on the site before posting details.
