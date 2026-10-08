#!/usr/bin/env bash
# Provisions a pad instance on an Ubuntu 24.04 server over SSH. DRY RUN BY DEFAULT: it prints what it would upload and
# run and connects to nothing. Add --apply to do it. Safe to run again (the remote script is idempotent).
#
#   ops/provision.sh <ip> --domain <host> --pubkey <admin public key file> [--ssh-user root] [--web-dist <dir>] [--apply]
#   ops/provision.sh <ip> --instance snarksm --mode mainnet --pubkey <file> --ssh-user deploy [--web-dist <dir>] [--apply]
#
#   <ip>        the server's address
#   --pubkey    the public key that may log in as `deploy` (the only login that stays)
#   --instance  snarks (the devnet demo, the default) or snarksm (the staged mainnet instance). One server can run both: each has
#               its own user, settings, keys, data, backups, code tree (/opt/<instance>), API port and units (ops/instance.sh).
#               Adding snarksm leaves the host, the devnet instance and the running Caddyfile alone (see --host-setup).
#   --mode      optional check: devnet for snarks, mainnet for snarksm; anything else is refused
#   --domain    the name Caddy gets a certificate for (a DNS A record pointing at <ip>; with no domain yet,
#               <ip-with-dashes>.sslip.io works, e.g. 203.0.113.7 -> 203-0-113-7.sslip.io). Needed for the first run on a server
#               (it seeds /etc/caddy/snarks-sites.env); after that that file decides the names
#   --test-host a second name for the devnet site (repeatable); only used when --domain seeds the sites file
#   --ssh-user  who to connect as for THIS run: `root` (or `ubuntu`) on a brand-new server, `deploy` afterwards
#   --web-dist  a built site to upload into /opt/<instance>/web; the snarks default is web/dist (VITE_API=real
#               VITE_API_BASE=/api npm run build). For snarksm there is NO default: web/dist may be a devnet build
#   --host-setup  also run the host-wide steps (packages, ssh, firewall, hidepid, journald, Caddy install) for a non-default instance
#   --skip-devtool-build   skip building zcash-devtool on the server (the default builds it; about 5 minutes)
# It does not start the keeper until the settings and keys exist (ops/DEPLOY.md step 6) and it never copies a key.
# A mainnet instance is never started or enabled by it: the units are installed, paused, and the launch is the runbook's.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO/ops/instance.sh"
usage() { sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 2; }
IP="${1:-}"; [ -n "$IP" ] && shift || usage
DOMAIN=""; TEST_HOSTS=""; PUBKEY_FILE=""; SSH_USER=root; WEB_DIST=""; WEB_GIVEN=0; APPLY=0; SKIP_DEVTOOL=0
INSTANCE=snarks; MODE=""; HOST_SETUP_FLAG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) INSTANCE="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --test-host) TEST_HOSTS="$TEST_HOSTS $2"; shift 2;;
    --pubkey) PUBKEY_FILE="$2"; shift 2;;
    --ssh-user) SSH_USER="$2"; shift 2;;
    --web-dist) WEB_DIST="$2"; WEB_GIVEN=1; shift 2;;
    --host-setup) HOST_SETUP_FLAG=1; shift;;
    --skip-devtool-build) SKIP_DEVTOOL=1; shift;;
    --apply) APPLY=1; shift;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
instance_load "$INSTANCE" "$MODE" || exit 2
TEST_HOSTS="${TEST_HOSTS# }"
[ "$I_NAME" != snarks ] || [ -n "$DOMAIN" ] || { echo "--domain is required for the snarks instance" >&2; exit 2; }
[ "$I_MODE" = devnet ] && [ "$WEB_GIVEN" = 0 ] && WEB_DIST="$REPO/web/dist"
[ -f "$PUBKEY_FILE" ] || { echo "--pubkey must be a public key file" >&2; exit 2; }
grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-)' "$PUBKEY_FILE" || { echo "$PUBKEY_FILE does not look like a PUBLIC key (a private key must never be passed here)" >&2; exit 2; }
echo "$IP" | grep -qE '^[0-9a-fA-F:.]+$' || { echo "<ip> must be an address" >&2; exit 2; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CODE_TAR="$(mktemp -t snarks-code.XXXXXX).tar.gz"
WEB_TAR="$(mktemp -t snarks-web.XXXXXX).tar.gz"
trap 'rm -f "$CODE_TAR" "$WEB_TAR"' EXIT
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_USER@$IP")
SUDO=""; [ "$SSH_USER" = root ] || SUDO="sudo"
HAVE_WEB=0; [ -n "$WEB_DIST" ] && [ -d "$WEB_DIST" ] && HAVE_WEB=1
DIRTY="$(cd "$REPO" && git status --porcelain -- engine web ops | wc -l | tr -d ' ')"

echo "target        $SSH_USER@$IP   instance $I_NAME ($I_MODE, API 127.0.0.1:$I_PORT)${DOMAIN:+   domain $DOMAIN}"
echo "admin key     $PUBKEY_FILE (becomes the only login: user deploy)"
echo "code          git archive of HEAD $(cd "$REPO" && git rev-parse --short HEAD) (engine/ web/ ops/, committed files only: no keys, no data) -> $I_REPO"
[ "$DIRTY" = 0 ] || echo "              WARNING: $DIRTY uncommitted change(s) under engine web ops are NOT shipped"
echo "site          ${WEB_DIST:-none given} -> $I_WEB $([ -z "$WEB_DIST" ] && echo "(skipped: build the site for $I_MODE and pass --web-dist)" || { [ "$HAVE_WEB" = 1 ] && echo "(found)" || echo "(MISSING: build it first, or the site is skipped)"; })"
echo "owns          user $I_USER, $I_ETC (engine.env, secrets.env, keys/), $I_DATA (and $I_PUBLIC for coin images and metadata, group caddy), $I_BACKUPS, units $I_NAME-api/-keeper/-backup/-health, /etc/logrotate.d/$I_NAME"
if [ "$I_NAME" = snarks ] || [ "$HOST_SETUP_FLAG" = 1 ]; then
  echo "host steps    packages, users, ssh hardening, ufw 22+80+443, unattended-upgrades, hidepid, journald, time sync, bun 1.3.9, Caddy, zcash-devtool build$([ $SKIP_DEVTOOL = 1 ] && echo " (skipped)")"
else
  echo "host steps    none (adding an instance leaves the host, the other instance and the running Caddyfile alone; it renders the Caddy variants for the live switch)"
fi
[ "$I_MODE" != mainnet ] || echo "mainnet       units installed paused and NOT enabled (only the backup timer is on); the launch is ops/MAINNET-RUNBOOK.md"
if [ "$APPLY" != 1 ]; then
  echo; echo "DRY RUN: nothing was uploaded or run. Add --apply to provision $IP."
  exit 0
fi

(cd "$REPO" && git archive --format=tar.gz -o "$CODE_TAR" HEAD engine web ops)
[ "$HAVE_WEB" = 1 ] && tar -C "$WEB_DIST" -czf "$WEB_TAR" .
REMOTE_TMP="/tmp/snarks-provision-$STAMP"
"${SSH[@]}" "mkdir -p $REMOTE_TMP"
scp -q -o BatchMode=yes "$CODE_TAR" "$SSH_USER@$IP:$REMOTE_TMP/code.tar.gz"
[ "$HAVE_WEB" = 1 ] && scp -q -o BatchMode=yes "$WEB_TAR" "$SSH_USER@$IP:$REMOTE_TMP/web.tar.gz"
scp -q -o BatchMode=yes "$REPO/ops/remote-setup.sh" "$SSH_USER@$IP:$REMOTE_TMP/remote-setup.sh"

# The repo's ops/ and templates must exist on the server before the script reads them: unpack the code first.
"${SSH[@]}" "$SUDO mkdir -p $I_REPO && $SUDO tar -xzf $REMOTE_TMP/code.tar.gz -C $I_REPO"
PUBKEY="$(cat "$PUBKEY_FILE")"
"${SSH[@]}" "$SUDO env INSTANCE=$I_NAME MODE=$I_MODE DOMAIN='$DOMAIN' TEST_HOSTS='$TEST_HOSTS' DEPLOY_PUBKEY='$PUBKEY' CODE_TARBALL=$REMOTE_TMP/code.tar.gz \
  $([ "$HAVE_WEB" = 1 ] && echo "WEB_TARBALL=$REMOTE_TMP/web.tar.gz") $([ "$HOST_SETUP_FLAG" = 1 ] && echo "HOST_SETUP=1") SKIP_DEVTOOL_BUILD=$SKIP_DEVTOOL bash $REMOTE_TMP/remote-setup.sh"
"${SSH[@]}" "$SUDO rm -rf $REMOTE_TMP"
echo; echo "Done. From now on connect as: ssh deploy@$IP   (root login is off). Next: ops/DEPLOY.md step 6."
