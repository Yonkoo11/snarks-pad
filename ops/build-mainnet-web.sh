#!/usr/bin/env bash
# Builds the MAINNET site and places it where ops/switch-live.sh serves it from (/opt/snarksm/web). Runs on the Mac.
# The browser's Solana connection is the owner's Alchemy app, locked on Alchemy's side to the snarks.fun origin (checked
# 2026-10-06: other origins and no origin answer 403). The key is read from ~/.config/snarks-pad/rpc-alchemy.env (override
# ALCHEMY_ENV_FILE) and lives only in the build's environment; it is public in the bundle by design. The server's Helius key
# is never used here, and the built bundle is checked for it.
#   ops/build-mainnet-web.sh            build, check, place
#   ops/build-mainnet-web.sh --no-place build and check only
HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf"; [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ] && . "$HOST_CONF"
set -euo pipefail
cd "$(dirname "$0")/.."
. ops/envfile.sh
FILE="${ALCHEMY_ENV_FILE:-$HOME/.config/snarks-pad/rpc-alchemy.env}"
HOST="${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}"
OUT=dist-mainnet
key="$(value_of "$FILE" ALCHEMY_API_KEY)"
[ -n "$key" ] || { echo "no ALCHEMY_API_KEY line in $FILE" >&2; exit 1; }
printf '%s\n' "$key" | grep -qE '^[A-Za-z0-9_-]{16,64}$' || { echo "ALCHEMY_API_KEY in $FILE is not shaped like a key; not building" >&2; exit 1; }
( cd web && VITE_API=real VITE_API_BASE=/api VITE_RPC="https://solana-mainnet.g.alchemy.com/v2/$key" npx vite build --outDir "$OUT" --emptyOutDir > /dev/null )
unset key
js="$(cat web/$OUT/assets/*.js)"
grep -q 'solana-mainnet.g.alchemy.com' <<< "$js" || { echo "the bundle does not name the mainnet connection; not placing it" >&2; exit 1; }
if grep -qiE 'helius|api\.devnet\.solana\.com' <<< "$js"; then echo "the bundle names Helius or devnet; not placing it" >&2; exit 1; fi
echo "built web/$OUT: mainnet connection present, no Helius, no devnet"
[ "${1:-}" = "--no-place" ] && exit 0
ssh -o BatchMode=yes "$HOST" 'sudo mkdir -p /opt/snarksm/web && sudo chown -R deploy:deploy /opt/snarksm/web'
rsync -rl -c --no-owner --no-group --chmod=D755,F644 --delete-after "web/$OUT/" "$HOST:/opt/snarksm/web/"
ssh -o BatchMode=yes "$HOST" 'sudo chown -R root:root /opt/snarksm/web && ls /opt/snarksm/web | head -5 && echo "placed in /opt/snarksm/web (served only after ops/switch-live.sh snarksm)"'
