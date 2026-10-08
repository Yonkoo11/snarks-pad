#!/usr/bin/env bash
# Keeps the server's clock on an NTP client and says whether it is synchronised (S4 stress ST-LW-02; ops/MAINNET-RUNBOOK.md gate G14). The launch window's
# fee is a function of the chain's clock and of this server's: the engine reads its own clock one second back (engine/src/dbc/window.ts CLOCK_MARGIN_SECONDS),
# so a server clock a second or two fast eats the margin and the page opens Buy while the chain still charges a step.
#   sudo ops/timesync.sh           makes sure a time client runs (chrony if it is already there, else systemd-timesyncd, installed if missing), waits up to
#                                  TIMESYNC_WAIT_S (60) seconds for the first synchronisation, prints the state; exit 1 when the clock is still not synchronised
#   ops/timesync.sh --check        prints the state only (no root, changes nothing); exit 1 when the clock is not synchronised
# ops/remote-setup.sh runs it in its host steps; it is safe to run again.
set -uo pipefail

synchronised() { [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; }
report() { timedatectl 2>/dev/null | grep -E 'System clock synchronized|NTP service' || echo "timedatectl gave no answer"; }

case "${1:-}" in
  --check)
    report
    synchronised
    exit $?
    ;;
  "") ;;
  *) echo "usage: ops/timesync.sh [--check]" >&2; exit 2 ;;
esac

[ "$(id -u)" = 0 ] || { echo "run as root (or use --check to only look)" >&2; exit 2; }
if systemctl is-active --quiet chrony || systemctl is-active --quiet chronyd; then
  echo "chrony keeps the clock"
else
  dpkg -s systemd-timesyncd >/dev/null 2>&1 || apt-get install -y -qq systemd-timesyncd || exit 1
  systemctl enable --now systemd-timesyncd || exit 1
  timedatectl set-ntp true || exit 1
fi
waited=0
until synchronised || [ "$waited" -ge "${TIMESYNC_WAIT_S:-60}" ]; do
  sleep 2
  waited=$((waited + 2))
done
report
synchronised || { echo "the clock is not synchronised yet: ops/healthcheck.sh will say so every 5 minutes until it is" >&2; exit 1; }
