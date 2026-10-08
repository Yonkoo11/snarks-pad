# SNARKS pad, web

The site for the unofficial ZEC launchpad whose holder rewards can arrive shielded. Svelte 5 + Vite, plain SPA with a hash router.

## Run

```bash
cd web
npm install
npm run dev            # mock mode (default): every screen works in the browser, no engine needed
VITE_API=real npm run dev   # talk to the engine at http://localhost:8787/api
npm run build          # production build into web/dist
npm run check          # svelte-check + tsc
```

Optional env (never put secrets here, none are needed):

| var | default | what |
|---|---|---|
| `VITE_API` | unset (mock) | `real` switches from the in-browser mock to the engine API |
| `VITE_API_BASE` | `http://localhost:8787/api` | engine base URL |
| `VITE_RPC` | `http://127.0.0.1:8899` | Solana RPC used to send signed launch/trade transactions in real mode |

## Screens

| route | what |
|---|---|
| `#/` | featured $SNARKS, coin list, the rewards one-liner, hidden / not hidden list |
| `#/coin/<mint>` | price, curve progress under the trade box, rewards paid as Solana ZEC vs shielded |
| `#/launch` | name, symbol, image, description, 1-3% holder fee, optional first buy |
| `#/shielded` | connect wallet, paste a unified address, sign the contract's exact message |
| `#/treasury` | treasury vs owed, every epoch with Solana sigs and Zcash txids, simulated legs labelled |

A mode banner shows on every route unless the engine reports `x-pad-mode: mainnet`.

## Wallets

Injected providers: Phantom, Backpack, Solflare (`signMessage` for opt-in, `signTransaction` for launch and trade). When the pad is not on mainnet there is also a "Test wallet (this tab only)": a real ed25519 key held in sessionStorage.

## Mock mode: what is real and what is not

- Real: ed25519 signatures. The mock verifies the opt-in and opt-out message signatures and the fee payer's signature on launch/trade transactions exactly as the engine should.
- Made up: every coin, price, trade, holder count, reward total, treasury number and epoch.
- The mock cannot decode unified-address receivers. It accepts any well-formed `u1…` of plausible length and rejects `t…` and `zs…` addresses with `no_orchard_receiver`. The engine is the real check.
- Launch/trade "send" in mock mode stops at the signature check; nothing reaches a cluster.

## QA

`qa/*.png` are screenshots of every screen at 1440 and 390 wide, light and dark. `qa/flow-check.cjs` drives the opt-in, opt-out, trade and launch flows in headless Chrome against the dev server on port 5199 (it loads puppeteer from the global MCP puppeteer install on this machine).

```bash
npx vite --port 5199 --strictPort &
node qa/flow-check.cjs      # prints PASS/FAIL per step
```

Against the real local stack (engine API on :8787 over solana-test-validator + Zcash regtest; start it with `cd ../engine && bun run e2e && bun run api`):

```bash
node qa/real-flow.cjs       # 32 checks: opt-in/opt-out with a real regtest UA, buy, launch, epoch payout; writes qa/REAL-FLOW-RESULT.txt
node qa/real-shots.cjs      # home, coin, opt-in (after success), treasury at 1440 and 390 into qa/real/
```

Both start their own Vite (`VITE_API=real`) on :5198 and use a fake injected Phantom provider whose key stays in the Node process. That code lives only in `qa/`; it is not in the built bundle.

In real mode the launch form takes an image link only (the engine has no image hosting and writes the link on chain, 200 characters max).
