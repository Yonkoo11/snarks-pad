#!/usr/bin/env bash
# Checks a hand-written (or USB) copy of the backup key against the one on this Mac, without showing either (gate G5).
# The owner types the AGE-SECRET-KEY-1... line from the paper (input hidden), or passes a file on a USB stick; both keys
# are turned into their public keys with age-keygen and compared. Only "matches" or "does NOT match" is printed.
#   ops/verify-backup-key-copy.sh              type the paper copy when asked
#   ops/verify-backup-key-copy.sh /Volumes/X/backup-age.txt
set -euo pipefail
KEY_FILE="${BACKUP_AGE_FILE:-$HOME/.config/snarks-pad/backup-age.txt}"
command -v age-keygen > /dev/null || { echo "age-keygen is not installed (brew install age)" >&2; exit 1; }
[ -f "$KEY_FILE" ] || { echo "no backup key at $KEY_FILE" >&2; exit 1; }
want="$(age-keygen -y "$KEY_FILE")"
if [ $# -ge 1 ]; then
  got="$(age-keygen -y "$1" 2> /dev/null || true)"
else
  printf 'Type the key from the paper (AGE-SECRET-KEY-1...), then press Enter. Nothing will show while you type: '
  IFS= read -rs typed || true; echo
  typed="$(printf '%s' "$typed" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
  got="$(printf '%s\n' "$typed" | age-keygen -y 2> /dev/null || true)"
  unset typed
fi
if [ -n "$got" ] && [ "$got" = "$want" ]; then echo "matches: this copy unlocks the backups"; else echo "does NOT match: check the copy character by character"; exit 1; fi
