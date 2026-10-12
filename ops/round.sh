#!/usr/bin/env bash
# Runs one payout round on the server, from this machine, as the keeper would: `bash ops/round.sh snarksm` (or snarks).
# Exists because the full ssh line is long enough to wrap in a terminal, and a wrapped line splits the command: `env`
# then runs with no command and prints the whole service environment, secrets included (seen 2026-10-12). One line here.
# `--samples` lists each coin's holder samples instead; `--take` stores one more sample for every coin.
# PAD_HELD_CLAIM_KINDS=damm_position,surplus keeps the DAMM position and the partner surplus out of the round: the drop-in holds the
# position; the surplus claim has no minimum in code and would propose a 71-zat Squads claim (measured 2026-10-12) that needs another approval.
HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf"; [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ] && . "$HOST_CONF"
set -euo pipefail
INSTANCE="${1:-snarksm}"
HOST="${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}"
case "$INSTANCE" in snarks|snarksm) ;; *) echo "usage: ops/round.sh snarks|snarksm [--samples|--take]" >&2; exit 2 ;; esac
RUN="sudo /opt/$INSTANCE/repo/ops/svc-run.sh"
case "${2:-}" in
  --samples) CMD="$RUN /opt/snarks/bin/bun scripts/samples.ts" ;;
  --take) CMD="$RUN /opt/snarks/bin/bun scripts/samples.ts --take" ;;
  "") CMD="$RUN /usr/bin/env PAD_HELD_CLAIM_KINDS=damm_position,surplus /opt/snarks/bin/bun scripts/epoch.ts" ;;
  *) echo "usage: ops/round.sh snarks|snarksm [--samples|--take]" >&2; exit 2 ;;
esac
exec ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "$CMD"
