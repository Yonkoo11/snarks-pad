#!/usr/bin/env bash
# Off-server copy of the encrypted backups, PULLED from the owner's Mac (the server holds no key to the Mac and no
# BACKUP_REMOTE). For each instance on the server (SNARKS_INSTANCES, default "snarks snarksm") it starts a fresh backup, then
# copies every archive into backups-remote/ (0700, gitignored): snarks-<time>.tar.gz.age and snarksm-<time>.tar.gz.age sit side
# by side, and each instance is checked and pruned by its own name. The archives are age-encrypted to the owner's public key;
# the identity is not in this folder. Keeps 30 days locally.
# One instance failing does not stop the next one; the exit status is nonzero if any failed.
# Install the 6-hourly launchd job with ops/install-backup-pull.sh. Run by hand any time: ops/pull-backups.sh
HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf"; [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ] && . "$HOST_CONF"
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}"
DEST="${SNARKS_BACKUPS_REMOTE:-$REPO/backups-remote}"
INSTANCES="${SNARKS_INSTANCES:-snarks snarksm}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")
umask 077
mkdir -p "$DEST"; chmod 0700 "$DEST"

pull_one() { # <instance>; every step is checked by hand, because errexit is off inside a function called from an if
  local inst="$1" latest
  case "$inst" in snarks | snarksm) ;; *) echo "unknown instance '$inst'" >&2; return 1 ;; esac
  "${SSH[@]}" "sudo systemctl start $inst-backup.service" || { echo "$inst: could not start its backup on the server" >&2; return 1; }
  rsync -rt --no-owner --no-group --chmod=F600 --rsync-path="sudo rsync" -e"ssh -o BatchMode=yes -o ConnectTimeout=20" "$HOST:/var/backups/$inst/" "$DEST/" \
    || { echo "$inst: rsync failed" >&2; return 1; }
  find "$DEST" -name "$inst-*.tar.gz.age" -mtime +30 -delete
  latest="$(ls -1 "$DEST"/"$inst"-*.tar.gz.age 2>/dev/null | tail -1)"
  [ -n "$latest" ] && [ -s "$latest" ] || { echo "$inst: pull failed, no archive in $DEST" >&2; return 1; }
  # An age file starts with its own header line; a plaintext tarball would not.
  head -c 21 "$latest" | grep -q '^age-encryption.org/v1' || { echo "refusing: $latest is not an age file" >&2; return 1; }
  echo "$(date -u +%FT%TZ) ok $(basename "$latest") ($(ls -1 "$DEST"/"$inst"-*.tar.gz.age | wc -l | tr -d ' ') archives)" | tee -a "$DEST/pull.log"
}

failed=0
for inst in $INSTANCES; do
  pull_one "$inst" || failed=1
done
exit "$failed"
