#!/usr/bin/env bash
# Puts the backup key (the AGE-SECRET-KEY-1... line) on this Mac's clipboard for pasting into the Passwords app, without
# showing it anywhere, and wipes the clipboard again after 5 minutes. Run it in Terminal right before pasting.
#   ops/copy-backup-key.sh
set -euo pipefail
KEY_FILE="${BACKUP_AGE_FILE:-$HOME/.config/snarks-pad/backup-age.txt}"
[ -f "$KEY_FILE" ] || { echo "no backup key at $KEY_FILE" >&2; exit 1; }
line="$(grep -m1 '^AGE-SECRET-KEY-1' "$KEY_FILE" || true)"
[ -n "$line" ] || { echo "no AGE-SECRET-KEY line in $KEY_FILE" >&2; exit 1; }
printf '%s' "$line" | pbcopy
unset line
( sleep "${CLEAR_AFTER_SECONDS:-300}"; pbcopy < /dev/null ) > /dev/null 2>&1 &
echo "Copied. Paste it into the Passwords app now (Command+V). The clipboard is wiped in 5 minutes."
