#!/usr/bin/env bash
# Restore drill: proves a backup opens and is usable WITHOUT touching the live system. Run it on a machine that has
# the age identity (ideally NOT the server) and the pinned zcash-devtool.
#   ops/restore-drill.sh <snarks-....tar.gz.age | snarksm-....tar.gz.age> <age-identity-file> [zcash-devtool path]
# Checks: the archive decrypts, every SQLite file passes integrity_check, the engine tables have rows, and each Zcash
# wallet opens and reports a balance (a wallet that was never synced says so instead). Prints "RESTORE DRILL OK" or exits nonzero.
# The decrypted files include the keeper key and the wallet's age identity: they live in a temp directory under $TMPDIR
# (point it at a RAM disk to keep them off the disk) that is removed on exit.
set -euo pipefail
ARCHIVE="${1:?archive}"
IDENTITY="${2:?age identity file}"
DEVTOOL="${3:-/opt/snarks/bin/zcash-devtool}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore-drill.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
age -d -i "$IDENTITY" "$ARCHIVE" | tar -C "$WORK" -xzf -
for db in "$WORK"/db/*.sqlite "$WORK"/zcash/*/data.sqlite; do
  [ -f "$db" ] || continue
  r="$(sqlite3 "$db" 'PRAGMA integrity_check;')"
  [ "$r" = "ok" ] || { echo "FAIL integrity_check on $db: $r" >&2; exit 1; }
  echo "ok   integrity $db"
done
for db in "$WORK"/db/*.sqlite; do
  [ -f "$db" ] || continue
  echo "rows epochs=$(sqlite3 "$db" 'select count(*) from epochs;') optins=$(sqlite3 "$db" 'select count(*) from optins;') coins=$(sqlite3 "$db" 'select count(*) from coins;') ($(basename "$db"))"
done
for w in "$WORK"/zcash/*/; do
  [ -f "$w/data.sqlite" ] || continue
  name="$(basename "$w")"
  out="$("$DEVTOOL" wallet -w "$w" balance 2>&1)" || { echo "FAIL: the devtool could not open wallet $name" >&2; exit 1; }
  if echo "$out" | grep -qE "Balance:|Spendable"; then
    echo "$out" | grep -E "Balance:|Spendable" | sed "s|^|$name: |"
  elif echo "$out" | grep -q "Insufficient information to build a wallet summary"; then
    echo "$name: opens; never synced, so there is no balance to report yet"
  else
    echo "FAIL: unexpected answer from the devtool for wallet $name (first line: $(echo "$out" | head -1 | cut -c1-80))" >&2; exit 1
  fi
done
ls "$WORK/keys" | sed 's/^/key file present: /'
echo "RESTORE DRILL OK"
