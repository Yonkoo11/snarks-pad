# API reference

The engine serves one JSON API on `/api`. Read routes need no key. Write routes take either a wallet-signed transaction (launches) or a short signed message (shielded opt-in, receipts), never a password or a session. Every error is `{ "error": "<code>", "field": "<name>" }` with a 4xx status and never echoes what was sent. The mainnet instance answers at `https://snarks.fun/api`, the devnet instance at `https://test.snarks.fun/api`.

## Read routes

| Route | What it returns |
|---|---|
| `GET /api/coins` | The listed coins with price, market cap, 24 h volume and trades, holder count, fee tier and the split of its fee, the launch window, stage (curve or graduated) and rewards paid so far. `?all=1` includes coins outside the featured list. |
| `GET /api/coins/:mint` | One coin with the same fields, plus the live fee for the current second of its launch window and the time of the next payout. |
| `GET /api/coins/index` | The lightweight list the market page refreshes from. |
| `GET /api/tiers` | The fee tiers: each tier's fee, the shares of Meteora, holders, team and creator, the post-graduation fee, and `launchpadSigner`, the pad's common signer present in every launch transaction. |
| `GET /api/trades` | Recent trades of a coin. |
| `GET /api/events/trades` | A server-sent event stream of trades as they land. |
| `GET /api/epochs` | Every payout round with its claims, swap and batch transaction ids. |
| `GET /api/epochs/:id` | One round. `GET /api/epochs/:id/receipt` returns a wallet's own payout line against a signed message. |
| `GET /api/treasury` | The pad's public ledger: the last and next round times, whether payouts are paused, the published fee policy, the team's running totals, and fees held for coins with no eligible holder with their release dates. |
| `GET /api/stats` | Pad-wide totals for the explore page. |
| `GET /api/optin/status` | Whether a wallet is opted in to shielded delivery, shown only against a signed message from that wallet. |

## Write routes

| Route | What it does |
|---|---|
| `POST /api/uploads` | Stores a coin image before launch and returns its address. |
| `POST /api/coins/launch-tx` | Builds the launch transaction for a name, symbol, image, description, fee tier and first buy. The caller's wallet signs it first. |
| `POST /api/coins/launch-cosign` | Adds the coin's own key and the pad's signer to a wallet-signed launch transaction; refuses any transaction whose signer list differs from the one it built. |
| `POST /api/coins/confirm` | Records a sent launch once it is confirmed on chain. |
| `POST /api/optin/nonce` then `POST /api/optin` | Shielded delivery opt-in: a nonce, then a Zcash unified address and the wallet's signature over the nonce. The address is never returned by any route afterwards, including to its owner. |
| `POST /api/rewards/verify-memo` | Checks the memo of a shielded payout against the round it belongs to. |
| `POST /api/faucet` | Devnet only: test ZEC for trying the pad. |

## Limits

Per address: 10 launch builds a minute, 20 prepared launches counted for 3 minutes, 60 chain reads a minute. Pad-wide: 100 launch builds a minute, 3,000 chain reads an hour. A refused request gets `429` (per address) or `503 busy` (pad-wide); an unreadable chain gets `503 chain_unavailable`.

## For terminal and tooling builders

Everything needed to attribute, list and chart a launch is public: `launchpadSigner` on `/api/tiers`, the fee by second of the window on each coin, the tier menu with who gets what of each fee, and every round's payouts with transaction ids. Launch transactions follow the order Jupiter Studio documents: the wallet signs first, then the engine co-signs, so wallets show no warning.
