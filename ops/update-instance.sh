#!/usr/bin/env bash
# Updates a running instance to this checkout's HEAD by the path ops/DEPLOY.md records for every 2026-10-05 update, in one command, with rollback
# copies first. Runs on the Mac. The keeper is restarted only if it was running (a mainnet keeper paused for the rehearsal stays stopped).
#   ops/update-instance.sh snarks             the devnet instance (test.snarks.fun): engine, ops, and the site built for devnet
#   ops/update-instance.sh snarksm            the mainnet instance (snarks.fun): engine, ops, and the site built by ops/build-mainnet-web.sh
#   ops/update-instance.sh <instance> --dry   prints what it would do and checks the server, changes nothing
# Rollback (printed at the end): the three copies in /home/deploy hold the code, the database and the site as they were.
HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf"; [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ] && . "$HOST_CONF"
set -euo pipefail
cd "$(dirname "$0")/.."
INSTANCE="${1:-}"
DRY=0; [ "${2:-}" = "--dry" ] && DRY=1
HOST="${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}"
case "$INSTANCE" in
  snarks) DB=devnet.sqlite; SITE=https://test.snarks.fun; PORT=8787 ;;
  snarksm) DB=mainnet.sqlite; SITE=https://snarks.fun; PORT=8789 ;;
  *) echo "usage: ops/update-instance.sh snarks|snarksm [--dry]" >&2; exit 2 ;;
esac
[ -z "$(git status --porcelain -- engine web ops)" ] || { echo "engine, web or ops has uncommitted changes; make a save point first" >&2; exit 1; }
C=$(git rev-parse --short HEAD)
# the copies are named by commit AND time, so running this again never overwrites the copy of the state before the first run (audit S5-06)
B="$C-$(date -u +%Y%m%dT%H%M%SZ)"
# One ssh connection for the whole run, reused by every step and by rsync (ControlMaster): sshd under bot noise drops new
# connections at random (MaxStartups), which cut three deploys in a row on 2026-10-08. The connection is opened with retries,
# so a run either starts on a working connection or stops at once, never in the middle of a copy.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-snarks-%C" -o ControlPersist=15m)
ssh() { command ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
for try in 1 2 3 4 5 6; do
  command ssh "${SSH_OPTS[@]}" -O check "$HOST" 2>/dev/null && break
  command ssh "${SSH_OPTS[@]}" -fN "$HOST" 2>/dev/null && break
  echo "connection attempt $try to $HOST failed (the server drops new connections at random under bot noise); retrying" >&2
  sleep 5
done
command ssh "${SSH_OPTS[@]}" -O check "$HOST" 2>/dev/null || { echo "could not open a connection to $HOST after 6 tries; nothing was changed" >&2; exit 1; }

ssh "sudo test -f /var/lib/$INSTANCE/data/$DB" || { echo "no database /var/lib/$INSTANCE/data/$DB on the server; stop" >&2; exit 1; }
KEEPER_WAS=$(ssh "systemctl is-active $INSTANCE-keeper || true")
echo "instance $INSTANCE, commit $C, keeper $KEEPER_WAS, site $SITE"
if [ "$DRY" = 1 ]; then
  echo "dry run: would copy code, database and site to /home/deploy (*-before-$B), extract engine/ops/web over /opt/$INSTANCE/repo,"
  echo "restart $INSTANCE-api$([ "$KEEPER_WAS" = active ] && echo " and $INSTANCE-keeper"), then build and place the site."
  exit 0
fi

echo "1/4 rollback copies"
ssh "set -e; cd /home/deploy
  tar -czf $INSTANCE-repo-before-$B.tgz -C /opt/$INSTANCE/repo --exclude=node_modules --exclude=engine/data --exclude=engine/keys engine web ops
  sudo sqlite3 /var/lib/$INSTANCE/data/$DB '.backup /home/deploy/$INSTANCE-db-before-$B.sqlite'
  sudo chown deploy:deploy $INSTANCE-db-before-$B.sqlite && chmod 600 $INSTANCE-db-before-$B.sqlite
  echo \"database copy: \$(sqlite3 $INSTANCE-db-before-$B.sqlite 'PRAGMA integrity_check')\"
  sudo tar -czf $INSTANCE-web-before-$B.tgz -C /opt/$INSTANCE web"

echo "2/4 code"
RUNNING=$(ssh "cat /opt/$INSTANCE/repo/.commit 2>/dev/null || true")
[ -n "$RUNNING" ] || echo "the server does not say which commit it runs (no .commit): check engine/package.json and engine/bun.lock against it by hand (audit S5-10)"
# only the dependency sections of package.json count (a new script in it changes no module), plus the lockfile
deps_of() { git show "$1:engine/package.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k: d.get(k) for k in ("dependencies","devDependencies","peerDependencies","optionalDependencies","trustedDependencies","overrides","resolutions","patchedDependencies")}, sort_keys=True))'; }
if [ -n "$RUNNING" ] && { ! git diff --quiet "$RUNNING" HEAD -- engine/bun.lock 2>/dev/null || [ "$(deps_of "$RUNNING")" != "$(deps_of HEAD)" ]; }; then
  echo "engine dependencies changed since the running copy: run 'bun install --frozen-lockfile' in /opt/$INSTANCE/repo/engine as the service user before restarting" >&2
  exit 1
fi
git archive "$C" engine web ops | ssh "tar -x -C /opt/$INSTANCE/repo && echo $C > /opt/$INSTANCE/repo/.commit"

echo "3/4 site build (before the restart, so the new site follows the new API within seconds)"
if [ "$INSTANCE" = snarksm ]; then
  bash ops/build-mainnet-web.sh --no-place
  OUT=web/dist-mainnet
else
  ( cd web && VITE_API=real VITE_API_BASE=/api VITE_RPC=https://api.devnet.solana.com npx vite build --outDir dist-devnet --emptyOutDir > /dev/null )
  OUT=web/dist-devnet
  js="$(cat $OUT/assets/*.js)"
  grep -q 'api.devnet.solana.com' <<< "$js" || { echo "the devnet bundle does not name devnet; not placing it" >&2; exit 1; }
  if grep -qiE 'helius|alchemy' <<< "$js"; then echo "the devnet bundle names a keyed RPC; not placing it" >&2; exit 1; fi
fi

echo "4/4 restart, then the site at once"
UNITS="$INSTANCE-api"; [ "$KEEPER_WAS" = active ] && UNITS="$UNITS $INSTANCE-keeper"
ssh "sudo systemctl restart $UNITS && sudo mkdir -p /opt/$INSTANCE/web && sudo chown -R deploy:deploy /opt/$INSTANCE/web"
rsync -rl -c --no-owner --no-group --chmod=D755,F644 --delete-after -e "ssh ${SSH_OPTS[*]}" "$OUT/" "$HOST:/opt/$INSTANCE/web/"
ssh "sudo chown -R root:root /opt/$INSTANCE/web && sleep 5 && systemctl is-active $UNITS | tr '\n' ' ' && curl -s -o /dev/null -w 'local /api/coins %{http_code}\n' http://127.0.0.1:$PORT/api/coins"
name=$(basename "$(ls $OUT/assets/*.js | head -1)")
built=$(shasum -a 256 "$OUT/assets/$name" | cut -c1-16); served=$(curl -s "$SITE/assets/$name" | shasum -a 256 | cut -c1-16)
echo "bundle $name built $built served $served $([ "$built" = "$served" ] && echo OK || echo MISMATCH)"
curl -s -o /dev/null -w "$SITE/api/coins %{http_code}\n" "$SITE/api/coins"
echo "rollback: /home/deploy/$INSTANCE-{repo,web}-before-$B.tgz and $INSTANCE-db-before-$B.sqlite (ops/DEPLOY.md, rollback)"
