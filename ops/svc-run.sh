#!/usr/bin/env bash
# Runs one engine command on the server exactly as the keeper unit runs: the instance's user, its two env files (systemd
# reads them as root; nothing is printed), cwd <instance>/repo/engine, the keys directory reachable. For one-off
# operator commands (scripts/epoch.ts, scripts/squads-proposals.ts, the devnet soak) without ever sourcing the secrets
# file in a shell. Run as deploy. Which instance: --instance, else SNARKS_INSTANCE, else the one whose code tree this script
# is in (/opt/snarksm/repo/ops/svc-run.sh acts on snarksm, /opt/snarks/repo/ops/svc-run.sh on snarks). It says which on stderr.
#   sudo /opt/snarks/repo/ops/svc-run.sh bun scripts/epoch.ts
#   sudo /opt/snarksm/repo/ops/svc-run.sh bun scripts/epoch.ts
#   sudo ops/svc-run.sh --name snarks-soak --detach bun stress/devnet-soak.ts run     (a transient unit; journalctl -u snarks-soak)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/instance.sh"
case "$HERE" in */opt/snarksm/*) TREE_INSTANCE=snarksm ;; *) TREE_INSTANCE=snarks ;; esac
NAME=""; DETACH=0; INSTANCE="${SNARKS_INSTANCE:-$TREE_INSTANCE}"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --detach) DETACH=1; shift ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: svc-run.sh [--instance snarks|snarksm] [--name unit] [--detach] <command...>" >&2; exit 2; }
instance_load "$INSTANCE"
echo "svc-run: instance $I_NAME ($I_MODE), as user $I_USER" >&2
if [ "$1" = "bun" ]; then shift; set -- "$I_BIN/bun" "$@"; fi
props=(-p "User=$I_USER" -p "Group=$I_USER" -p UMask=0007
  -p "EnvironmentFile=$I_ETC/engine.env" -p "EnvironmentFile=-$I_ETC/secrets.env"
  -p "WorkingDirectory=$I_REPO/engine" -p NoNewPrivileges=true -p PrivateTmp=true
  -p ProtectSystem=strict -p ProtectHome=true -p "ReadWritePaths=$I_DATA" -p "ReadWritePaths=$I_KEYS")
[ -n "$NAME" ] && props+=(--unit "$NAME")
if [ "$DETACH" = 1 ]; then
  exec systemd-run --collect "${props[@]}" "$@"
fi
exec systemd-run --collect --wait --pipe --quiet "${props[@]}" "$@"
