#!/usr/bin/env bash
# Renders Caddy's config for BOTH ways the live name can point, so switching is a file swap and not a rewrite.
# Runs on the server as root. The sites file says which names exist and who serves "live" right now:
#
#   /etc/caddy/snarks-sites.env
#     LIVE_HOSTS="snarks.fun"                              public names; each also gets a www redirect
#     TEST_HOSTS="test.snarks.fun 38-49-215-61.sslip.io"   names that always serve the devnet instance (snarks)
#     LIVE_INSTANCE=snarks                                 snarks (devnet) or snarksm (mainnet): who the live names serve
#
# Two complete files are written next to the Caddyfile, each checked with `caddy validate`:
#   Caddyfile.live-snarks    live and test names -> the devnet instance (one site block)
#   Caddyfile.live-snarksm   live names -> the mainnet instance, test names -> the devnet instance
# and the one LIVE_INSTANCE names becomes /etc/caddy/Caddyfile (the old one is kept as Caddyfile.bak-<time>).
# ops/switch-live.sh later only changes which of the two is the Caddyfile.
#
#   ops/caddy-render.sh [--variants-only] [--reload]       render, validate, install (--variants-only: leave the Caddyfile alone)
#   ops/caddy-render.sh --init --live <host> [--live ...] [--test <host> ...]   write the sites file first (keeps LIVE_INSTANCE)
#   ops/caddy-render.sh --print <snarks|snarksm>           print one variant to stdout, touch nothing (tests, review)
# Environment (tests): CADDY_DIR (default /etc/caddy), SITES_FILE (default $CADDY_DIR/snarks-sites.env), --no-validate.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/instance.sh"
TEMPLATES="$HERE/templates"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
SITES_FILE="${SITES_FILE:-$CADDY_DIR/snarks-sites.env}"

die() { echo "caddy-render: $*" >&2; exit 1; }

VARIANTS_ONLY=0; RELOAD=0; INIT=0; VALIDATE=1; PRINT=""; INIT_LIVE=""; INIT_TEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --variants-only) VARIANTS_ONLY=1; shift;;
    --reload) RELOAD=1; shift;;
    --no-validate) VALIDATE=0; shift;;
    --init) INIT=1; shift;;
    --live) INIT_LIVE="$INIT_LIVE $2"; shift 2;;
    --test) INIT_TEST="$INIT_TEST $2"; shift 2;;
    --print) PRINT="$2"; shift 2;;
    *) die "unknown option $1";;
  esac
done

check_hosts() { # <label> <hosts>
  local h
  for h in $2; do
    echo "$h" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || die "$1 name '$h' is not a plain hostname"
  done
}

if [ "$INIT" = 1 ]; then
  [ -n "$INIT_LIVE" ] || die "--init needs at least one --live <host>"
  check_hosts live "$INIT_LIVE"; check_hosts test "$INIT_TEST"
  current=snarks
  [ -f "$SITES_FILE" ] && current="$(. "$SITES_FILE"; echo "${LIVE_INSTANCE:-snarks}")"
  mkdir -p "$(dirname "$SITES_FILE")"
  printf 'LIVE_HOSTS="%s"\nTEST_HOSTS="%s"\nLIVE_INSTANCE=%s\n' "${INIT_LIVE# }" "${INIT_TEST# }" "$current" > "$SITES_FILE"
  chmod 644 "$SITES_FILE"
fi

[ -f "$SITES_FILE" ] || die "$SITES_FILE does not exist: run once with --init --live <host> [--test <host> ...]"
LIVE_HOSTS=""; TEST_HOSTS=""; LIVE_INSTANCE=snarks
. "$SITES_FILE"
[ -n "$LIVE_HOSTS" ] || die "LIVE_HOSTS is empty in $SITES_FILE"
check_hosts live "$LIVE_HOSTS"; check_hosts test "$TEST_HOSTS"
instance_load "$LIVE_INSTANCE" >/dev/null || die "LIVE_INSTANCE '$LIVE_INSTANCE' in $SITES_FILE is not a known instance"

comma() { echo "$*" | sed 's/  */, /g'; } # "a b c" -> "a, b, c"

site_block() { # <instance> <hosts...>
  local inst="$1"; shift
  instance_load "$inst"
  sed -e "s|__HOSTS__|$(comma "$@")|" -e "s|__PORT__|$I_PORT|g" -e "s|__WEB__|$I_WEB|" -e "s|__PUBLIC__|$I_PUBLIC|g" -e "s|__LOGNAME__|$I_NAME|" "$TEMPLATES/Caddyfile.site"
}

render_variant() { # <live instance>
  local live="$1" h
  cat <<'HEAD'
# Written by ops/caddy-render.sh from /etc/caddy/snarks-sites.env. Do not edit by hand: edit the sites file and render again.
# Caddy on 80 (plain HTTP is redirected to HTTPS, and the certificate check can use it) and 443. ufw allows 22, 80 and 443.

HEAD
  if [ "$live" = snarks ]; then
    site_block snarks $LIVE_HOSTS $TEST_HOSTS
  else
    site_block "$live" $LIVE_HOSTS
    [ -z "$TEST_HOSTS" ] || { echo; site_block snarks $TEST_HOSTS; }
  fi
  for h in $LIVE_HOSTS; do
    echo
    sed -e "s|__HOST__|$h|g" "$TEMPLATES/Caddyfile.www"
  done
}

if [ -n "$PRINT" ]; then
  instance_load "$PRINT" >/dev/null || die "--print needs snarks or snarksm"
  render_variant "$PRINT"
  exit 0
fi

mkdir -p "$CADDY_DIR"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
for inst in snarks snarksm; do
  render_variant "$inst" > "$STAGE/Caddyfile.live-$inst"
  if [ "$VALIDATE" = 1 ]; then
    caddy validate --config "$STAGE/Caddyfile.live-$inst" --adapter caddyfile >/dev/null 2>&1 \
      || { caddy validate --config "$STAGE/Caddyfile.live-$inst" --adapter caddyfile 2>&1 | tail -5 >&2; die "the live-$inst variant does not validate; nothing was installed"; }
  fi
done
# validate runs as root and opens each access log, creating a new one root-owned 0600; hand the logs back to caddy
[ ! -d /var/log/caddy ] || chown -R caddy:caddy /var/log/caddy
for inst in snarks snarksm; do install -m 644 "$STAGE/Caddyfile.live-$inst" "$CADDY_DIR/Caddyfile.live-$inst"; done
echo "rendered and validated: $CADDY_DIR/Caddyfile.live-snarks, $CADDY_DIR/Caddyfile.live-snarksm (live is $LIVE_INSTANCE)"

if [ "$VARIANTS_ONLY" = 1 ]; then exit 0; fi
if [ -f "$CADDY_DIR/Caddyfile" ] && cmp -s "$STAGE/Caddyfile.live-$LIVE_INSTANCE" "$CADDY_DIR/Caddyfile"; then
  echo "the Caddyfile already is the live-$LIVE_INSTANCE variant: unchanged"
else
  [ ! -f "$CADDY_DIR/Caddyfile" ] || cp -p "$CADDY_DIR/Caddyfile" "$CADDY_DIR/Caddyfile.bak-$(date +%s)"
  install -m 644 "$STAGE/Caddyfile.live-$LIVE_INSTANCE" "$CADDY_DIR/Caddyfile"
  echo "installed the live-$LIVE_INSTANCE variant as $CADDY_DIR/Caddyfile"
  [ "$RELOAD" = 0 ] || { systemctl reload caddy && echo "caddy reloaded"; }
fi
