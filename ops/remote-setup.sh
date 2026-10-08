#!/usr/bin/env bash
# Runs ON the server as root (ops/provision.sh pipes it over SSH). Idempotent: every step checks before it changes
# anything, so it can be run again after a failure or to pick up new templates. Ubuntu 24.04 only.
# Inputs (environment):
#   INSTANCE            snarks (the devnet demo, default) or snarksm (the staged mainnet instance); see ops/instance.sh
#   MODE                optional; must equal the instance's own mode (snarks devnet, snarksm mainnet)
#   DEPLOY_PUBKEY       the public key text of the admin
#   HOST_SETUP          1 = also run the host-wide steps (packages, users, ssh, firewall, hidepid, journald, bun, Caddy, devtool).
#                       Default 1 for snarks, 0 for any other instance: adding an instance never touches the host.
#   DOMAIN, TEST_HOSTS  the live name and the space-separated test names, used only to write /etc/caddy/snarks-sites.env
#                       when it does not exist yet
#   SKIP_DEVTOOL_BUILD=1, CODE_TARBALL (the uploaded `git archive` of the repo), WEB_TARBALL (the built site)   optional
set -euo pipefail

: "${DEPLOY_PUBKEY:?DEPLOY_PUBKEY}"
INSTANCE="${INSTANCE:-snarks}"
case "$INSTANCE" in snarks | snarksm) ;; *) echo "unknown instance '$INSTANCE'" >&2; exit 1 ;; esac
LIB="/opt/$INSTANCE/repo/ops/instance.sh"
[ -f "$LIB" ] || { echo "no $LIB: provision.sh unpacks the code before it runs this script" >&2; exit 1; }
. "$LIB"
instance_load "$INSTANCE" "${MODE:-}"
MODE="$I_MODE"
HOST_SETUP="${HOST_SETUP:-$([ "$I_NAME" = snarks ] && echo 1 || echo 0)}"
TEMPLATES="$I_REPO/ops/templates"
BUN_VERSION="1.3.9"
BUN_SHA256_X64="4680e80e44e32aa718560ceae85d22ecfbf2efb8f3641782e35e4b7efd65a1aa"       # from the release's SHASUMS256.txt
BUN_SHA256_ARM64="a2c2862bcc1fd1c0b3a8dcdc8c7efb5e2acd871eb20ed2f17617884ede81c844"
RUST_VERSION="1.97.1"                                                                    # the toolchain the pinned devtool build was verified with
step() { printf '\n== %s\n' "$*"; }

install_rendered() { # <template> <mode> <owner> <group> <dest>: render for this instance, install atomically
  local tmp
  tmp="$(mktemp)"
  instance_render "$TEMPLATES/$1" > "$tmp"
  install -m "$2" -o "$3" -g "$4" "$tmp" "$5"
  rm -f "$tmp"
}

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = "24.04" ] || { echo "Ubuntu 24.04 only (this is ${PRETTY_NAME:-unknown})" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
echo "instance $I_NAME ($MODE), API port $I_PORT, host setup $HOST_SETUP"

if [ "$HOST_SETUP" = 1 ]; then
step "packages"
apt-get update -qq
apt-get install -y -qq ufw unattended-upgrades apt-listchanges curl ca-certificates gnupg jq sqlite3 age rsync unzip acl \
  git build-essential pkg-config libssl-dev protobuf-compiler logrotate debian-keyring debian-archive-keyring apt-transport-https

step "admin user and the shared binary directory"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$DEPLOY_PUBKEY" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys
# passwordless sudo only for the admin key holder: there is no password to type on a key-only account
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-deploy; chmod 440 /etc/sudoers.d/90-deploy
install -d -m 755 -o deploy -g deploy "$I_BIN"

step "ssh hardening (key-only, no root, AllowUsers deploy)"
# Safe order: the deploy key is installed above. Validate the config before reloading so a typo cannot lock us out.
if [ -f "$TEMPLATES/sshd-snarks.conf" ]; then
  install -m 644 "$TEMPLATES/sshd-snarks.conf" /etc/ssh/sshd_config.d/00-snarks.conf
  sshd -t && systemctl reload ssh
fi

step "firewall: only 22, 80 and 443"
ufw --force reset >/dev/null
ufw default deny incoming; ufw default allow outgoing
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
ufw --force enable
ufw status verbose

step "unattended upgrades (security updates, no automatic reboot)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52snarks-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

step "hide other users' processes (hidepid=2; the treasury address is on devtool's argv for seconds, audit O-5)"
getent group proc >/dev/null || groupadd proc
grep -q 'hidepid=2' /etc/fstab || echo 'proc /proc proc nosuid,nodev,noexec,hidepid=2,gid=proc 0 0' >> /etc/fstab
mkdir -p /etc/systemd/system/systemd-logind.service.d
printf '[Service]\nSupplementaryGroups=proc\n' > /etc/systemd/system/systemd-logind.service.d/hidepid.conf
mount -o remount,hidepid=2,gid=proc /proc || echo "remount failed; takes effect at the next reboot"

step "journald size limit"
install -d /etc/systemd/journald.conf.d
[ -f "$TEMPLATES/journald-snarks.conf" ] && install -m 644 "$TEMPLATES/journald-snarks.conf" /etc/systemd/journald.conf.d/snarks.conf
systemctl restart systemd-journald

step "time sync (the launch window's fee is read off this clock; ops/MAINNET-RUNBOOK.md gate G14)"
# Only warns when the first synchronisation takes longer than a minute: the health check fails every 5 minutes until the clock is right.
bash "$I_REPO/ops/timesync.sh" || echo "WARNING: the clock is not synchronised yet; check it with: ops/timesync.sh --check"

step "bun $BUN_VERSION (checksum from the release's SHASUMS256.txt)"
if ! "$I_BIN/bun" --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
  case "$(uname -m)" in x86_64) A=x64; SUM=$BUN_SHA256_X64;; aarch64) A=aarch64; SUM=$BUN_SHA256_ARM64;; *) echo "unsupported arch" >&2; exit 1;; esac
  T="$(mktemp -d)"
  curl -fsSL -o "$T/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$A.zip"
  echo "$SUM  $T/bun.zip" | sha256sum -c -
  unzip -q -o "$T/bun.zip" -d "$T"
  install -m 755 "$T"/bun-linux-*/bun "$I_BIN/bun"
  rm -rf "$T"
fi
"$I_BIN/bun" --version
else
  # Adding an instance leaves the host alone, but it needs what the host setup made.
  id deploy >/dev/null 2>&1 || { echo "no deploy user: the host setup has not run. Provision the snarks instance first." >&2; exit 1; }
  [ -x "$I_BIN/bun" ] || { echo "no $I_BIN/bun: the host setup has not run. Provision the snarks instance first." >&2; exit 1; }
fi

step "service user and directories for $I_NAME"
id "$I_USER" >/dev/null 2>&1 || adduser --system --group --home "$I_DATA" --shell /usr/sbin/nologin "$I_USER"
install -d -m 750 -o root -g "$I_USER" "$I_ETC"
install -d -m 700 -o "$I_USER" -g "$I_USER" "$I_KEYS"
install -d -m 770 -o "$I_USER" -g "$I_USER" "$I_DATA" "$I_DATA/data" "$I_BACKUPS"
install -d -m 700 -o "$I_USER" -g "$I_USER" "$I_DATA/zcash" "$I_DATA/apikeys"
install -d -m 755 -o deploy -g deploy "$I_OPT" "$I_REPO" "$I_WEB"

step "public files for $I_NAME ($I_PUBLIC: coin images and metadata JSON, written by the API, served by Caddy)"
# Caddy reaches them through the data directory (770, the instance's own) by one ACL entry for its user, which gives it no other access there.
# The directories belong to the instance's user, group caddy, setgid (what the API creates inside inherits the group), 0750; files 0640.
command -v setfacl >/dev/null || apt-get install -y -qq acl
getent group caddy >/dev/null || groupadd --system caddy # Caddy's package makes it; a new host gets it here, before Caddy is installed
install -d -m 750 -o "$I_USER" -g caddy "$I_PUBLIC" "$I_PUBLIC/i" "$I_PUBLIC/m"
chgrp -R caddy "$I_PUBLIC" # a re-run repairs files an earlier run left in another group
find "$I_PUBLIC" -type d -exec chmod 2750 {} +
find "$I_PUBLIC" -type f -exec chmod 0640 {} +
setfacl -m u:caddy:--x "$I_DATA"

step "code ($I_REPO: git archive of the repo, uploaded by provision.sh)"
if [ -n "${CODE_TARBALL:-}" ] && [ -f "$CODE_TARBALL" ]; then
  tar -xzf "$CODE_TARBALL" -C "$I_REPO"
  chown -Rh deploy:deploy "$I_REPO"
  ln -sfn "$I_DATA/data" "$I_REPO/engine/data"
  ln -sfn "$I_DATA/apikeys" "$I_REPO/engine/keys"   # only the devnet faucet key lives here; real keys are in $I_KEYS
  (cd "$I_REPO/engine" && sudo -u deploy "$I_BIN/bun" install --frozen-lockfile)
else
  echo "no CODE_TARBALL given; assuming $I_REPO is already in place"
fi
[ -d "$TEMPLATES" ] || { echo "no $TEMPLATES: upload the code first" >&2; exit 1; }

step "static site ($I_WEB)"
if [ -n "${WEB_TARBALL:-}" ] && [ -f "$WEB_TARBALL" ]; then
  rm -rf "${I_WEB:?}"/*; tar -xzf "$WEB_TARBALL" -C "$I_WEB"; chown -R deploy:deploy "$I_WEB"
fi

if [ "$HOST_SETUP" = 1 ]; then
step "caddy (official apt repo)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq; apt-get install -y -qq caddy
fi
# The names Caddy serves live in /etc/caddy/snarks-sites.env (ops/caddy-render.sh); a first run writes it from DOMAIN.
if [ ! -f /etc/caddy/snarks-sites.env ]; then
  [ -n "${DOMAIN:-}" ] || { echo "no /etc/caddy/snarks-sites.env and no DOMAIN given" >&2; exit 1; }
  test_args=(); for h in ${TEST_HOSTS:-}; do test_args+=(--test "$h"); done
  "$I_REPO/ops/caddy-render.sh" --init --live "$DOMAIN" "${test_args[@]}" --variants-only
elif [ -n "${DOMAIN:-}" ] && ! grep -qwF -- "$DOMAIN" /etc/caddy/snarks-sites.env; then
  echo "note: $DOMAIN is not in /etc/caddy/snarks-sites.env; that file decides the names (edit it, then ops/caddy-render.sh --reload)"
fi
"$I_REPO/ops/caddy-render.sh"
install -d -o caddy -g caddy /var/log/caddy; chown -R caddy:caddy /var/log/caddy
systemctl enable caddy; systemctl reload caddy || systemctl restart caddy

step "zcash-devtool built from source at the pinned commit (scripts/build-devtool.sh), checksum recorded"
if [ "${SKIP_DEVTOOL_BUILD:-0}" != 1 ] && [ ! -x "$I_BIN/zcash-devtool" ]; then
  sudo -u deploy bash -c "command -v cargo >/dev/null || (curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $RUST_VERSION)"
  sudo -u deploy bash -c ". \$HOME/.cargo/env && bash $I_REPO/engine/scripts/build-devtool.sh $I_BIN"
  chmod 755 "$I_BIN/zcash-devtool"
fi
elif [ -f /etc/caddy/snarks-sites.env ] && command -v caddy >/dev/null; then
  step "caddy: render both variants for the live switch (the running Caddyfile is not touched)"
  "$I_REPO/ops/caddy-render.sh" --variants-only
fi
[ -f "$I_BIN/zcash-devtool.sha256" ] && echo "pin this in $I_ETC/engine.env: ZCASH_DEVTOOL_SHA256=$(cut -d' ' -f1 "$I_BIN/zcash-devtool.sha256")"

step "systemd units, timers, logrotate for $I_NAME"
for u in api.service keeper.service backup.service backup.timer health.service health.timer; do
  install_rendered "$u" 644 root root "/etc/systemd/system/$I_NAME-$u"
done
install_rendered logrotate 644 root root "/etc/logrotate.d/$I_NAME"
chmod +x "$I_REPO"/ops/*.sh
if [ ! -f "$I_ETC/engine.env" ]; then
  install_rendered "engine.env.$MODE.example" 640 root "$I_USER" "$I_ETC/engine.env"
  # A new mainnet instance starts paused. Only here, at first creation: a later run must never re-pause a live instance.
  [ "$MODE" != mainnet ] || install -m 660 -o "$I_USER" -g "$I_USER" /dev/null "$I_DATA/data/PAUSED"
fi
# Where the public files are and the address they are served from. Filled when missing or empty and never overwritten: the live switch
# (ops/switch-live.sh) is what moves PUBLIC_BASE_URL later, with the names. The address comes from the sites file, so Caddy and the engine agree.
instance_fill_env "$I_ETC/engine.env" PUBLIC_DIR "$I_PUBLIC"
if public_url="$(instance_public_url "$I_NAME")"; then
  instance_fill_env "$I_ETC/engine.env" PUBLIC_BASE_URL "$public_url"
else
  echo "no /etc/caddy/snarks-sites.env yet: set PUBLIC_BASE_URL in $I_ETC/engine.env to the address the site is served from (https://...)"
fi
[ -f "$I_ETC/secrets.env" ] || install_rendered "secrets.env.$MODE.example" 600 root root "$I_ETC/secrets.env"
systemctl daemon-reload

step "start (only when the settings and keys are filled in)"
if [ "$MODE" = mainnet ]; then
  # Nothing of the mainnet instance runs until the owner launches (ops/MAINNET-RUNBOOK.md): the units are installed, not enabled,
  # so a reboot cannot start the keeper either. Only the nightly backup timer is on.
  systemctl enable --now "$I_NAME-backup.timer" >/dev/null
  echo "$I_NAME: units installed, API, keeper and health timer NOT enabled or started; backup timer on."
else
  systemctl enable "$I_NAME-api.service" "$I_NAME-keeper.service" "$I_NAME-backup.timer" "$I_NAME-health.timer" >/dev/null
  missing=()
  keeper_key="$(grep -E '^KEEPER_KEYPAIR_PATH=' "$I_ETC/engine.env" | cut -d= -f2 || true)"
  [ -s "$I_KEYS/keeper-$MODE.json" ] || [ -s "$keeper_key" ] || missing+=("keeper keypair")
  grep -qE '^TREASURY_ZCASH_ADDRESS=.+' "$I_ETC/engine.env" || missing+=("TREASURY_ZCASH_ADDRESS")
  grep -qE '^(HELIUS_API_KEY|SOLANA_DEVNET_RPC)=.+' "$I_ETC/secrets.env" || missing+=("HELIUS_API_KEY or SOLANA_DEVNET_RPC in secrets.env")
  if [ "${#missing[@]}" -eq 0 ]; then
    systemctl restart "$I_NAME-api" "$I_NAME-keeper"; systemctl start "$I_NAME-backup.timer" "$I_NAME-health.timer"
  else
    echo "NOT started; still missing: ${missing[*]}. Fill them in (ops/DEPLOY.md step 6), then: systemctl restart $I_NAME-api $I_NAME-keeper"
  fi
fi
echo; echo "setup finished"
