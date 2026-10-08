#!/usr/bin/env bash
# Sourced by the other ops scripts, never run on its own.
#
# One server can host more than one pad instance. Each is fully separate: its own Linux user, settings, keys, data,
# backups, code tree, API port and systemd units. Everything derives from the instance name, so no script hard-codes
# a path.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/instance.sh"
#   instance_load snarksm [mode]   sets the I_* variables below; returns 2 for a name it does not know
#   instance_render <template>     prints a template with __INSTANCE__, __PORT__ and __MODE__ filled in
#   instance_public_url <name> [sites file]   the address the instance's public files (coin images and metadata, /i and /m) are served
#                                  from: the live name for the instance the live name serves, else the first test name (the devnet
#                                  instance keeps those after the launch-day switch)
#   instance_set_env <file> KEY value / instance_fill_env <file> KEY value   write one setting in an instance's settings file: set
#                                  replaces the line in place, fill only when the line is missing or empty (it never overwrites a value)
#
#   instance  mode     API port  what it is
#   snarks    devnet   8787      the demo that has run since 2026-10-03: every path below is what it always was
#   snarksm   mainnet  8789      the staged mainnet instance (ops/MAINNET-RUNBOOK.md)
#
# Shared on purpose: the pinned binaries in /opt/snarks/bin (bun, zcash-devtool) and the host setup (ssh, firewall, Caddy).
# Not shared: the code tree. engine/ writes under engine/data and engine/keys, which are symlinks into the instance's
# own data directory, so two users cannot use one tree.

instance_load() {
  local name="${1:-}" mode="${2:-}"
  case "$name" in
    snarks)  I_PORT=8787; I_MODE=devnet ;;
    snarksm) I_PORT=8789; I_MODE=mainnet ;;
    *) echo "unknown instance '$name' (expected snarks or snarksm)" >&2; return 2 ;;
  esac
  if [ -n "$mode" ] && [ "$mode" != "$I_MODE" ]; then
    echo "instance $name runs in $I_MODE mode, not $mode (snarks is the devnet demo, snarksm is mainnet)" >&2
    return 2
  fi
  I_NAME="$name"
  I_USER="$name"
  I_ETC="/etc/$name"
  I_KEYS="/etc/$name/keys"
  I_DATA="/var/lib/$name"
  I_BACKUPS="/var/backups/$name"
  I_OPT="/opt/$name"
  I_REPO="/opt/$name/repo"
  I_WEB="/opt/$name/web"
  I_BIN="/opt/snarks/bin"
  # Coin images (i/) and metadata JSON (m/): written by the instance's API, served as static files by Caddy (ops/templates/Caddyfile.site).
  # Owned by the instance's user, group caddy, setgid, 0750 / 0640 (ops/remote-setup.sh). Inside the data directory, which the API unit may write.
  I_PUBLIC="/var/lib/$name/public"
}

instance_render() {
  sed -e "s|__INSTANCE__|$I_NAME|g" -e "s|__PORT__|$I_PORT|g" -e "s|__MODE__|$I_MODE|g" "$1"
}

instance_public_url() {
  local inst="$1" sites="${2:-/etc/caddy/snarks-sites.env}"
  [ -f "$sites" ] || return 1
  (
    LIVE_HOSTS=""; TEST_HOSTS=""; LIVE_INSTANCE=snarks
    . "$sites"
    host="${LIVE_HOSTS%% *}"
    if [ "$inst" = snarks ] && [ "$LIVE_INSTANCE" != snarks ]; then host="${TEST_HOSTS%% *}"; fi
    [ -n "$host" ] || exit 1
    printf 'https://%s\n' "$host"
  )
}

instance_set_env() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  if grep -q "^$key=" "$file"; then sed "s|^$key=.*|$key=$value|" "$file" > "$tmp"; else { cat "$file"; printf '%s=%s\n' "$key" "$value"; } > "$tmp"; fi
  cat "$tmp" > "$file" # into the same file: its owner and mode stay
  rm -f "$tmp"
}

instance_fill_env() {
  local current
  current="$(grep -m1 "^$2=" "$1" | cut -d= -f2- || true)"
  [ -n "$current" ] || instance_set_env "$1" "$2" "$3"
}
