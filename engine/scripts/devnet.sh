#!/usr/bin/env bash
# Runs any command with the devnet settings (Solana devnet + Zcash testnet). The settings file engine/data/devnet.vars
# holds paths and public addresses only (written by devnet-init.ts, gitignored); the Helius key is read by the engine
# itself from ~/.config/snarks-pad/rpc.env and never passes through here.
#   scripts/devnet.sh bun run api
#   scripts/devnet.sh --set KEY=VALUE        record one more setting (multisig, config id)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=data/devnet.vars
if [ "${1:-}" = "--set" ]; then
  key="${2%%=*}"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  printf '%s\n' "$2" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  exit 0
fi
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
export PAD_MODE=devnet
exec "$@"
