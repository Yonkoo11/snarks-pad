#!/usr/bin/env bash
# The launch-day switch: points the live name (snarks.fun) at one instance. The test names (test.snarks.fun and the sslip
# name) always stay on the devnet instance, so after the switch the demo is still there.
#
#   ops/switch-live.sh snarksm            from the Mac: this file is sent to the server over ssh and run there as root
#                                         (SNARKS_HOST sets the target, default the pad's server)
#   ops/switch-live.sh snarksm --check    every check and the validation, changes nothing
#   ops/switch-live.sh snarks             the way back
#
# On the server it does, in order:
#   1. checks the target is really serving: its API answers on its own port, says its own mode in the x-pad-mode header, and a
#      built site exists in its web folder (a mainnet site is built for mainnet and put there with provision.sh --web-dist)
#   2. swaps /etc/caddy/Caddyfile for the pre-rendered, pre-validated Caddyfile.live-<target> (ops/caddy-render.sh made it)
#      and reloads Caddy
#   3. asks Caddy itself, on the live name, which mode answers. If it is not the target's mode, the old file goes back
#   4. records the choice in /etc/caddy/snarks-sites.env, so a later render keeps it
#   5. moves PUBLIC_BASE_URL, the address the coin images and metadata are served from: the devnet instance leaves the live name for the
#      first test name, the mainnet instance stays on the live name. Each engine.env that changes gets the new line and its API (only)
#      restarts, when it is running. A coin's metadata address is written on chain at launch, so devnet coins launched before this switch
#      keep pointing at the live name, which now serves the mainnet files: their pictures stop answering. They are test coins.
# It starts and stops nothing else: the mainnet units, the unpause and the health timer are the runbook's launch steps.
# Not run yet (staged 2026-10-05): the mainnet API is stopped, and no mainnet site is built.
set -euo pipefail

usage() {
  echo "usage: ops/switch-live.sh <snarks|snarksm> [--check]" >&2
  exit 2
}

for arg in "$@"; do
  case "$arg" in snarks | snarksm | --check) ;; *) usage ;; esac
done
[ $# -ge 1 ] || usage

# ROOT_PREFIX is for the tests only (a scratch directory standing in for /): sudo does not pass it through ssh on a real server.
ROOT_PREFIX="${ROOT_PREFIX:-}"
CADDY_DIR="$ROOT_PREFIX/etc/caddy"
if [ ! -d "$CADDY_DIR" ]; then # not on the server: run this very file there
  HOST_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host.conf" # the server address lives here (ignored by git), or in SNARKS_HOST
  if [ -z "${SNARKS_HOST:-}" ] && [ -f "$HOST_CONF" ]; then . "$HOST_CONF"; fi
  exec ssh -o BatchMode=yes -o ConnectTimeout=20 "${SNARKS_HOST:?set SNARKS_HOST (deploy@<server>) or create ops/host.conf}" "sudo bash -s -- $*" < "${BASH_SOURCE[0]}"
fi

TARGET=""; CHECK=0
for arg in "$@"; do
  case "$arg" in --check) CHECK=1 ;; *) TARGET="$arg" ;; esac
done
[ -n "$TARGET" ] || usage
[ -n "$ROOT_PREFIX" ] || [ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
# Keep this table in step with ops/instance.sh (engine/test/ops-instances.test.ts compares them).
case "$TARGET" in
  snarks) PORT=8787; MODE=devnet; WEB=/opt/snarks/web ;;
  snarksm) PORT=8789; MODE=mainnet; WEB=/opt/snarksm/web ;;
esac

SITES="$CADDY_DIR/snarks-sites.env"
VARIANT="$CADDY_DIR/Caddyfile.live-$TARGET"
[ -f "$SITES" ] || { echo "no $SITES: run ops/caddy-render.sh --init first" >&2; exit 1; }
LIVE_HOSTS=""; TEST_HOSTS=""; LIVE_INSTANCE=snarks
. "$SITES"
LIVE_HOST="${LIVE_HOSTS%% *}"

mode_of() { # <url> [curl args]: the x-pad-mode header of an answer that is HTTP 200, else nothing
  local head first
  head="$(curl -sS -m 10 -D - -o /dev/null "${@:2}" "$1" 2>/dev/null | tr -d '\r')" || return 0
  first="${head%%$'\n'*}"
  case "$first" in *" 200"*) ;; *) return 0 ;; esac
  printf '%s\n' "$head" | awk -F': ' 'tolower($1) == "x-pad-mode" { print $2 }'
}

# The address an instance's coin images and metadata are served from once TARGET is live (instance_public_url in ops/instance.sh, which this
# file cannot source: it runs alone on the server). The devnet instance moves to the first test name when it is not the live one; the other
# instance is always the live name.
public_url_of() { # <instance>
  local host="$LIVE_HOST"
  if [ "$1" = snarks ] && [ "$TARGET" != snarks ]; then host="${TEST_HOSTS%% *}"; fi
  if [ -n "$host" ]; then printf 'https://%s\n' "$host"; fi
}

echo "live names:  $LIVE_HOSTS  now -> $LIVE_INSTANCE, to -> $TARGET (127.0.0.1:$PORT, $MODE, site $WEB)"
echo "test names:  stay on snarks (devnet, 127.0.0.1:8787)"
for inst in snarks snarksm; do echo "public files: $inst's coin images and metadata will be served from $(public_url_of "$inst")"; done
if [ "$LIVE_INSTANCE" = "$TARGET" ]; then
  echo "already live: nothing to do"
  exit 0
fi

problems=()
[ -f "$VARIANT" ] || problems+=("$VARIANT is missing: run ops/caddy-render.sh")
seen="$(mode_of "http://127.0.0.1:$PORT/api/treasury")"
[ "$seen" = "$MODE" ] || problems+=("the $TARGET API does not answer 200 with mode $MODE on 127.0.0.1:$PORT (it said '${seen:-nothing}'); start it: systemctl start $TARGET-api")
[ -s "$ROOT_PREFIX$WEB/index.html" ] || problems+=("no built site: $WEB/index.html is missing (provision.sh --instance $TARGET --web-dist <build>)")
if [ -f "$VARIANT" ]; then
  caddy validate --config "$VARIANT" --adapter caddyfile >/dev/null 2>&1 || problems+=("$VARIANT does not validate")
fi
if [ "${#problems[@]}" -gt 0 ]; then
  for p in "${problems[@]}"; do echo "REFUSED: $p" >&2; done
  exit 1
fi
if [ "$CHECK" = 1 ]; then
  echo "CHECK ONLY: every check passed; nothing was changed. Run without --check to switch."
  exit 0
fi

BACKUP="$CADDY_DIR/Caddyfile.bak-switch-$(date +%s)"
cp -p "$CADDY_DIR/Caddyfile" "$BACKUP"
rollback() {
  echo "ROLLING BACK to $BACKUP: $1" >&2
  install -m 644 "$BACKUP" "$CADDY_DIR/Caddyfile"
  systemctl reload caddy || true
  exit 1
}
install -m 644 "$VARIANT" "$CADDY_DIR/Caddyfile"
systemctl reload caddy || rollback "caddy would not reload"
[ -n "$ROOT_PREFIX" ] || sleep 3 # let Caddy finish swapping its config before it is asked
seen="$(mode_of "https://$LIVE_HOST/api/treasury" --resolve "$LIVE_HOST:443:127.0.0.1")"
[ "$seen" = "$MODE" ] || rollback "https://$LIVE_HOST answered mode '${seen:-nothing}', expected $MODE"
tmp="$(mktemp)"
sed "s/^LIVE_INSTANCE=.*/LIVE_INSTANCE=$TARGET/" "$SITES" > "$tmp"
cat "$tmp" > "$SITES"
rm -f "$tmp"

# Step 5 of the header: each instance's PUBLIC_BASE_URL follows the names. Said loudly when it fails, but never undoes the switch: the live name serves the target.
move_public_url() { # <instance>
  local inst="$1" file="$ROOT_PREFIX/etc/$1/engine.env" want current edit
  [ -f "$file" ] || return 0
  want="$(public_url_of "$inst")"
  current="$(grep -m1 '^PUBLIC_BASE_URL=' "$file" | cut -d= -f2- || true)"
  if [ -z "$want" ] || [ "$current" = "$want" ]; then return 0; fi
  edit="$(mktemp)"
  if grep -q '^PUBLIC_BASE_URL=' "$file"; then sed "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$want|" "$file" > "$edit"; else { cat "$file"; printf 'PUBLIC_BASE_URL=%s\n' "$want"; } > "$edit"; fi
  cat "$edit" > "$file"
  rm -f "$edit"
  echo "PUBLIC_BASE_URL of $inst: ${current:-unset} -> $want"
  if systemctl is-active --quiet "$inst-api"; then
    systemctl restart "$inst-api" && echo "$inst-api restarted" || echo "WARNING: $inst-api did not restart: run systemctl restart $inst-api" >&2
  fi
}
for inst in snarks snarksm; do
  move_public_url "$inst" || echo "WARNING: could not move PUBLIC_BASE_URL of $inst: edit /etc/$inst/engine.env by hand and restart $inst-api" >&2
done
echo "DONE: $LIVE_HOSTS now serves $TARGET ($MODE). Back: ops/switch-live.sh $LIVE_INSTANCE. The previous Caddyfile is $BACKUP"
