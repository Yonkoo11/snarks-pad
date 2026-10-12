#!/usr/bin/env bash
# Sets one non-secret key in an instance's engine env file on the server and restarts the keeper and the API:
#   bash ops/set-env.sh snarksm TEAM_WALLET <solana pubkey>     or     ... TEAM_WALLET @ops/team-wallet.pub
# `@file` reads the value from a local file (one line); a bare `@name` means ops/name. Short form for the common case:
#   bash ops/set-env.sh TEAM_WALLET        = snarksm, value from ops/team-wallet.pub (the key, lowercased, _ to -)
# The short form exists because the owner's prompt inserts a line break past about 80 columns and a broken line ran as
# separate commands twice on 2026-10-12.
# Exists for the same reason as ops/round.sh: the full ssh line wraps in a terminal and the wrapped line runs as
# four broken commands (seen 2026-10-12, nothing was written). The key is replaced if present, appended if not.
# Secrets never go through this script: they live in secrets.env, which it does not touch.
HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf"; [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ] && . "$HOST_CONF"
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -eq 1 ]; then INSTANCE=snarksm; KEY="$1"; VALUE="@$(printf '%s' "$1" | tr 'A-Z_' 'a-z-').pub"; else INSTANCE="${1:-}"; KEY="${2:-}"; VALUE="${3:-}"; fi
HOST="${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}"
case "$INSTANCE" in snarks|snarksm) ;; *) echo "usage: ops/set-env.sh snarks|snarksm KEY VALUE" >&2; exit 2 ;; esac
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]+$ ]] || { echo "KEY must look like TEAM_WALLET" >&2; exit 2; }
if [[ "$VALUE" == @* ]]; then F="${VALUE#@}"; [[ "$F" == */* ]] || F="$OPS_DIR/$F"; VALUE="$(head -1 "$F" | tr -d '[:space:]')"; fi
[[ "$VALUE" =~ ^[A-Za-z0-9._:/@-]+$ ]] || { echo "VALUE may hold letters, digits and . _ : / @ - only" >&2; exit 2; }
case "$KEY" in *SECRET*|*TOKEN*|*KEY*|*PASS*) echo "$KEY looks like a secret; put it in secrets.env on the server yourself" >&2; exit 2 ;; esac
# One line on the far side, under sudo sh: drop any existing KEY= line, append the new one, write back in place (keeps the
# file's owner and mode), then print how many KEY= lines the file has (expected: 1). No shell variables cross the ssh boundary.
P="/etc/$INSTANCE/engine.env"
REMOTE="umask 077; grep -v '^$KEY=' $P > $P.tmp; printf '%s\\n' '$KEY=$VALUE' >> $P.tmp; cat $P.tmp > $P; rm $P.tmp; grep -c '^$KEY=' $P"
exec ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "sudo sh -c \"$REMOTE\" && sudo systemctl restart $INSTANCE-keeper $INSTANCE-api && sudo systemctl is-active $INSTANCE-keeper $INSTANCE-api"
