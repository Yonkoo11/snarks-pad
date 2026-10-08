#!/usr/bin/env bash
# The root half of the server soak (stress/devnet-soak.ts is the other half): 3 SIGKILLs of the keeper at random moments
# between 15 min and (MINUTES - 25) min (`systemctl kill -s KILL`; Restart=always brings it back after 5 s), and one
# sample a minute of the keeper's RSS, open FDs, log bytes (its journal since the start + the health log) and DB size.
# Run as root in a transient unit so it outlives the SSH session:
#   sudo systemd-run --unit snarks-soak-driver --collect bash /opt/snarks/repo/engine/stress/devnet-soak-driver.sh 125
set -uo pipefail
MINUTES="${1:-125}"
DIR=/var/lib/snarks/data/stress
OUT="$DIR/devnet-soak-samples.jsonl"
KLOG="$DIR/devnet-soak-kills.log"
DB=/var/lib/snarks/data/devnet.sqlite
HLOG=/var/lib/snarks/data/keeper-health.log
SINCE="$(date -u '+%Y-%m-%d %H:%M:%S')"
t0=$(date +%s)
span=$(( MINUTES - 25 - 15 ))
kills=$(for i in 1 2 3; do echo $(( (15 + RANDOM % span) * 60 )); done | sort -n | tr '\n' ' ')
echo "$(date -u +%FT%TZ) start minutes=$MINUTES kill plan (s): $kills" >> "$KLOG"
size() { stat -c %s "$1" 2>/dev/null || echo 0; }
while :; do
  now=$(( $(date +%s) - t0 ))
  [ "$now" -ge $(( MINUTES * 60 )) ] && break
  pid=$(systemctl show -p MainPID --value snarks-keeper)
  rss=0; fds=0
  if [ "${pid:-0}" != 0 ] && [ -d "/proc/$pid" ]; then
    rss=$(awk '/^VmRSS/ {print $2}' "/proc/$pid/status"); fds=$(ls "/proc/$pid/fd" | wc -l)
  fi
  jbytes=$(journalctl -u snarks-keeper --since "$SINCE" -o cat --no-pager | wc -c)
  printf '{"tMin":%s,"pid":%s,"rssKb":%s,"fds":%s,"journalBytes":%s,"healthLogBytes":%s,"dbBytes":%s}\n' \
    "$(awk "BEGIN{printf \"%.1f\", $now/60}")" "${pid:-0}" "${rss:-0}" "$fds" "$jbytes" "$(size $HLOG)" "$(( $(size $DB) + $(size $DB-wal) ))" >> "$OUT"
  for k in $kills; do
    if [ "$now" -ge "$k" ]; then
      systemctl kill -s KILL snarks-keeper
      echo "$(date -u +%FT%TZ) SIGKILL keeper pid $pid at $(awk "BEGIN{printf \"%.1f\", $now/60}") min" >> "$KLOG"
      kills=$(echo "$kills" | sed "s/\b$k\b//")
      break
    fi
  done
  sleep 60
done
echo "$(date -u +%FT%TZ) driver done" >> "$KLOG"
