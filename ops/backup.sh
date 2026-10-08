#!/usr/bin/env bash
# Nightly encrypted backup: the SQLite databases (consistent .backup copies), every Zcash wallet directory (a
# consistent copy of its data.sqlite plus keys.toml, the age-encrypted seed), and the key files (age identities, keeper
# keypairs), and the public files (coin images and metadata JSON under <data>/public). The archive is encrypted to
# BACKUP_AGE_RECIPIENT, an age PUBLIC key; the identity that opens it is kept OFF
# the server. Without a recipient this refuses: a plaintext archive of keys is worse than none.
# Runs as the instance's own user (<instance>-backup.service). Needs: sqlite3, age, rsync (only when BACKUP_REMOTE is set).
# Which instance: PAD_INSTANCE from that instance's engine.env (snarks, the devnet demo, when it is not set). Everything
# derives from the name: /var/lib/<instance>, /etc/<instance>/keys, /var/backups/<instance>, archives <instance>-<time>.tar.gz.age.
set -euo pipefail
INSTANCE="${PAD_INSTANCE:-snarks}"
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT in /etc/$INSTANCE/engine.env}"
DATA="${SNARKS_DATA:-/var/lib/$INSTANCE}"
KEYS="${SNARKS_KEYS:-/etc/$INSTANCE/keys}"
OUT="${SNARKS_BACKUPS:-/var/backups/$INSTANCE}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT" "$STAGE/db" "$STAGE/zcash" "$STAGE/keys" "$STAGE/apikeys" "$STAGE/public"

for db in "$DATA"/data/*.sqlite; do
  [ -f "$db" ] && sqlite3 "$db" ".backup '$STAGE/db/$(basename "$db")'"
done
for w in "$DATA"/zcash/*/; do
  [ -f "$w/data.sqlite" ] || continue
  name="$(basename "$w")"
  mkdir -p "$STAGE/zcash/$name"
  sqlite3 "$w/data.sqlite" ".backup '$STAGE/zcash/$name/data.sqlite'"
  cp "$w/keys.toml" "$STAGE/zcash/$name/" 2>/dev/null || true
done
cp -a "$KEYS"/. "$STAGE/keys/"
cp -a "$DATA"/apikeys/. "$STAGE/apikeys/" 2>/dev/null || true
# Coin images and metadata (contract v2.7): the pictures cannot be made again from anything else, and every coin's uri points at them.
cp -a "$DATA"/public/. "$STAGE/public/" 2>/dev/null || true

tar -C "$STAGE" -czf - . | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT/$INSTANCE-$STAMP.tar.gz.age"
chmod 0600 "$OUT/$INSTANCE-$STAMP.tar.gz.age"
find "$OUT" -name "$INSTANCE-*.tar.gz.age" -mtime +14 -delete
[ -z "${BACKUP_REMOTE:-}" ] || rsync -a --chmod=F600 "$OUT/$INSTANCE-$STAMP.tar.gz.age" "$BACKUP_REMOTE"
echo "backup written: $OUT/$INSTANCE-$STAMP.tar.gz.age"
